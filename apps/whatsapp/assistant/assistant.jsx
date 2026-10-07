import React, {useCallback, useEffect, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {AssistantRuntimeProvider, MessagePrimitive, ThreadPrimitive, useExternalStoreRuntime, useAuiState} from '@assistant-ui/react';
import {MarkdownTextPrimitive} from '@assistant-ui/react-markdown';
import remarkGfm from 'remark-gfm';
import './assistant.css';

const SEND_PATH = 'm4 4 16 8-16 8 3-8zM7 12h13';

function mediaUrl(value) {
  try {
    const url = new URL(value, location.origin);
    if (url.username || url.password || !['https:', 'http:'].includes(url.protocol)) return null;
    if (url.origin === location.origin) return url.href;
    if (url.protocol !== 'https:' || /^(localhost|.*\.local|.*\.localhost|.*\.internal|.*\.lan|0\..*|127\..*|10\..*|169\.254\..*|192\.168\..*|172\.(1[6-9]|2\d|3[01])\..*|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\..*|\[.*\])$/i.test(url.hostname)) return null;
    return url.href;
  } catch { return null; }
}

function MediaLink({href, children}) {
  const safe = mediaUrl(href);
  if (!safe) return <span>{children}</span>;
  const path = new URL(safe).pathname;
  return <span className="ai-media-link">
    <a href={safe} target="_blank" rel="noopener noreferrer">{children}</a>
    {/\.(mp3|wav|ogg|m4a|opus|aac)$/i.test(path) && <audio controls preload="none" src={safe} aria-label="Audio del agente" />}
    {/\.(mp4|webm|mov)$/i.test(path) && <video controls preload="none" src={safe} aria-label="Video del agente" />}
  </span>;
}

function AgentText() {
  return <MarkdownTextPrimitive remarkPlugins={[remarkGfm]} className="ai-markdown" components={{a: MediaLink}} />;
}

function Bubble() {
  const role = useAuiState(state => state.message.role);
  const incomplete = useAuiState(state => state.message.status?.type === 'incomplete');
  const cancelled = useAuiState(state => state.message.status?.reason === 'cancelled');
  const content = useAuiState(state => state.message.content);
  const [copied, setCopied] = useState(false);
  const [copyProblem, setCopyProblem] = useState('');
  const hasContent = content.some(part => part.type === 'image' || part.type === 'text' && part.text);
  const text = content.filter(part => part.type === 'text').map(part => part.text).join('\n');
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setCopyProblem(''); }
    catch { setCopyProblem('No se pudo copiar. Selecciona el texto para copiarlo.'); }
  };
  if (!hasContent) return null;
  return <MessagePrimitive.Root className={role === 'user' ? 'ai-bubble ai-bubble-out' : 'ai-bubble ai-bubble-in'}>
    <div className="ai-bubble-text"><MessagePrimitive.Parts components={role === 'assistant' ? {Text: AgentText} : undefined} /></div>
    {role === 'assistant' && text && <button type="button" className="ai-copy" onClick={copy} aria-label="Copiar respuesta">{copied ? 'Copiado' : 'Copiar'}</button>}
    {copyProblem && <span role="status" className="ai-incomplete">{copyProblem}</span>}
    {incomplete && <span className="ai-incomplete">{cancelled ? 'Respuesta detenida' : 'Respuesta incompleta'}</span>}
  </MessagePrimitive.Root>;
}

/* The assistant panel is one ordinary conversation: bubbles, a typing receipt and a
   composer. It stays mounted while hidden so a turn started from the composer keeps
   its place in the thread, and it only reads server state once the owner opens it. */
function PrivateChat({ctx, request, useDraft, active, api, draftPrompt, draftLabel}) {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [problem, setProblem] = useState('');
  const [activity, setActivity] = useState(null);
  const [activityLog, setActivityLog] = useState([]);
  const [images, setImages] = useState([]);
  const [readingImages, setReadingImages] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stoppedNotice, setStoppedNotice] = useState(false);
  const turnStateRef = useRef(null);
  const fileRef = useRef(null);
  const [failedTurn, setFailedTurn] = useState(null);
  const [proposals, setProposals] = useState([]);
  const [proposalBusy, setProposalBusy] = useState('');
  const proposalRequest = useRef(0);
  const sessionIdRef = useRef('chat');
  const historyPromise = useRef(null);
  const historyLoading = useRef(false);
  const hasHistory = useRef(false);
  const failedTurnRef = useRef(failedTurn);
  failedTurnRef.current = failedTurn;
  const currentTurnRef = useRef(null);
  const mountedRef = useRef(true);
  const activeRef = useRef(active);
  activeRef.current = active;
  const queueRef = useRef(Promise.resolve());
  const submittingRef = useRef(false);
  const followLatest = useRef(true);
  const threadRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => () => { mountedRef.current = false; }, []);
  useEffect(() => { api.hasDraft = Boolean(prompt || images.length || readingImages); }, [api, prompt, images.length, readingImages]);

  const shownPrompt = useCallback(text => (draftPrompt && text === draftPrompt && draftLabel ? draftLabel : text), [draftLabel, draftPrompt]);

  const loadProposals = useCallback(async () => {
    if (!ctx.account || !ctx.chat) return;
    const requestId = ++proposalRequest.current;
    const params = new URLSearchParams({account: ctx.account, chat: ctx.chat});
    const result = await request(`/api/ai/proposals?${params}`);
    if (requestId === proposalRequest.current) setProposals((result.proposals || []).filter(proposal => typeof proposal.id === 'string' && typeof proposal.text === 'string'));
  }, [ctx.account, ctx.chat, request]);

  const loadHistory = useCallback((refresh = false) => {
    if (historyPromise.current && (!refresh || historyLoading.current || api.pending || failedTurnRef.current)) return historyPromise.current;
    if (!ctx.account || !ctx.chat) return Promise.resolve();
    const previousPromise = historyPromise.current;
    historyLoading.current = true;
    setLoading(true);
    const params = new URLSearchParams({account: ctx.account, chat: ctx.chat});
    const pending = request(`/api/ai/session?${params}`).then(result => {
      if (!mountedRef.current) return;
      sessionIdRef.current = result.sessionId || 'chat';
      const history = (result.messages || []).filter(message => ['user', 'assistant'].includes(message.role) && (typeof message.content === 'string' || Array.isArray(message.content))).map((message, index) => ({
        id: `${sessionIdRef.current}-${index}`,
        role: message.role,
        ...(message.role === 'assistant' && (message.cancelled || ['cancelled', 'interrupted'].includes(message.status)) ? {status: {type: 'incomplete', reason: 'cancelled'}} : {}),
        content: typeof message.content === 'string' ? [{type: 'text', text: shownPrompt(message.content)}] : message.content.flatMap(part => part.type === 'text' ? [{type: 'text', text: shownPrompt(part.text || '')}] : part.type === 'image_url' && /^data:image\/(png|jpeg|webp|gif);base64,/.test(part.image_url?.url || '') ? [{type: 'image', image: part.image_url.url}] : [])
      }));
      // A draft request may start while the hidden panel has not loaded history yet.
      const replace = hasHistory.current;
      hasHistory.current = true;
      const pendingUserId = currentTurnRef.current;
      setMessages(previous => [...history, ...(replace ? previous.filter(item => item.id === pendingUserId) : previous)]);
    }).catch(error => {
      historyPromise.current = previousPromise;
      throw error;
    }).finally(() => {
      historyLoading.current = false;
      if (mountedRef.current) setLoading(false);
    });
    historyPromise.current = pending;
    return pending;
  }, [api, ctx.account, ctx.chat, request, shownPrompt]);

  useEffect(() => {
    if (active) void loadHistory(true).catch(error => { if (mountedRef.current) setProblem(error.message); });
  }, [active, ctx.version, loadHistory]);

  useEffect(() => {
    if (!active || !ctx.chat) return;
    let mounted = true;
    loadProposals().catch(error => { if (mounted) setProblem(error.message); });
    return () => { mounted = false; };
  }, [active, ctx.chat, loadProposals]);

  const refreshProposals = useCallback(() => {
    if (!activeRef.current) return Promise.resolve();
    return loadProposals();
  }, [loadProposals]);

  const decideProposal = async (id, action) => {
    if (proposalBusy) return;
    setProposalBusy(id);
    setProblem('');
    try {
      await request('/api/ai/proposal', {account: ctx.account, chat: ctx.chat, id, action});
      setProposals(previous => previous.filter(proposal => proposal.id !== id));
      await refreshProposals().catch(error => setProblem(`No se pudieron actualizar las propuestas: ${error.message}`));
    } catch (error) {
      setProblem(error.message);
      // Approval may have consumed the proposal before delivery status became uncertain.
      void refreshProposals().catch(() => {});
    } finally {
      setProposalBusy('');
    }
  };

  const scrollToLatest = useCallback(() => {
    const pane = threadRef.current?.querySelector('.ai-history');
    if (pane && followLatest.current) pane.scrollTop = pane.scrollHeight;
  }, []);

  const runTurn = useCallback(async (text, {allowPropose = true, allowSend = true, userId = `user-${crypto.randomUUID()}`, images = []} = {}) => {
    const message = String(text || '').trim();
    if (!message && !images.length) return '';
    if (!ctx.account || !ctx.chat) throw new Error('Selecciona una conversación para consultar.');
    const assistantId = `answer-${userId}`;
    currentTurnRef.current = userId;
    const turnState = {userId, cancelled: false, dispatched: false, controller: new AbortController()};
    turnStateRef.current = turnState;
    setActivityLog([]);
    setStoppedNotice(false);
    followLatest.current = true;
    setFailedTurn(null);
    setActivity({phase: 'thinking', label: 'Pensando'});
    setMessages(previous => previous.some(item => item.id === userId) ? previous.filter(item => item.id !== assistantId) : [...previous,
      {id: userId, role: 'user', content: [{type: 'text', text: shownPrompt(message)}, ...images.map(image => ({type: 'image', image: image.url}))]}
    ]);
    const updateAnswer = (text, complete = false) => {
      const answer = {id: assistantId, role: 'assistant', content: [{type: 'text', text}], status: complete ? {type: 'complete', reason: 'stop'} : {type: 'running'}};
      setMessages(previous => previous.some(item => item.id === assistantId) ? previous.map(item => item.id === assistantId ? answer : item) : [...previous, answer]);
    };
    let partial = '';
    try {
      await loadHistory();
      if (turnState.cancelled) return '';
      turnState.dispatched = true;
      const result = await request('/api/ai/chat', {account: ctx.account, chat: ctx.chat, message, images, allowPropose, allowSend, stream: true, turnId: userId.replace(/^user-/, '')}, (event, payload) => {
        if (turnState.cancelled) return;
        if (event === 'activity' && payload && typeof payload.label === 'string') {
          setActivity(payload);
          setActivityLog(previous => [...previous.slice(-49), {phase: payload.phase, label: payload.label, tool: payload.tool, status: payload.status}]);
        }
        if (event === 'delta' && typeof payload.text === 'string') {
          partial += payload.text;
          setActivity({phase: 'writing', label: 'Escribiendo'});
          updateAnswer(partial);
        }
        if (event === 'result') {
          setActivity(null);
          if (payload.status === 'cancelled' || payload.cancelled) {
            turnState.cancelled = true;
            setStoppedNotice(true);
            setFailedTurn(null);
            setMessages(previous => previous.map(item => item.id === assistantId ? {...item, status: {type: 'incomplete', reason: 'cancelled'}} : item));
          }
        }
      }, AbortSignal.any([turnState.controller.signal, AbortSignal.timeout(240000)]));
      if (turnState.cancelled || result.cancelled || ['cancelled', 'interrupted'].includes(result.status)) {
        turnState.cancelled = true;
        setStoppedNotice(true);
        setMessages(previous => previous.map(item => item.id === assistantId ? {...item, status: {type: 'incomplete', reason: 'cancelled'}} : item));
        return '';
      }
      const answer = typeof result.text === 'string' ? result.text : '';
      updateAnswer(answer, true);
      setActivity(null);
      void refreshProposals().catch(error => setProblem(`No se pudieron actualizar las propuestas: ${error.message}`));
      return answer;
    } catch (error) {
      if (turnState.cancelled || error.code === 'cancelled') return '';
      setFailedTurn({text: message, options: {allowPropose, allowSend, userId, images}});
      setProblem(error.message);
      if (partial) setMessages(previous => previous.map(item => item.id === assistantId ? {...item, status: {type: 'incomplete', reason: 'error'}} : item));
      throw error;
    } finally {
      if (turnStateRef.current === turnState) turnStateRef.current = null;
      currentTurnRef.current = null;
      setActivity(null);
    }
  }, [ctx.account, ctx.chat, loadHistory, refreshProposals, request, shownPrompt]);

  const enqueue = useCallback(task => {
    api.pending = (api.pending || 0) + 1;
    const run = () => {
      setRunning(true);
      setProblem('');
      return Promise.resolve().then(task).finally(() => setRunning(false));
    };
    const result = queueRef.current.then(run, run).finally(() => { api.pending--; });
    queueRef.current = result.then(() => {}, () => {});
    return result;
  }, [api]);

  const ask = useCallback((text, options) => enqueue(() => runTurn(text, options)), [enqueue, runTurn]);

  useEffect(() => {
    api.ask = ask;
    api.onReady?.();
    delete api.onReady;
    return () => { if (api.ask === ask) api.ask = null; };
  }, [api, ask]);

  const onNew = useCallback(message => {
    const text = message.content.filter(part => part.type === 'text').map(part => part.text).join('').trim();
    if ((!text && !images.length) || submittingRef.current) return Promise.resolve();
    submittingRef.current = true;
    const attachments = images;
    setImages([]);
    setPrompt('');
    inputRef.current?.focus();
    return enqueue(() => runTurn(text, {images: attachments})).catch(error => {
      setProblem(error.message);
      return Promise.reject(error);
    }).finally(() => { submittingRef.current = false; });
  }, [enqueue, runTurn, images]);

  const stopTurn = useCallback(async () => {
    const turn = turnStateRef.current;
    if (!turn || stopping) return;
    setStopping(true);
    try {
      const result = turn.dispatched ? await request('/api/ai/stop', {account: ctx.account, chat: ctx.chat, turnId: turn.userId.replace(/^user-/, ''), sessionId: sessionIdRef.current}) : {stopped: true, status: 'cancelled'};
      if (result.stopped !== true) throw new Error('No se pudo confirmar la detencion del agente.');
      if (['cancelled', 'interrupted'].includes(result.status)) {
        turn.cancelled = true;
        turn.controller.abort();
        setStoppedNotice(true);
        setFailedTurn(null);
        setProblem('');
        setActivity(null);
        setMessages(previous => previous.map(item => item.id === `answer-${turn.userId}` ? {...item, status: {type: 'incomplete', reason: 'cancelled'}} : item));
        // The aborted consumer settles enqueue/onNew before the Send control returns.
      }
    } catch (error) { setProblem(error.message); }
    finally { setStopping(false); }
  }, [ctx.account, ctx.chat, request, stopping]);

  const addImages = async files => {
    if (readingImages) return;
    const selected = Array.from(files);
    if (selected.some(file => !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type))) { setProblem('Adjunta imagenes PNG, JPEG, WebP o GIF.'); return; }
    if (images.length + selected.length > 4 || images.reduce((total, image) => total + image.size, 0) + selected.reduce((total, file) => total + file.size, 0) > 8 * 1024 * 1024) { setProblem('Maximo 4 imagenes y 8 MiB en total.'); return; }
    setReadingImages(true);
    try {
      const next = await Promise.all(selected.map(file => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve({name: file.name, size: file.size, url: reader.result});
        reader.onerror = () => reject(new Error('No se pudo leer la imagen.'));
        reader.readAsDataURL(file);
      })));
      setImages(previous => [...previous, ...next]);
      setProblem('');
    } catch (error) { setProblem(error.message); }
    finally { setReadingImages(false); }
  };

  const runtime = useExternalStoreRuntime({messages, onNew, onCancel: stopTurn, convertMessage: message => message, isRunning: running, isSendDisabled: !ctx.chat || loading || running});
  const lastAnswer = [...messages].reverse().find(message => message.role === 'assistant');
  const lastReply = lastAnswer?.status?.type === 'incomplete' ? '' : lastAnswer?.content[0]?.text || '';
  const retryTurn = () => {
    if (!failedTurn || submittingRef.current || running) return;
    submittingRef.current = true;
    void ask(failedTurn.text, failedTurn.options).catch(() => {}).finally(() => { submittingRef.current = false; });
  };
  const submit = event => {
    event.preventDefault();
    const text = prompt.trim();
    if ((text || images.length) && !readingImages && !running && !loading) onNew({role: 'user', content: [{type: 'text', text}]}).catch(() => {});
  };
  const onKeyDown = event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  useEffect(() => {
    const element = inputRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
  }, [prompt, active, ctx.chat]);

  useEffect(() => { if (active) scrollToLatest(); }, [active, messages, activity, running, loading, scrollToLatest]);

  const emptyNotice = !ctx.chat ? 'Selecciona una conversación para empezar.' : 'Escribe para consultar sobre esta conversación.';

  return <AssistantRuntimeProvider runtime={runtime}>
    <div className="ai-thread" ref={threadRef}>
      <ThreadPrimitive.Root className="ai-conversation">
        <ThreadPrimitive.Viewport className="ai-history" aria-label="Conversación con Social Media Agent" onScroll={event => {
          const pane = event.currentTarget;
          followLatest.current = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 80;
        }}>
          {loading ? <p className="ai-note" role="status">Cargando conversación…</p> : messages.length === 0 ? <p className="ai-note">{emptyNotice}</p> : null}
          <ThreadPrimitive.Messages components={{Message: Bubble}} />
          {running && activity && <div className="ai-activity" role="status" aria-live="polite">
            <span className={`ai-activity-icon ${activity.phase === 'tool' ? 'ai-tool-icon' : ''}`} aria-hidden="true">{activity.phase === 'tool' ? '⌘' : '✦'}</span>
            <span>{activity.label || 'Pensando'}</span>
            <span className="ai-typing" aria-hidden="true"><span></span><span></span><span></span></span>
          </div>}
          {stoppedNotice && <p className="ai-note ai-stopped" role="status">Respuesta detenida. Puedes enviar otro mensaje.</p>}
          {activityLog.length > 0 && <details className="ai-activity-details">
            <summary>Actividad del agente ({activityLog.length})</summary>
            <ol>{activityLog.map((entry, index) => <li key={index}>{entry.label}{entry.tool && <code> {entry.tool}</code>}<small>{entry.status || ({tool_done: 'Completado', tool_error: 'Error', tool: 'En curso', thinking: 'Preparando respuesta'}[entry.phase] || '')}</small></li>)}</ol>
          </details>}
          {problem && <div className="ai-error" role="alert"><p>{problem}</p>{failedTurn && !running && <button type="button" onClick={retryTurn}>Reintentar</button>}</div>}
          {lastReply && !running && !failedTurn && <button id="ai-use-draft" type="button" disabled={!ctx.chat} onClick={() => useDraft(lastReply, ctx)}>Usar como borrador</button>}
        </ThreadPrimitive.Viewport>
        {proposals.length > 0 && <section className="ai-proposals" aria-label="Propuestas pendientes">
          <h3>Propuestas pendientes</h3>
          <p>Revisa el texto exacto antes de aprobar su envío por WhatsApp.</p>
          {proposals.map(proposal => <article className="ai-proposal" key={proposal.id}>
            <div className="ai-proposal-text">{proposal.text}</div>
            <div className="ai-proposal-actions">
              <button type="button" disabled={Boolean(proposalBusy)} onClick={() => decideProposal(proposal.id, 'reject')}>Descartar</button>
              <button type="button" className="primary" disabled={Boolean(proposalBusy)} onClick={() => decideProposal(proposal.id, 'approve')}>Aprobar y enviar</button>
            </div>
          </article>)}
        </section>}
        {images.length > 0 && <div className="ai-attachments" aria-label="Imagenes adjuntas">{images.map((image, index) => <div key={`${image.name}-${index}`} className="ai-attachment"><img src={image.url} alt={image.name} /><button type="button" aria-label={`Quitar ${image.name}`} onClick={() => setImages(previous => previous.filter((_, i) => i !== index))}>×</button></div>)}</div>}
        <form className="ai-composer" onSubmit={submit}>
          <input type="file" ref={fileRef} hidden accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={event => { void addImages(event.target.files); event.target.value = ''; }} />
          <button type="button" className="ai-send ai-attach" aria-label="Adjuntar imagenes" disabled={!ctx.chat || loading || readingImages} onClick={() => fileRef.current?.click()}>+</button>
          <label className="sr-only" htmlFor="ai-prompt">Mensaje para Social Media Agent</label>
          <textarea id="ai-prompt" ref={inputRef} value={prompt} onChange={event => setPrompt(event.target.value)} onKeyDown={onKeyDown} onPaste={event => {
            const files = Array.from(event.clipboardData?.files || []);
            if (files.length) { event.preventDefault(); void addImages(files); }
          }} placeholder="Escribe un mensaje" rows="1" disabled={!ctx.chat || loading} />
          {running ? <button id="ai-stop" className="ai-send ai-stop" type="button" disabled={stopping} onClick={stopTurn} aria-label="Detener respuesta">{stopping ? '…' : '■'}</button> : <button id="ai-send" className="ai-send" type="submit" disabled={!ctx.chat || loading || running || readingImages || (!prompt.trim() && !images.length)} aria-label="Enviar mensaje"><svg viewBox="0 0 24 24" focusable="false" aria-hidden="true"><path d={SEND_PATH}/></svg></button>}
        </form>
      </ThreadPrimitive.Root>
    </div>
  </AssistantRuntimeProvider>;
}

export function mountAssistant(target, {request, useDraft, draftPrompt = '', draftLabel = ''}) {
  const options = {draftPrompt, draftLabel};
  let ctx = {account: '', chat: '', version: 0};
  let open = false;
  const threads = new Map();
  let currentThread;
  const renderThread = (thread, active) => thread.root.render(<PrivateChat ctx={thread.ctx} active={active} request={request} useDraft={useDraft} api={thread.api} draftPrompt={options.draftPrompt} draftLabel={options.draftLabel} />);
  const render = () => {
    const key = JSON.stringify([ctx.account, ctx.chat]);
    let thread = threads.get(key);
    if (!thread) {
      const element = document.createElement('div');
      element.className = 'ai-context';
      const api = {};
      const ready = new Promise(resolve => { api.onReady = resolve; });
      thread = {element, root: createRoot(element), api, ready, ctx};
      threads.set(key, thread);
    }
    if (currentThread && currentThread !== thread) renderThread(currentThread, false);
    thread.ctx = ctx;
    currentThread = thread;
    // Keep in-flight chats alive off-screen; switching contacts never drops a turn.
    if (target.firstChild !== thread.element) target.replaceChildren(thread.element);
    threads.delete(key);
    threads.set(key, thread);
    renderThread(thread, open);
    for (const [oldKey, oldThread] of threads) {
      if (threads.size <= 8) break;
      if (oldThread === thread || oldThread.api.pending || oldThread.api.hasDraft) continue;
      oldThread.root.unmount();
      threads.delete(oldKey);
    }
  };
  render();
  return {
    select(next) { ctx = next; render(); },
    setOpen(value) {
      open = value;
      render();
      if (open) requestAnimationFrame(() => target.querySelector('#ai-prompt')?.focus());
    },
    async proposeDraft(text) {
      const message = String(text || '').trim();
      if (!message) throw new Error('No se pudo preparar la propuesta.');
      if (!ctx.account || !ctx.chat) throw new Error('Selecciona una conversación para pedir una propuesta.');
      const thread = currentThread;
      thread.api.pending = (thread.api.pending || 0) + 1;
      try {
        await thread.ready;
        return await thread.api.ask(message, {allowPropose: true, allowSend: false});
      } finally { thread.api.pending--; }
    }
  };
}
