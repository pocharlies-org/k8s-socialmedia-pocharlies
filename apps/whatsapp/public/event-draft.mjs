const localPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

export function localEventTime(value) {
  const parts = typeof value === 'string' && value.match(localPattern);
  const date = parts ? new Date(value) : new Date(NaN);
  if (!parts || !Number.isFinite(date.getTime()) ||
      [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()]
        .some((part, index) => part !== Number(parts[index + 1] || 0))) {
    throw new Error('La fecha y hora no son v\u00e1lidas en tu zona horaria.');
  }
  return date.toISOString();
}

function instant(value) {
  if (typeof value !== 'string' || !instantPattern.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error('La fecha debe incluir una zona horaria.');
  }
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() + 1 !== month || calendar.getUTCDate() !== day || Number(value.slice(11, 13)) > 23) {
    throw new Error('La fecha no es v\u00e1lida.');
  }
  return new Date(value).toISOString();
}

export function eventDraft({title, description = '', dateTime, endDateTime = '', location = ''} = {}) {
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 2000) throw new Error('Escribe el nombre del evento.');
  if (typeof description !== 'string' || description.length > 2048) throw new Error('La descripci\u00f3n no puede superar 2048 caracteres.');
  if (typeof location !== 'string' || location.length > 2000) throw new Error('La ubicaci\u00f3n no es v\u00e1lida.');
  const start = instant(dateTime);
  const end = endDateTime ? instant(endDateTime) : '';
  if (end && Date.parse(end) < Date.parse(start)) throw new Error('El evento no puede terminar antes de empezar.');
  return {title: title.trim(), description: description.trim(), dateTime: start, endDateTime: end, location: location.trim()};
}
