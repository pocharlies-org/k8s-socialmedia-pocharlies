// Keep resumed Hermes sessions on the model and provider the deployment selects.
//
// Hermes resolves a turn's model with this precedence (installed api_server.py `_select_agent_runtime`,
// Hermes Agent v0.21.3): confirmed Browser lock > session `/model` override > session-persisted model >
// model_routes alias > per-request provider/model > global defaults. Once a Hermes session stored a
// model, the `model` in the request body is ignored, so changing HERMES_DEFAULT_MODEL would otherwise
// keep every existing conversation on the previous model forever.
//
// Live probe of the running gateway (2026-09-26) against profile `socialmedia`:
//   POST /api/sessions/{id}/model {"model":"gpt-6-luna","provider":"openclaw-litellm"}
//     -> 200 {"object":"hermes.session.model_lock","runtime":{"provider":"openclaw-litellm",
//             "model":"gpt-6-luna","requested":{...},"model_lock":"accepted"}}
//   GET  /api/sessions/{id}            -> session.model="gpt-6-luna", has_model_config=true
//   POST /api/sessions/unknown/model   -> 404 {"error":{"code":"session_not_found",...}} (JSON)
//   POST /api/sessions/{id}/unknown    -> 404 "Unknown or unconfigured profile" (plain text, no JSON)
//   POST /api/sessions/{id}/model {}   -> 400 {"error":{"code":"missing_model",...}}
// and GET /v1/capabilities advertises features.session_model_lock=true.
//
// Only a 200 whose echoed runtime matches the requested pair counts as confirmed. "accepted" alone is
// not proof the provider resolves, so it is never claimed on a non-OK or mismatched answer, and an
// unconfirmed session keeps its previous marker so a later turn retries.

const LOCK_PATH = '/model';

export function hermesApiBaseUrl(apiUrl) {
  return String(apiUrl || '').replace(/\/v1\/?$/, '').replace(/\/+$/, '');
}

function modelLockPath(apiUrl, hermesId) {
  return `${hermesApiBaseUrl(apiUrl)}/api/sessions/${encodeURIComponent(hermesId)}${LOCK_PATH}`;
}

function sameTarget(record, target) {
  return Boolean(record) && record.model === target.model && (record.provider || '') === (target.provider || '');
}

// A turn may only skip the lock when this app already CONFIRMED the exact configured pair for that Hermes
// session. Anything else locks again: no record (a session that predates this helper may still be pinned
// to the previous model), a different model or provider, or a non-confirmed outcome. `force` re-checks the
// gateway on every resumed turn, which also detects a model switched outside this app.
export function modelLockAction(session, target, { force = false } = {}) {
  if (!session?.hermesId) return 'none';
  if (!target.model) return 'none';
  const record = session.hermesModelLock;
  if (!force && record?.state === 'confirmed' && sameTarget(record, target)) return 'none';
  return 'lock';
}

async function readJson(response) {
  try { return await response.json(); } catch { return null; }
}

async function discard(response) {
  try { await response.body?.cancel(); } catch { /* already consumed */ }
}

// Returns 'none' | 'confirmed' | 'unavailable' | 'missing' | 'failed'. Only 'confirmed' records the pair as
// applied, and the caller must not run the turn after 'failed' because continuing would silently answer
// from the previous model. 'unavailable' and 'missing' stay unconfirmed so a later turn retries.
export async function syncHermesModelLock({ remote, apiUrl, apiKey, session, model, provider, force = false, log = () => {} }) {
  const target = { model: typeof model === 'string' ? model : '', provider: typeof provider === 'string' ? provider : '' };
  const action = modelLockAction(session, target, { force });
  if (action === 'none') return 'none';
  let response;
  try {
    response = await remote(modelLockPath(apiUrl, session.hermesId), {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: target.model, ...(target.provider ? { provider: target.provider } : {}) }),
    }, 10000, [400, 404, 405, 422, 501]);
  } catch (error) {
    log(`Hermes session model lock request failed: ${error?.message || 'unknown error'}`);
    return 'failed';
  }
  const payload = await readJson(response);
  if (response.status === 200) {
    const runtime = payload?.runtime;
    const confirmed = payload?.object === 'hermes.session.model_lock'
      && runtime?.model === target.model && (!target.provider || runtime?.provider === target.provider);
    if (confirmed) {
      session.hermesModelLock = { ...target, state: 'confirmed', at: Date.now() };
      return 'confirmed';
    }
    log(`Hermes model lock response did not confirm the requested model for session ${session.hermesId}`);
    await discard(response);
    return 'failed';
  }
  const code = payload?.error?.code;
  if (response.status === 404 && code === 'session_not_found') {
    // The Hermes session behind this app session no longer exists: keep the transcript usable, but do
    // not claim any model for it.
    session.hermesModelLock = { ...target, state: 'missing', at: Date.now() };
    log(`Hermes session ${session.hermesId} is gone; its model could not be pinned`);
    return 'missing';
  }
  if ([404, 405, 501].includes(response.status) && !payload) {
    // A gateway without the route may answer a plain-text profile-level 404. Keep the pair
    // unconfirmed so the caller stops this turn and can retry after the gateway is upgraded.
    session.hermesModelLock = { ...target, state: 'unavailable', at: Date.now() };
    log(`Hermes gateway does not expose the session model lock route (HTTP ${response.status})`);
    return 'unavailable';
  }
  log(`Hermes rejected the session model lock (HTTP ${response.status}${code ? ` ${code}` : ''})`);
  return 'failed';
}
