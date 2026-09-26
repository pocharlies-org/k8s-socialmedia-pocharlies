import React, {useCallback, useEffect, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {AssistantRuntimeProvider, MessagePrimitive, ThreadPrimitive, useExternalStoreRuntime, useAuiState} from '@assistant-ui/react';
import {MarkdownTextPrimitive} from '@assistant-ui/react-markdown';
import remarkGfm from 'remark-gfm';
import './assistant.css';

const SEND_PATH = 'm4 4 16 8-16 8 3-8zM7 12h13';

function AgentText() {
  return <MarkdownTextPrimitive remarkPlugins={[remarkGfm]} className="ai-markdown" />;
}

function Bubble() {
  const role = useAuiState(state => state.message.role);
  const incomplete = useAuiState(state => state.message.status?.type === 'incomplete');
  const hasContent = useAuiState(state => state.message.content.some(part => part.type === 'text' && part.text));
  if (!hasContent) return null;
  return <MessagePrimitive.Root className={role === 'user' ? 'ai-bubble ai-bubble-out' : 'ai-bubble ai-bubble-in'}>
    <div className="ai-bubble-text"><MessagePrimitive.Parts components={role === 'assistant' ? {Text: AgentText} : undefined} /></div>
    {incomplete && <span className="ai-incomplete">Respuesta incompleta</span>}
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
      const history = (result.messages || []).filter(message => ['user', 'assistant'].includes(message.role) && typeof message.content === 'string').map((message, index) => ({
        id: `${sessionIdRef.current}-${index}`,
        role: message.role,
        content: [{type: 'text', text: shownPrompt(message.content)}]
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

  const runTurn = useCallback(async (text, {allowPropose = true, allowSend = true, userId = `user-${crypto.randomUUID()}`} = {}) => {
    const message = String(text || '').trim();
    if (!message) return '';
    if (!ctx.account || !ctx.chat) throw new Error('Selecciona una conversación para consultar.');
    const assistantId = `answer-${userId}`;
    currentTurnRef.current = userId;
    followLatest.current = true;
    setFailedTurn(null);
    setActivity({phase: 'thinking', label: 'Pensando'});
    setMessages(previous => previous.some(item => item.id === userId) ? previous.filter(item => item.id !== assistantId) : [...previous,
      {id: userId, role: 'user', content: [{type: 'text', text: shownPrompt(message)}]}
    ]);
    const updateAnswer = (text, complete = false) => {
      const answer = {id: assistantId, role: 'assistant', content: [{type: 'text', text}], status: complete ? {type: 'complete', reason: 'stop'} : {type: 'running'}};
      setMessages(previous => previous.some(item => item.id === assistantId) ? previous.map(item => item.id === assistantId ? answer : item) : [...previous, answer]);
    };
    let partial = '';
    try {
      await loadHistory();
      const result = await request('/api/ai/chat', {account: ctx.account, chat: ctx.chat, message, allowPropose, allowSend, stream: true, turnId: userId.replace(/^user-/, '')}, (event, payload) => {
        if (event === 'activity' && payload && typeof payload.label === 'string') setActivity(payload);
        if (event === 'delta' && typeof payload.text === 'string') {
          partial += payload.text;
          setActivity({phase: 'writing', label: 'Escribiendo'});
          updateAnswer(partial);
        }
        if (event === 'result') setActivity(null);
      });
      const answer = typeof result.text === 'string' ? result.text : '';
      updateAnswer(answer, true);
      setActivity(null);
      void refreshProposals().catch(error => setProblem(`No se pudieron actualizar las propuestas: ${error.message}`));
      return answer;
    } catch (error) {
      setFailedTurn({text: message, options: {allowPropose, allowSend, userId}});
      setProblem(error.message);
      if (partial) setMessages(previous => previous.map(item => item.id === assistantId ? {...item, status: {type: 'incomplete', reason: 'error'}} : item));
      throw error;
    } finally {
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
    if (!text || submittingRef.current) return Promise.resolve();
    submittingRef.current = true;
    setPrompt('');
    inputRef.current?.focus();
    return enqueue(() => runTurn(text)).catch(error => {
      setProblem(error.message);
      return Promise.reject(error);
    }).finally(() => { submittingRef.current = false; });
  }, [enqueue, runTurn]);

  const runtime = useExternalStoreRuntime({messages, onNew, convertMessage: message => message, isRunning: running, isSendDisabled: !ctx.chat || loading || running});
  const lastReply = [...messages].reverse().find(message => message.role === 'assistant')?.content[0]?.text || '';
  const retryTurn = () => {
    if (!failedTurn || submittingRef.current || running) return;
    submittingRef.current = true;
    void ask(failedTurn.text, failedTurn.options).catch(() => {}).finally(() => { submittingRef.current = false; });
  };
  const submit = event => {
    event.preventDefault();
    const text = prompt.trim();
    if (text && !running && !loading) onNew({role: 'user', content: [{type: 'text', text}]}).catch(() => {});
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
        <form className="ai-composer" onSubmit={submit}>
          <label className="sr-only" htmlFor="ai-prompt">Mensaje para Social Media Agent</label>
          <textarea id="ai-prompt" ref={inputRef} value={prompt} onChange={event => setPrompt(event.target.value)} onKeyDown={onKeyDown} placeholder="Escribe un mensaje" rows="1" disabled={!ctx.chat || loading} />
          <button id="ai-send" className="ai-send" type="submit" disabled={!ctx.chat || loading || running || !prompt.trim()} aria-label="Enviar mensaje"><svg viewBox="0 0 24 24" focusable="false" aria-hidden="true"><path d={SEND_PATH}/></svg></button>
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
      if (oldThread === thread || oldThread.api.pending) continue;
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
