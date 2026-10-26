/**
 * Minimal in-memory Supabase stand-in for read paths: from(table) gives a
 * chain whose eq/in filters apply to the given rows. Awaiting the chain yields
 * { data: rows }, maybeSingle()/single() the first row. Writes are no-ops.
 */
function createTableMock(tables = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      const filters = [];
      const rows = () => (tables[table] || []).filter((row) => filters.every((filter) => filter(row)));
      const chain = {
        select() { return chain; },
        insert() { return chain; },
        upsert() { return chain; },
        update() { return chain; },
        order() { return chain; },
        limit() { return chain; },
        eq(column, value) {
          calls.push({ table, op: 'eq', column, value });
          filters.push((row) => row?.[column] === value);
          return chain;
        },
        in(column, values) {
          calls.push({ table, op: 'in', column, values });
          filters.push((row) => values.includes(row?.[column]));
          return chain;
        },
        maybeSingle() { return Promise.resolve({ data: rows()[0] || null, error: null }); },
        single() { return Promise.resolve({ data: rows()[0] || null, error: null }); },
        then(resolve, reject) { return Promise.resolve({ data: rows(), error: null }).then(resolve, reject); }
      };
      return chain;
    }
  };
}

module.exports = { createTableMock };
