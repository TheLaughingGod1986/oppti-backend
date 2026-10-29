/**
 * In-memory usage_logs / generation_requests tables with the filters the
 * guest-trial link uses (eq, is, in, lte, limit) on select and update.
 * Awaiting a chain yields { data: rows }. Every update is recorded.
 */
function createGuestRowsTables({ usageLogs = [], generationRequests = [] } = {}) {
  const tables = {
    usage_logs: usageLogs.map((row) => ({ ...row })),
    generation_requests: generationRequests.map((row) => ({ ...row }))
  };
  const updates = [];

  function chainFor(table, mode, payload) {
    const filters = [];
    let max = null;
    const matching = () => {
      const rows = tables[table].filter((row) => filters.every((filter) => filter(row)));
      return max === null ? rows : rows.slice(0, max);
    };
    const run = () => {
      const rows = matching();
      if (mode === 'update') {
        rows.forEach((row) => Object.assign(row, payload));
        updates.push({ table, payload, ids: rows.map((row) => row.id) });
      }
      return { data: rows.map((row) => ({ id: row.id })), error: null };
    };
    const chain = {
      select() { return chain; },
      eq(column, value) { filters.push((row) => row[column] === value); return chain; },
      is(column, value) { filters.push((row) => (value === null ? row[column] == null : row[column] === value)); return chain; },
      in(column, values) { filters.push((row) => values.includes(row[column])); return chain; },
      lte(column, value) { filters.push((row) => String(row[column]) <= String(value)); return chain; },
      limit(count) { max = count; return chain; },
      then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject); }
    };
    return chain;
  }

  return {
    tables,
    updates,
    handles(table) { return table === 'usage_logs' || table === 'generation_requests'; },
    from(table) {
      return {
        select() { return chainFor(table, 'select'); },
        update(payload) { return chainFor(table, 'update', payload); }
      };
    }
  };
}

module.exports = { createGuestRowsTables };
