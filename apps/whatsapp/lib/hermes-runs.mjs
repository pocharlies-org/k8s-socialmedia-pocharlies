import {SseDecoder, CapabilityRedactor, HermesStreamAccumulator} from './hermes-stream.mjs';
import {fail} from './security.mjs';

export const terminalRun = status => ['cancelled', 'completed', 'failed', 'interrupted'].includes(status);

export function safeHermesRunText(text = '') {
  if (typeof text !== 'string') return '';
  return text.replace(/[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{43}/g, token => {
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
      return payload.account && payload.chat && payload.turn && payload.exp ? '[redacted capability]' : token;
    } catch { return token; }
  });
}

export function hermesRunFailure(run, attempt) {
  // This exact runtime-resolution error occurs before Hermes constructs the agent.
  // Other terminal failures can follow tool writes and must never authorize a rerun.
  const error = typeof run.error === 'string' ? run.error : '';
  const provider = /^(?:\u26a0\ufe0f )?Provider authentication failed: Unknown provider '([a-zA-Z0-9_-]+)'\. Check 'hermes model' for available providers, or run 'hermes doctor' to diagnose config issues\.$/.exec(error);
  const hasExecution = Boolean(run.output || run.partialText || attempt?.partialText || attempt?.toolActivity
    || (Array.isArray(run.tool_calls) && run.tool_calls.length) || (Array.isArray(run.events) && run.events.some(event => String(event?.event || '').startsWith('tool.'))));
  const retryable = Boolean(provider && !hasExecution);
  return {status: 'failed', error: retryable
    ? `Hermes no pudo iniciar la ejecucion: proveedor desconocido '${provider[1]}'. Corrige la configuracion antes de reintentar.`
    : 'Hermes ha fallado. Comprueba las acciones del turno antes de iniciar otra consulta.', retryable};
}

export function settledHermesTranscript(session, attempt, result) {
  if (!attempt) return;
  const turnId = attempt.turnId || attempt.requestId;
  const text = safeHermesRunText(result.text);
  const answer = {role: 'assistant', content: text, turnId, ...(result.status === 'failed' ? {status: 'failed', error: result.error, retryable: result.retryable, allowSend: attempt.allowSend === true, allowPropose: attempt.allowPropose === true,
    ...(Array.isArray(attempt.imageNames) ? {retryImageNames: attempt.imageNames} : {})} : {})};
  const index = session.messages.findIndex(row => row.turnId === turnId && row.role === 'assistant');
  if (index >= 0) session.messages[index] = answer;
  else session.messages.push({role: 'user', content: attempt.userContent, turnId}, answer);
  if (result.status === 'failed') Object.assign(attempt, result);
  else {attempt.answer = text; attempt.status = 'completed'; delete attempt.error; delete attempt.retryable;}
}

export async function readHermesRun({remote, base, headers, runId}) {
  if (!/^run_[a-zA-Z0-9_-]+$/.test(runId || '')) throw fail(502, 'Hermes no ha confirmado la ejecucion.');
  const run = await (await remote(`${base}/v1/runs/${encodeURIComponent(runId)}`, {headers})).json();
  if (run.run_id && run.run_id !== runId) throw fail(502, 'Hermes devolvio otra ejecucion; el estado no esta confirmado.');
  return run;
}

export function hermesImages(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 4) throw fail(400, 'Invalid images');
  let total = 0;
  return value.map(image => {
    if (!image || typeof image.name !== 'string' || image.name.length > 255 || typeof image.url !== 'string') throw fail(400, 'Invalid image');
    const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image.url);
    if (!match || match[2].length % 4 || match[2].length > 12 * 1024 * 1024) throw fail(400, 'Invalid image data');
    const bytes = Buffer.from(match[2], 'base64');
    total += bytes.length;
    if (!bytes.length || bytes.toString('base64') !== match[2]) throw fail(400, 'Invalid image data');
    if (total > 8 * 1024 * 1024) throw fail(413, 'Images exceed 8 MiB');
    return {name: image.name, url: image.url};
  });
}

export function hermesUserContent(text, images) {
  return images.length ? [{type: 'text', text}, ...images.map(image => ({type: 'image_url', image_url: {url: image.url}}))] : text;
}

// Run stop is a request to interrupt. Only its subsequent terminal status confirms completion.
export async function stopHermesRun({remote, base, headers, runId, timeoutMs = 10000}) {
  let status = await (await remote(`${base}/v1/runs/${encodeURIComponent(runId)}/stop`, {method: 'POST', headers})).json();
  const deadline = Date.now() + timeoutMs;
  while (!terminalRun(status.status) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
    status = await (await remote(`${base}/v1/runs/${encodeURIComponent(runId)}`, {headers}, Math.max(1, deadline - Date.now()))).json();
  }
  if (!terminalRun(status.status)) throw fail(502, 'Hermes sigue deteniendose; la cancelacion no esta confirmada.');
  return status;
}

export async function consumeHermesRun({response, capability, onActivity, onDelta, signal}) {
  const decoder = new SseDecoder();
  const redactor = new CapabilityRedactor(capability);
  const progress = new HermesStreamAccumulator({onActivity});
  let terminal = null;
  let partialText = '';
  const handle = frame => {
    let data;
    try { data = JSON.parse(frame.data); } catch { return; }
    const event = data.event || frame.event;
    if (event === 'message.delta' && typeof data.delta === 'string') {
      const text = redactor.push(data.delta);
      if (text) {partialText += text; onDelta(text);}
    } else if (event === 'tool.started' || event === 'tool.completed' || event === 'tool.failed') {
      progress.handle({event: 'hermes.tool.progress', data: JSON.stringify({tool: data.tool, status: event === 'tool.started' ? 'started' : event === 'tool.failed' ? 'failed' : 'completed'})});
    } else if (event.startsWith('run.') && terminalRun(event.slice(4))) terminal = {...data, status: event.slice(4)};
  };
  const reader = response.body.getReader();
  const cancel = () => {reader.cancel().catch(() => {});};
  signal?.addEventListener('abort', cancel, {once: true});
  if (signal?.aborted) cancel();
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      for (const frame of decoder.push(value)) handle(frame);
    }
  } catch (error) {
    if (!signal?.aborted) throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
  for (const frame of decoder.end()) handle(frame);
  const rest = redactor.flush();
  if (rest) {partialText += rest; onDelta(rest);}
  return {...(terminal || {status: 'unknown'}), partialText};
}

export function cancelledHermesTranscript(session, attempt, partialText = '', status = 'cancelled') {
  if (!attempt) return;
  attempt.cancelled = true;
  attempt.answer = '';
  if (partialText) attempt.partialText = partialText;
  const turnId = attempt.turnId || attempt.requestId;
  if (attempt.userContent && !session.messages.some(row => row.turnId === turnId)) {
    session.messages.push({role: 'user', content: attempt.userContent, turnId},
      {role: 'assistant', content: attempt.partialText || '', turnId, status, cancelled: true});
  } else {
    const answer = session.messages.find(row => row.turnId === turnId && row.role === 'assistant');
    if (answer && attempt.partialText) answer.content = attempt.partialText;
  }
}
