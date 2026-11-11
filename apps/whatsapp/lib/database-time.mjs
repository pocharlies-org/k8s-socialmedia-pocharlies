import pg from 'pg';

// The connectors store UTC in timestamp-without-time-zone columns. Decoding
// those as the app container's local time shifts every message before the UI.
export function utcDatabaseTypes(types = pg.types) {
  const parseZoned = types.getTypeParser(1184, 'text');
  const parseUtc = value => parseZoned(
    /^-?infinity$/i.test(value) ? value : value.replace(/( BC)?$/, '+00$1')
  );
  return {
    getTypeParser(oid, format = 'text') {
      return Number(oid) === 1114 && format === 'text' ? parseUtc : types.getTypeParser(oid, format);
    },
  };
}
