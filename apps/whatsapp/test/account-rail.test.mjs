import test from 'node:test';
import assert from 'node:assert/strict';
import { accountInitials, markActiveAccount, renderAccountRail } from '../public/account-rail.mjs';

class FakeElement {
  constructor() { this.children = []; this.attributes = {}; this.dataset = {}; this.className = ''; this.handlers = {}; this.classList = { toggle: (name, enabled) => { this.className = enabled ? `${this.className.replace(name, '').trim()} ${name}`.trim() : this.className.replace(name, '').trim(); } }; }
  setAttribute(name, value) { this.attributes[name] = value; }
  append(node) { this.children.push(node); }
  replaceChildren() { this.children = []; }
  addEventListener(name, handler) { this.handlers[name] = handler; }
  querySelectorAll() { return this.children.filter(child => child.dataset.accountId); }
}

test('account rail renders every configured account and routes selection by id', () => {
  const container = new FakeElement();
  const selected = [];
  const accounts = [
    { id: 'personal', label: 'Personal' },
    { id: 'work', label: 'Trabajo' },
    { id: 'family', label: 'Familia de casa' },
  ];
  renderAccountRail(container, accounts, 'work', id => selected.push(id), { createElement: () => new FakeElement() });
  assert.equal(container.children.length, accounts.length);
  assert.deepEqual(container.children.map(button => button.dataset.accountId), accounts.map(account => account.id));
  assert.equal(container.children[1].attributes['aria-pressed'], 'true');
  assert.equal(container.children[0].attributes['aria-pressed'], 'false');
  assert.equal(container.children[2].attributes['aria-label'], 'Cuenta de WhatsApp: Familia de casa');
  assert.equal(container.children[2].children[0].textContent, 'FD');
  container.children[2].handlers.click();
  assert.deepEqual(selected, ['family']);
  markActiveAccount(container, 'family');
  assert.deepEqual(container.children.map(button => button.attributes['aria-pressed']), ['false', 'false', 'true']);
});

test('rail handles any count, including an empty account list', () => {
  const container = new FakeElement();
  renderAccountRail(container, [], '', () => {}, { createElement: () => new FakeElement() });
  assert.equal(container.children.length, 0);
  assert.equal(accountInitials('  '), '?');
});
