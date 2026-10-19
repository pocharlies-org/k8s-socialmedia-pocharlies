import test from 'node:test';
import assert from 'node:assert/strict';
import { canShowMessageInfo, createMessageInfoPanel, messageInfoSections } from '../public/features-ui.mjs';

function element(tag) {
  return { tag, children: [], attributes: {}, textContent: '',
    append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = items; },
    setAttribute(key, value) { this.attributes[key] = String(value); },
    set innerHTML(_) { throw new Error('Receipt content must never use HTML'); },
  };
}
const documentRef = { createElement: element };
const flatten = node => [node.textContent, ...node.children.map(flatten)].join(' ');
const scope = { account: 'alpha', chat: 'group', generation: 1 };
const message = { id: '42', fromMe: true, text: '<img src=x onerror=alert(1)>' };
const result = extra => ({ account: scope.account, chatId: scope.chat, messageId: message.id, fromMe: true,
  recipientCount: null, completeRecipients: false, receipts: [], ...extra });
function fixture(requestInfo, getContext = () => scope, isOpen = () => true, timers = {}) {
  const container = element('div');
  const panel = createMessageInfoPanel({ documentRef, container, message, context: scope, requestInfo, ...timers,
    isCurrent: () => isOpen() && ['account', 'chat', 'generation'].every(key => getContext()[key] === scope[key]),
  });
  return { ...panel, container, notice: container.children[1], retry: container.children[2], content: container.children[3] };
}

test('information action only applies to persisted outgoing messages including BIGINT and UUID ids', () => {
  assert.equal(canShowMessageInfo(message), true);
  assert.equal(canShowMessageInfo({ ...message, id: 'cf575ef5-88b8-4cb4-a13e-baf9f6037a7c' }), true);
  for (const update of [{ fromMe: false }, { fromMe: 'true' }, { id: '' }, { id: 'local-123' }, { id: 'tmp-123' }, { pending: true }, { optimistic: true }]) {
    assert.equal(canShowMessageInfo({ ...message, ...update }), false);
  }
});

test('empty provider receipts show unknown total and never imply unread or undelivered', async () => {
  const ui = fixture(async () => result());
  await ui.load();
  assert.match(flatten(ui.container), /Leído por · Sin datos/);
  assert.match(flatten(ui.container), /Entregado a · Sin datos/);
  assert.match(flatten(ui.container), /Sin confirmaciones de lectura disponibles/);
  assert.match(ui.notice.textContent, /Esto no indica que nadie lo haya leído o recibido/);
  assert.doesNotMatch(flatten(ui.content), /Reproducido/);
  assert.equal(ui.container.attributes['aria-busy'], 'false');
});

test('render actual local times, newest read first and untrusted names as text', async () => {
  const receipts = [
    { participantId: 'a', name: '<script>alert(1)</script>', deliveredAt: '2026-10-11T08:00:00Z', readAt: '2026-10-11T09:00:00Z', playedAt: null },
    { participantId: 'b', name: '', deliveredAt: null, readAt: '2026-10-11T10:00:00Z', playedAt: '2026-10-11T10:01:00Z' },
  ];
  const ui = fixture(async () => result({ recipientCount: 3, receipts }));
  await ui.load();
  const read = ui.content.children[0];
  assert.equal(read.children[1].children[0].children[0].textContent, 'b');
  assert.equal(read.children[2].children[0].children[0].textContent, receipts[0].name);
  const time = read.children[1].children[1];
  assert.equal(time.textContent, new Date(receipts[1].readAt).toLocaleString());
  assert.equal(time.attributes.datetime, receipts[1].readAt);
  assert.equal(ui.container.children[0].children[0].textContent, message.text);
  assert.match(flatten(ui.container), /Reproducido por · 1 \/ 3/);
  assert.equal(ui.content.children[1].children.length, 2, 'read-only receipt must not fabricate delivery');
});

test('partial empty sections are missing data even with a known group total', async () => {
  const ui = fixture(async () => result({ recipientCount: 2, receipts: [{ participantId: 'a', deliveredAt: '2026-10-11T08:00:00Z' }] }));
  await ui.load();
  assert.match(flatten(ui.content), /Leído por · Sin datos/);
  assert.match(flatten(ui.content), /Entregado a · 1 \/ 2/);
  assert.doesNotMatch(flatten(ui.content), /Leído por · 0/);
});

test('invalid timestamps and missing identities cannot generate receipts', () => {
  const sections = messageInfoSections({ receipts: [{ participantId: 'a', readAt: 'garbage', deliveredAt: 0 }, { readAt: '2026-10-11T09:00:00Z' }] });
  assert.deepEqual(sections.map(section => section.receipts), [[], []]);
});

test('late success and error cannot render across account, chat, generation or closed modal', async () => {
  for (const update of [{ account: 'beta' }, { chat: 'other' }, { generation: 2 }, { closed: true }]) {
    for (const rejectResponse of [false, true]) {
      let resolve, reject;
      let active = scope;
      let open = true;
      const ui = fixture(() => new Promise((yes, no) => { resolve = yes; reject = no; }), () => active, () => open);
      const pending = ui.load();
      active = { ...scope, ...update }; open = !update.closed;
      if (rejectResponse) reject(new Error('Stale account error')); else resolve(result({ receipts: [{ participantId: 'secret', readAt: '2026-10-11T09:00:00Z' }] }));
      await pending;
      assert.equal(ui.content.children.length, 0);
      assert.doesNotMatch(flatten(ui.container), /secret|Stale account error/);
    }
  }
});

test('mismatched response is a visible retryable error and retry loads same message', async () => {
  let calls = 0;
  const ui = fixture(async () => { calls += 1; return calls === 1 ? result({ account: 'beta' }) : result({ completeRecipients: true, recipientCount: 1 }); });
  await ui.load();
  assert.match(ui.notice.textContent, /no corresponde/);
  assert.equal(ui.retry.hidden, false);
  assert.equal(ui.retry.disabled, false);
  await ui.retry.onclick();
  assert.equal(calls, 2);
  assert.equal(ui.retry.textContent, 'Actualizar');
  assert.match(flatten(ui.content), /Leído por · 0 \/ 1/);
});

test('refresh errors preserve the last receipt evidence and allow another retry', async () => {
  let calls = 0;
  const ui = fixture(async () => {
    if (++calls === 2) throw new Error('<img src=x> Provider offline');
    return result({ receipts: [{ participantId: 'a', name: 'Alice', readAt: '2026-10-11T09:00:00Z' }] });
  });
  await ui.load();
  await ui.retry.onclick();
  assert.match(flatten(ui.content), /Alice/);
  assert.equal(ui.notice.textContent, '<img src=x> Provider offline');
  assert.equal(ui.retry.disabled, false);
  await ui.retry.onclick();
  assert.equal(calls, 3);
});

test('recovery pending refreshes at most three times and keeps a manual update', async () => {
  const scheduled = [];
  let calls = 0;
  const ui = fixture(async () => { calls += 1; return result({ recovery: { state: 'pending' } }); }, undefined, undefined,
    { schedule: (callback, delay) => { scheduled.push({ callback, delay }); return scheduled.length; }, cancel: () => {} });
  await ui.load();
  for (let i = 0; i < 3; i += 1) {
    assert.equal(scheduled[i].delay, 5000);
    scheduled[i].callback();
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(calls, 4);
  assert.equal(scheduled.length, 3);
  assert.match(ui.notice.textContent, /sigue pendiente/);
  assert.match(flatten(ui.content), /Sin datos/);
  await ui.retry.onclick();
  assert.equal(calls, 5);
  assert.equal(scheduled.length, 3, 'Manual update does not renew automatic budget');
});

test('recovery timer is canceled on dispose and does not load a switched scope', async () => {
  for (const close of [false, true]) {
    let callback;
    let calls = 0;
    let active = scope;
    const canceled = [];
    const ui = fixture(async () => { calls += 1; return result({ recovery: { state: 'pending', retryAfterMs: 99999 } }); }, () => active, undefined,
      { schedule: (fn, delay) => { callback = fn; assert.equal(delay, 5000); return 'timer'; }, cancel: id => canceled.push(id) });
    await ui.load();
    if (close) { ui.dispose(); assert.deepEqual(canceled, ['timer']); }
    else active = { ...scope, account: 'beta' };
    callback();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
  }
});

test('complete empty recovery and unavailable recovery explain missing historical evidence', async () => {
  for (const [state, explanation] of [
    ['complete', /WhatsApp no ha facilitado confirmaciones/],
    ['unsupported', /Esta conexión no permite recuperar/],
    ['timeout', /no respondió a tiempo/],
    ['failed', /No se pudieron recuperar/],
  ]) {
    const ui = fixture(async () => result({ recovery: { state } }));
    await ui.load();
    assert.match(ui.notice.textContent, explanation);
    assert.match(flatten(ui.content), /Leído por · Sin datos/);
    assert.equal(ui.retry.disabled, false);
  }
  const complete = fixture(async () => result({ recipientCount: 2, completeRecipients: true, recovery: { state: 'complete' } }));
  await complete.load();
  assert.match(flatten(complete.content), /Leído por · Sin datos/);
  assert.doesNotMatch(flatten(complete.content), /· 0/);
});
