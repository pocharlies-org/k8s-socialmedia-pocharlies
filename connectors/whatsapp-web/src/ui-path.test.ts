import test from 'node:test';
import assert from 'node:assert/strict';
import { createUiPath } from './ui-path';

test('QR UI URLs preserve the configured account prefix', () => {
  const uiPath = createUiPath('/accounts/personal');
  for (const path of ['/qr/page', '/qr', '/qr/renew', '/status', '/api/v1/manual-open/page']) {
    assert.equal(uiPath(path), `/accounts/personal${path}`);
    assert.equal(createUiPath('')(path), path);
    assert.equal(createUiPath('/accounts/personal/')(path), uiPath(path));
  }
});

test('UI path rejects HTML, script, traversal and external URL prefixes', () => {
  for (const prefix of ['accounts/personal', '//other.test', '/accounts/../x', '/x?y', '/x#y', "/x'", '/x"', '/x\\y', '/x%2fy']) {
    assert.throws(() => createUiPath(prefix), /UI_BASE_PATH/);
  }
});
