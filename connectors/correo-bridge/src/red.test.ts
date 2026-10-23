import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// DGX-1235: the core pod of the correo chart carries
// app.kubernetes.io/component=core (measured live in ns correo and in the
// 0.7.0 render). A selector on any other component leaves the bridge
// unreachable from the core and the core's 8081 unreachable from the bridge.
const SELECTOR_NUCLEO = '{ app.kubernetes.io/name: correo, app.kubernetes.io/component: core }';

test('NetworkPolicy: ingress and egress select the core pod by its real labels', () => {
  const yaml = readFileSync(join(__dirname, '..', '..', '..', 'k8s', 'base', 'correo-bridge.yaml'), 'utf-8');
  const politicas = yaml.split(/^---$/m).filter(d => /kind:\s*NetworkPolicy/.test(d));
  for (const nombre of ['correo-bridge-ingress', 'correo-bridge-egress']) {
    const doc = politicas.find(d => d.includes(`name: ${nombre}`));
    assert.ok(doc, `${nombre} missing`);
    assert.ok(doc.includes(`podSelector: { matchLabels: ${SELECTOR_NUCLEO} }`), `${nombre} does not select the core pod`);
  }
  assert.ok(!yaml.includes('app.kubernetes.io/component: machine'), 'no pod of the correo chart has component=machine');
});
