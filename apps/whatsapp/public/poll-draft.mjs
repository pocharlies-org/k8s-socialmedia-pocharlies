export function pollDraft({question, options, selectableCount} = {}) {
  const name = typeof question === 'string' ? question.trim() : '';
  if (!name || name.length > 255) throw new Error('La pregunta debe tener entre 1 y 255 caracteres.');
  if (!Array.isArray(options) || options.length < 2 || options.length > 12) throw new Error('A\u00f1ade entre 2 y 12 opciones.');
  const values = options.map(value => typeof value === 'string' ? value.trim() : '');
  if (values.some(value => !value || value.length > 100)) throw new Error('Cada opci\u00f3n debe tener entre 1 y 100 caracteres.');
  if (new Set(values).size !== values.length) throw new Error('Las opciones no pueden estar repetidas.');
  const count = selectableCount === undefined ? values.length : selectableCount;
  if (!Number.isInteger(count) || count < 1 || count > values.length) throw new Error('El n\u00famero de respuestas permitidas no es v\u00e1lido.');
  return {question: name, options: values, selectableCount: count};
}
