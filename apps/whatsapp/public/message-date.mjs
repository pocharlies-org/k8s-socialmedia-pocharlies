export function localDayRange(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Elige una fecha v\u00e1lida.');
  const [year, month, day] = value.split('-').map(Number);
  const start = new Date(year, month - 1, day);
  if (start.getFullYear() !== year || start.getMonth() !== month - 1 || start.getDate() !== day) throw new Error('Elige una fecha v\u00e1lida.');
  // Calendar arithmetic preserves 23/25-hour days across clock changes.
  const end = new Date(year, month - 1, day + 1);
  return {start: start.toISOString(), end: end.toISOString()};
}

export function validateDayRange(start, end) {
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  if (![start, end].every(value => typeof value === 'string' && iso.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value)) throw new Error('Invalid date range');
  const duration = Date.parse(end) - Date.parse(start);
  if (duration < 22 * 3600000 || duration > 26 * 3600000) throw new Error('Invalid date range');
  return {start, end};
}
