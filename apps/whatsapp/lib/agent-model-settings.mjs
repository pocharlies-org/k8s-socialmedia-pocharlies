import {fail} from './security.mjs';

// Verified against Hermes' reasoning parser and OpenAI-compatible custom-provider route.
// Providers can clamp these requests; the inventory does not advertise per-model effort limits.
const EFFORT_LABELS = {default: 'Predeterminado', none: 'Desactivado', minimal: 'Minimo', low: 'Bajo', medium: 'Medio', high: 'Alto', xhigh: 'Muy alto', max: 'Maximo'};
export const REASONING_EFFORTS = Object.keys(EFFORT_LABELS);

export function defaultModelSettings(env) {
  return {model: env.HERMES_DEFAULT_MODEL || env.APP_AI_DEFAULT_MODEL || '', reasoningEffort: 'default'};
}

export function sessionModelSettings(session, env) {
  return {...defaultModelSettings(env), ...session?.modelSettings};
}

export function hermesModelOptions(reasoningEffort = 'default') {
  if (!REASONING_EFFORTS.includes(reasoningEffort)) throw fail(400, 'Invalid reasoning effort');
  if (reasoningEffort === 'default') return {};
  return {reasoning: reasoningEffort === 'none' ? {enabled: false} : {enabled: true, effort: reasoningEffort}};
}

export function modelCatalog(payload, provider) {
  // Never expose another configured credential route through this chat selector.
  if (!provider) throw fail(503, 'Hermes model selection requires a configured provider');
  const row = payload?.providers?.find(item => item.authenticated === true
    && (item.slug === provider || item.aliases?.includes(provider)));
  if (!row || !Array.isArray(row.models)) throw fail(502, 'Hermes has not confirmed the configured provider model catalog');
  const ids = [...new Set(row.models.filter(id => typeof id === 'string' && id.length > 0 && id.length <= 200))];
  if (!ids.length) throw fail(502, 'Hermes returned an empty model catalog');
  return ids.map(id => ({id, label: id, reasoningEfforts: (row.capabilities?.[id]?.reasoning === true ? REASONING_EFFORTS : ['default'])
    .map(value => ({value, label: EFFORT_LABELS[value]}))}));
}

export function validateModelSettings(body, models) {
  const model = models.find(item => item.id === body.model);
  if (!model) throw fail(400, 'Model is not available from the configured Hermes provider');
  if (!model.reasoningEfforts.some(item => item.value === body.reasoningEffort)) throw fail(400, 'Invalid reasoning effort for this model');
  return {model: model.id, reasoningEffort: body.reasoningEffort};
}
