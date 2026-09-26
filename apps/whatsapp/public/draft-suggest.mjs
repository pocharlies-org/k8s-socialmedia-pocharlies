/* El compositor muestra una etiqueta corta en el hilo; Hermes recibe la instrucción completa. */
export const DRAFT_LABEL = 'Propón un mensaje para responder';

export const DRAFT_INSTRUCTION = 'Propón un mensaje para responder a esta conversación. Responde solo con el texto del mensaje, sin explicaciones ni comillas.';

const FENCE = /^\s*```[^\n]*\n([\s\S]*?)\n```\s*$/;
const QUOTED = [/^"([\s\S]*)"$/, /^“([\s\S]*)”$/, /^«([\s\S]*)»$/, /^'([\s\S]*)'$/];

/* Acepta el texto crudo de Hermes y deja solo el mensaje, sin comillas envolventes ni vallas de código. */
export function normalizeDraftText(value) {
  if (typeof value !== 'string') return '';
  let text = value.replace(/\r\n/g, '\n').trim();
  const fenced = text.match(FENCE);
  if (fenced) text = fenced[1].trim();
  for (const pattern of QUOTED) {
    if (pattern.test(text)) {
      text = text.replace(pattern, '$1').trim();
      break;
    }
  }
  return text.split('\n').map(line => line.replace(/[ \t]+$/, '')).join('\n').trim();
}
