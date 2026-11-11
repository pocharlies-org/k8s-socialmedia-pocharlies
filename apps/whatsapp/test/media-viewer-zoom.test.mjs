import test from 'node:test';
import assert from 'node:assert/strict';
import { clampImageTransform, zoomImageAt, installMediaViewerZoom } from '../public/media-viewer-zoom.mjs';

class Target {
  listeners = new Map();
  dataset = {};
  style = {};
  captures = new Set();
  addEventListener(type, listener, options) {
    const entries = this.listeners.get(type) || [];
    entries.push({ listener, options });
    this.listeners.set(type, entries);
  }
  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter(entry => entry.listener !== listener));
  }
  fire(type, init = {}) {
    const event = { type, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...init };
    for (const { listener } of this.listeners.get(type) || []) listener(event);
    return event;
  }
  setPointerCapture(id) { this.captures.add(id); }
  hasPointerCapture(id) { return this.captures.has(id); }
  releasePointerCapture(id) { this.captures.delete(id); }
}

function fixture() {
  const stage = new Target();
  const image = new Target();
  const overlay = new Target();
  const controls = { in: new Target(), out: new Target(), reset: new Target(), level: new Target() };
  let resize;
  let disconnected = false;
  stage.ownerDocument = { defaultView: { ResizeObserver: class {
    constructor(callback) { resize = callback; }
    observe() {}
    disconnect() { disconnected = true; }
  } } };
  stage.clientWidth = image.offsetWidth = 600;
  stage.clientHeight = image.offsetHeight = 400;
  stage.getBoundingClientRect = () => ({ left: 10, top: 20, width: stage.clientWidth, height: stage.clientHeight });
  const viewer = installMediaViewerZoom({ stage, image, overlay, controls });
  const pointer = (type, id, x, y, extra = {}) => stage.fire(type, { pointerId: id, button: 0, clientX: 310 + x, clientY: 220 + y, ...extra });
  const transform = () => {
    const [x, y, scale] = image.style.transform.match(/-?\d+(?:\.\d+)?/g).map(Number);
    return { x, y, scale };
  };
  return { stage, image, overlay, controls, viewer, pointer, transform, resize: () => resize(), disconnected: () => disconnected };
}

const bounds = { width: 600, height: 400, imageWidth: 600, imageHeight: 400 };

test('zoom preserves the image coordinate under a focal point', () => {
  const before = { scale: 2, x: -30, y: 20 };
  const focal = { x: 80, y: -40 };
  const after = zoomImageAt(before, 3, focal, bounds);
  assert.equal((focal.x - before.x) / before.scale, (focal.x - after.x) / after.scale);
  assert.equal((focal.y - before.y) / before.scale, (focal.y - after.y) / after.scale);
});

test('clamps pan to image edges, centres narrow axes, and limits zoom to 1..8', () => {
  assert.deepEqual(clampImageTransform({ scale: 2, x: 900, y: -900 }, bounds), { scale: 2, x: 300, y: -200 });
  assert.deepEqual(clampImageTransform({ scale: .1, x: 30, y: 50 }, bounds), { scale: 1, x: 0, y: 0 });
  const narrow = { ...bounds, imageWidth: 100 };
  assert.equal(clampImageTransform({ scale: 2, x: 30, y: 0 }, narrow).x, 0);
  assert.equal(clampImageTransform({ scale: 90, x: 0, y: 0 }, bounds).scale, 8);
});

test('wheel consumes pixels, lines and page units locally, including trackpad ctrl-wheel', () => {
  const f = fixture();
  const wheel = f.stage.fire('wheel', { clientX: 390, clientY: 180, deltaY: -100, deltaMode: 0, ctrlKey: true });
  assert.equal(wheel.prevented, true);
  assert.equal(f.stage.listeners.get('wheel')[0].options.passive, false);
  assert.ok(f.transform().scale > 1);
  assert.ok(f.transform().x < 0);
  assert.ok(f.transform().y > 0);
  f.viewer.reset();
  f.stage.fire('wheel', { clientX: 310, clientY: 220, deltaY: -1, deltaMode: 1 });
  assert.equal(f.transform().scale, Math.exp(16 * .002));
  f.viewer.reset();
  f.stage.fire('wheel', { clientX: 310, clientY: 220, deltaY: -1, deltaMode: 2 });
  assert.equal(f.transform().scale, Math.exp(400 * .002));
});

test('pinch follows both distance and midpoint, then continues one-finger pan without jumping', () => {
  const f = fixture();
  f.pointer('pointerdown', 1, -50, 0);
  f.pointer('pointerdown', 2, 50, 0);
  f.pointer('pointermove', 1, -90, 20);
  f.pointer('pointermove', 2, 110, 20);
  assert.deepEqual(f.transform(), { x: 10, y: 20, scale: 2 });
  f.pointer('pointerup', 2, 110, 20);
  assert.deepEqual([...f.stage.captures], [1]);
  f.pointer('pointermove', 1, -70, 30);
  assert.deepEqual(f.transform(), { x: 30, y: 30, scale: 2 });
  f.pointer('pointerup', 1, -70, 30);
  assert.equal(f.stage.dataset.dragging, 'false');
});

test('pan clamps at edges and cancelled or lost pointers cannot keep dragging', () => {
  const f = fixture();
  f.viewer.handleKey({ key: '+', preventDefault() {} });
  f.pointer('pointerdown', 1, 0, 0);
  f.pointer('pointermove', 1, 999, -999);
  assert.deepEqual(f.transform(), { x: 75, y: -50, scale: 1.25 });
  f.pointer('pointercancel', 1, 999, -999);
  f.pointer('pointermove', 1, 0, 0);
  assert.deepEqual(f.transform(), { x: 75, y: -50, scale: 1.25 });
  assert.equal(f.stage.captures.size, 0);
  f.pointer('pointerdown', 2, 0, 0);
  f.pointer('lostpointercapture', 2, 0, 0);
  assert.equal(f.stage.dataset.dragging, 'false');
});

test('reset releases active pointers and restores controls and percentage', () => {
  const f = fixture();
  f.controls.in.fire('click');
  assert.equal(f.controls.level.textContent, '125%');
  assert.equal(f.controls.out.disabled, false);
  f.pointer('pointerdown', 1, 0, 0);
  f.controls.reset.fire('click');
  assert.deepEqual(f.transform(), { x: 0, y: 0, scale: 1 });
  assert.equal(f.stage.captures.size, 0);
  assert.equal(f.controls.reset.disabled, true);
  assert.equal(f.controls.level.textContent, '100%');
  f.pointer('pointermove', 1, 80, 40);
  assert.equal(f.stage.dataset.zoom, '1');
});

test('keyboard controls consume only supported unmodified keys and stop at zoom limits', () => {
  const f = fixture();
  assert.equal(f.viewer.handleKey({ key: '+', ctrlKey: true }), false);
  assert.equal(f.viewer.handleKey({ key: 'ArrowRight' }), false);
  for (let i = 0; i < 20; i++) assert.equal(f.viewer.handleKey({ key: '+', preventDefault() {} }), true);
  assert.equal(f.stage.dataset.zoom, '8');
  assert.equal(f.controls.in.disabled, true);
  f.viewer.handleKey({ key: '-', preventDefault() {} });
  assert.equal(f.stage.dataset.zoom, '6.4');
  f.viewer.handleKey({ key: '0', preventDefault() {} });
  assert.equal(f.stage.dataset.zoom, '1');
});

test('image load and resize clamp transforms to current contained image dimensions', () => {
  const f = fixture();
  f.controls.in.fire('click');
  f.pointer('pointerdown', 1, 0, 0);
  f.pointer('pointermove', 1, 75, 50);
  f.pointer('pointerup', 1, 75, 50);
  f.image.offsetWidth = 200;
  f.image.fire('load');
  assert.equal(f.transform().x, 0);
  f.stage.clientHeight = 600;
  f.resize();
  assert.equal(f.transform().y, 0);
});

test('native Safari pinch is prevented across viewer while single touch controls remain usable', () => {
  const f = fixture();
  assert.equal(f.overlay.fire('gesturestart').prevented, true);
  assert.equal(f.overlay.fire('gesturechange').prevented, true);
  assert.equal(f.overlay.fire('touchmove', { touches: [{}, {}] }).prevented, true);
  assert.equal(f.overlay.fire('touchmove', { touches: [{}] }).prevented, false);
  f.overlay.fire('touchstart', { touches: [{}, {}] });
  assert.equal(f.overlay.fire('click').stopped, true);
  f.overlay.fire('pointerdown');
  assert.equal(f.overlay.fire('click').stopped, false);
});

test('dispose releases captures, disconnects observers and removes every listener', () => {
  const f = fixture();
  f.controls.in.fire('click');
  f.pointer('pointerdown', 1, 0, 0);
  f.viewer.dispose();
  f.viewer.dispose();
  assert.equal(f.disconnected(), true);
  assert.equal(f.stage.captures.size, 0);
  for (const target of [f.stage, f.image, f.overlay, ...Object.values(f.controls)]) {
    assert.equal([...target.listeners.values()].flat().length, 0);
  }
  f.controls.in.fire('click');
  f.resize();
  f.image.fire('load');
  assert.equal(f.stage.dataset.zoom, '1.25');
});
