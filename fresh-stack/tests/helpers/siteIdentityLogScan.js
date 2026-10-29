// Static scan for site identity values in log calls.
//
// A site key, a stored site_hash, an install id/hash/uuid and a site
// fingerprint all resolve a site in auth, so no log line may carry their
// values. This walks every logger.* / console.* call (and the log helpers and
// *Trace / *LogData / logContext / auditContext objects that only feed log
// lines) and reports:
//   - a property named like a site key, site hash, install id or fingerprint
//     whose value is not a presence flag or a lib/logIdentity helper, and
//   - any value that reads a site identity variable, header or field, unless
//     it is wrapped in Boolean(), !!, a logIdentity helper, or only decides a
//     branch (a test in ?: / if, or a comparison).
const fs = require('fs');
const path = require('path');
const { parse } = require('@babel/parser');
const traverse = require('@babel/traverse').default;

const KEY_NAME = /^(site_?hash|site_?key|request_site_hash|trial_?site_?hash|raw_?site_?key|effective_?site_?hash|site_?hashes|x-site-key|x-site-hash|x-install-hash|x-install-uuid|x-site-fingerprint|wp_?install_?uuid|install_?uuid|install_?hash|install_?id|site_?install_?id|site_?fingerprint)$/i;
const VALUE_NAME = /^(site_?hash|site_?key|raw_?site_?key|trial_?site_?hash|effective_?site_?hash|wp_?install_?uuid|install_?uuid|install_?hash|install_?id|site_?fingerprint|synthetic_?site_?hash)$/i;
const HEADER_NAME = /^x-(site-key|site-hash|trial-site-hash|install-hash|install-uuid|site-fingerprint|site-id|telemetry-install-id)$/i;
const SAFE_CALL = /^(Boolean|siteRefForLog|installRefForLog|fingerprintRefForLog|maskSecret|isValidUUID)$/;
const LOGGER_OBJECT = /^(logger|resetLogger|billingLogger|console)$/;
const LOG_WRAPPER = /^(logCreditsAudit|logV2Fallback|logCheckoutOutcome|emitAuthWriteTrace)$/;
const LOG_VAR = /(Trace|^trace|LogData|logData|logContext|LogContext|auditContext)$/;
const PASS = new Set(['ObjectExpression', 'ObjectProperty', 'ArrayExpression', 'ConditionalExpression', 'LogicalExpression', 'SpreadElement', 'TemplateLiteral', 'BinaryExpression']);

function listSourceFiles(root, { exclude = [] } = {}) {
  const out = [];
  (function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (/^(node_modules|tests?|__tests__|scripts|coverage)$/.test(name)) continue;
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (name.endsWith('.js')) out.push(full);
    }
  })(root);
  return out.filter((file) => !exclude.some((rel) => file.endsWith(rel)));
}

function calleeIsLog(callee) {
  if (!callee) return false;
  if (callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') {
    return callee.object.type === 'Identifier' && LOGGER_OBJECT.test(callee.object.name);
  }
  return callee.type === 'Identifier' && LOG_WRAPPER.test(callee.name);
}

function inLogFunction(p) {
  for (let c = p; c; c = c.parentPath) {
    const n = c.node;
    if (n.type === 'FunctionDeclaration' && n.id && /^log[A-Z]/.test(n.id.name)) return true;
  }
  return false;
}

// Names of variables whose value reaches a log call in the file being
// scanned: passed to a log call, spread into a logged object, or assigned
// or spread into such a variable (fixpoint). Set per file by scanFile.
let loggedNames = new Set();
const isLoggedName = (name) => LOG_VAR.test(name) || loggedNames.has(name);

function collectLoggedNames(ast) {
  const names = new Set();
  const addFrom = (node) => {
    if (!node) return;
    if (node.type === 'Identifier') names.add(node.name);
    else if (node.type === 'ObjectExpression') {
      for (const prop of node.properties) {
        if (prop.type === 'SpreadElement' && prop.argument.type === 'Identifier') names.add(prop.argument.name);
      }
    } else if (node.type === 'LogicalExpression' || node.type === 'ConditionalExpression') {
      addFrom(node.left || node.consequent); addFrom(node.right || node.alternate);
    }
  };
  traverse(ast, {
    'CallExpression|OptionalCallExpression'(p) {
      if (calleeIsLog(p.node.callee)) p.node.arguments.forEach(addFrom);
    }
  });
  const flows = [];
  traverse(ast, {
    VariableDeclarator(p) {
      if (p.node.id.type === 'Identifier' && p.node.init) flows.push([p.node.id.name, p.node.init]);
    },
    AssignmentExpression(p) {
      if (p.node.left.type === 'Identifier') flows.push([p.node.left.name, p.node.right]);
    }
  });
  for (let size = -1; size !== names.size;) {
    size = names.size;
    for (const [name, value] of flows) {
      if (names.has(name) || LOG_VAR.test(name)) addFrom(value);
    }
  }
  return names;
}

// Is this node part of a value that ends up in a log call?
function logSink(p) {
  let cur = p;
  while (cur.parentPath && PASS.has(cur.parentPath.node.type)) {
    const parent = cur.parentPath.node;
    // The test of ?: only picks a branch, and a comparison yields a boolean.
    if (parent.type === 'ConditionalExpression' && parent.test === cur.node) return null;
    if (parent.type === 'BinaryExpression' && /^(===|!==|==|!=|<|>|<=|>=|instanceof|in)$/.test(parent.operator)) return null;
    cur = cur.parentPath;
  }
  const parent = cur.parentPath && cur.parentPath.node;
  if (!parent) return null;
  if ((parent.type === 'CallExpression' || parent.type === 'OptionalCallExpression') && parent.callee !== cur.node) {
    if (calleeIsLog(parent.callee)) return 'log call';
    if (parent.callee.type === 'Identifier' && /^build[A-Za-z]*AuditPayload$/.test(parent.callee.name)
      && cur.parentPath.parentPath && calleeIsLog(cur.parentPath.parentPath.node.callee)) return 'log call';
    return null;
  }
  if (parent.type === 'VariableDeclarator' && parent.init === cur.node && parent.id.type === 'Identifier') {
    if (isLoggedName(parent.id.name)) return `var ${parent.id.name}`;
    if (/^(payload|entry)$/.test(parent.id.name) && inLogFunction(cur)) return `var ${parent.id.name}`;
  }
  if (parent.type === 'AssignmentExpression' && parent.right === cur.node) {
    const left = parent.left;
    if (left.type === 'MemberExpression' && left.object.type === 'Identifier' && isLoggedName(left.object.name)) return `assign ${left.object.name}`;
    // Whole-object reassignment: trace = { ...trace, site_hash }.
    if (left.type === 'Identifier' && isLoggedName(left.name)) return `assign ${left.name}`;
  }
  return null;
}

function readsSiteIdentity(node) {
  if (!node) return false;
  if (node.type === 'Identifier') return VALUE_NAME.test(node.name);
  if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') {
    if (!node.computed && node.property.type === 'Identifier') return VALUE_NAME.test(node.property.name);
    if (node.computed && node.property.type === 'StringLiteral') return VALUE_NAME.test(node.property.value);
    return false;
  }
  if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
    const c = node.callee;
    const name = c.type === 'MemberExpression' || c.type === 'OptionalMemberExpression' ? (c.property.name || '') : '';
    if (/^(header|get)$/.test(name) && node.arguments[0] && node.arguments[0].type === 'StringLiteral') {
      return HEADER_NAME.test(node.arguments[0].value);
    }
  }
  return false;
}

function wrappedSafely(p) {
  for (let c = p.parentPath; c; c = c.parentPath) {
    const n = c.node;
    if ((n.type === 'CallExpression' || n.type === 'OptionalCallExpression')) {
      if (calleeIsLog(n.callee)) return false;
      const name = n.callee.type === 'Identifier' ? n.callee.name
        : (n.callee.property && n.callee.property.name) || '';
      if (SAFE_CALL.test(name)) return true;
      return false;
    }
    if (n.type === 'UnaryExpression' && n.operator === '!') return true;
    if (n.type === 'MemberExpression' && n.property && n.property.name === 'length') return true;
    if (/Function|Statement|Declaration$/.test(n.type) && n.type !== 'VariableDeclaration') return false;
  }
  return false;
}

function scanFile(file, root) {
  const code = fs.readFileSync(file, 'utf8');
  const ast = parse(code, { sourceType: 'unambiguous', plugins: ['optionalChaining', 'objectRestSpread'], errorRecovery: true });
  const rel = path.relative(root, file);
  const hits = [];
  const seen = new Set();
  loggedNames = collectLoggedNames(ast);
  const add = (node, what) => {
    const key = `${node.loc.start.line}:${node.start}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push(`${rel}:${node.loc.start.line} ${what}`);
  };
  traverse(ast, {
    ObjectProperty(p) {
      const n = p.node;
      if (n.computed || p.parentPath.node.type !== 'ObjectExpression') return;
      const k = n.key.type === 'Identifier' ? n.key.name : n.key.value;
      if (typeof k !== 'string' || !KEY_NAME.test(k)) return;
      if (!logSink(p.parentPath)) return;
      const v = code.slice(n.value.start, n.value.end).trim();
      if (/^(Boolean\(|!!|null$|undefined$|true$|false$|'(present|absent|missing)'$)/.test(v)) return;
      if (/\?\s*'present'\s*:\s*'(absent|missing)'\s*$/.test(v)) return;
      add(n, `property ${k}: ${v.slice(0, 80)}`);
    },
    'Identifier|MemberExpression|OptionalMemberExpression|CallExpression|OptionalCallExpression'(p) {
      if (!readsSiteIdentity(p.node)) return;
      // Only the outermost read (siteIdentity.siteHash, not siteIdentity).
      if (p.parentPath && (p.parentPath.node.type === 'MemberExpression' || p.parentPath.node.type === 'OptionalMemberExpression') && p.parentPath.node.object === p.node) return;
      if (p.parentPath && p.parentPath.node.type === 'ObjectProperty' && p.parentPath.node.key === p.node) return;
      if (p.parentPath && (p.parentPath.node.type === 'MemberExpression' || p.parentPath.node.type === 'OptionalMemberExpression') && p.parentPath.node.property === p.node) return;
      if (wrappedSafely(p)) return;
      if (!logSink(p)) return;
      add(p.node, `value ${code.slice(p.node.start, p.node.end).slice(0, 80)}`);
    }
  });
  return hits;
}

function scanSiteIdentityLogs(root, options = {}) {
  return listSourceFiles(root, options).flatMap((file) => scanFile(file, path.dirname(root)));
}

module.exports = { scanSiteIdentityLogs, scanFile, listSourceFiles };
