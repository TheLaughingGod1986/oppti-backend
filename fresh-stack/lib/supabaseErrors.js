function serializeSupabaseError(error) {
  if (!error) {
    return null;
  }

  return {
    code: error.code || null,
    message: error.message || null,
    details: error.details || null,
    hint: error.hint || null
  };
}

function isMissingSchemaError(error) {
  if (!error) return false;

  const code = error.code || '';
  const message = `${error.message || ''} ${error.details || ''} ${error.hint || ''}`;

  return [
    '42P01',
    '42703',
    '42883',
    'PGRST202',
    'PGRST205'
  ].includes(code) || /does not exist|not exist|undefined function|could not find (?:the )?(?:function|table)|schema cache/i.test(message);
}

module.exports = {
  isMissingSchemaError,
  serializeSupabaseError
};
