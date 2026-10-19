import test from 'node:test';
import assert from 'node:assert/strict';
import { installMobileViewport } from '../public/mobile-viewport.mjs';

function fixture({ visualViewport = true, standalone = false } = {}) {
  const properties = new Map();
  const document = Object.assign(new EventTarget(), {
    activeElement: null,
    visibilityState: 'visible',
    documentElement: { style: {
      setProperty: (name, value) => properties.set(name, value),
      removeProperty: name => properties.delete(name),
    } },
  });
  const viewport = Object.assign(new EventTarget(), { height: 800, offsetTop: 0, scale: 1 });
  const mobile = Object.assign(new EventTarget(), { matches: true });
  const timers = new Map();
  let now = 0;
  let nextTimer = 0;
  const window = Object.assign(new EventTarget(), {
    visualViewport: visualViewport ? viewport : undefined,
    innerHeight: 800,
    navigator: {standalone, userAgent: 'iPhone'},
    screen: {height: 800, width: 390},
    orientation: 0,
    scrollX: 0, scrollY: 0,
    scrollTo(x, y) { this.scrollX = x; this.scrollY = y; },
    matchMedia: () => mobile,
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, time: now + delay }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  const emit = (target, type) => target.dispatchEvent(new Event(type));
  function advance(delay) {
    now += delay;
    for (const [id, timer] of [...timers]) {
      if (timer.time <= now && timers.delete(id)) timer.callback();
    }
  }
  const dispose = installMobileViewport(window, document);
  return { document, window, viewport, mobile, timers, properties, dispose, emit, advance,
    height: () => properties.get('--mobile-viewport-height'),
    top: () => properties.get('--mobile-viewport-top'),
    focus(tagName = 'INPUT') { document.activeElement = { tagName, type: 'text' }; emit(document, 'focusin'); },
    blur() { document.activeElement = null; emit(document, 'focusout'); },
    resize(height, offsetTop = 0) { Object.assign(viewport, { height, offsetTop }); emit(viewport, 'resize'); },
  };
}

test('focused keyboard shrink and pan fit the app; blur immediately clears stale metrics', () => {
  const f = fixture();
  assert.equal(f.height(), '800px');
  f.focus();
  f.resize(460, 90);
  assert.equal(f.height(), '460px');
  assert.equal(f.top(), '90px');
  assert.equal(f.properties.get('--mobile-viewport-bottom-inset'), '0px');
  f.window.scrollY = 80;
  f.blur();
  assert.equal(f.height(), '800px');
  assert.equal(f.top(), '0px');
  assert.equal(f.window.scrollY, 0);
  assert.equal(f.properties.has('--mobile-viewport-bottom-inset'), false);
  f.resize(460, 90);
  f.advance(1200);
  assert.equal(f.height(), '800px', 'stale events cannot shrink the unfocused app');
});

test('installed iPhone fits the drawable viewport even when the screen is taller', () => {
  const f = fixture({standalone: true});
  f.focus('TEXTAREA');
  f.resize(460, 90);
  f.window.innerHeight = 740;
  f.resize(740, 0);
  assert.equal(f.height(), '740px', 'controls must not extend into a non-drawable screen band');
  f.blur();
  f.advance(1200);
  assert.equal(f.height(), '740px');
  assert.equal(f.top(), '0px');
  f.focus('TEXTAREA');
  f.resize(450, 30);
  assert.equal(f.height(), '450px', 'a second keyboard cycle still uses its visible area');
  f.resize(740, 24);
  assert.equal(f.height(), '740px');
  assert.equal(f.top(), '0px');
  f.advance(1200);
  assert.equal(f.document.activeElement.tagName, 'TEXTAREA', 'settlement must not forcibly blur or reflow the view');
  f.blur();
  assert.equal(f.height(), '740px');
});

test('installed iPhone landscape fits measured bounds instead of the physical screen axis', () => {
  const f = fixture({standalone: true});
  f.window.orientation = 90;
  f.window.innerHeight = 330;
  f.viewport.height = 330;
  f.emit(f.window, 'orientationchange');
  f.advance(1200);
  assert.equal(f.height(), '330px');
});

test('installed iPhone never enlarges a smaller visual canvas to innerHeight', () => {
  const f = fixture({standalone: true});
  f.resize(740, 24);
  assert.equal(f.height(), '740px');
  assert.equal(f.top(), '0px');
  f.focus();
  f.resize(450, 20);
  assert.equal(f.height(), '450px');
  f.resize(740, 24);
  f.advance(1200);
  assert.equal(f.height(), '740px');
  assert.equal(f.top(), '0px');
});

test('dismissal to a new smaller layout height never sticks to the old baseline', () => {
  const f = fixture();
  f.focus();
  f.resize(460, 90);
  f.blur();
  f.window.innerHeight = 780;
  f.resize(756, 24);
  f.advance(1200);
  assert.equal(f.height(), '780px');
  assert.equal(f.top(), '0px');
  f.window.innerHeight = 812;
  f.emit(f.window, 'resize');
  assert.equal(f.height(), '812px');
});

test('dismissal with the input still focused ignores small WebKit phantom insets', () => {
  const f = fixture();
  f.focus();
  f.resize(500, 20);
  f.window.scrollY = 24;
  f.resize(776, 24);
  assert.equal(f.height(), '800px');
  assert.equal(f.top(), '0px');
  assert.equal(f.window.scrollY, 0);
  assert.equal(f.document.activeElement.tagName, 'INPUT');
});

test('input transfer keeps keyboard bounds and prevents recovery timers from resizing it', () => {
  const f = fixture();
  f.focus();
  f.resize(450, 30);
  f.blur();
  f.focus('TEXTAREA');
  f.advance(1500);
  assert.equal(f.height(), '450px');
  assert.equal(f.top(), '30px');
  assert.equal(f.timers.size, 0);
});

test('root scrolling is reset outside the keyboard, without resetting content panes', () => {
  const f = fixture();
  Object.assign(f.window, {scrollX: 2, scrollY: 59});
  f.emit(f.window, 'scroll');
  assert.equal(f.window.scrollX, 0);
  assert.equal(f.window.scrollY, 0);
  f.focus();
  f.resize(500, 40);
  f.window.scrollY = 20;
  f.emit(f.window, 'scroll');
  assert.equal(f.window.scrollY, 20, 'do not fight native keyboard panning');
});

test('pageshow and foreground resample current layout rather than old visual height', () => {
  for (const type of ['pageshow', 'visibilitychange']) {
    const f = fixture();
    f.window.innerHeight = 700;
    f.viewport.height = 670;
    f.emit(type === 'pageshow' ? f.window : f.document, type);
    f.advance(1200);
    assert.equal(f.height(), '700px');
    f.window.innerHeight = 730;
    f.emit(type === 'pageshow' ? f.window : f.document, type);
    f.window.innerHeight = 750;
    f.advance(700);
    assert.equal(f.height(), '750px', 'late metrics without resize are resampled');
  }
});

test('rotation uses current landscape height; desktop removes all mobile overrides', () => {
  const f = fixture();
  f.focus();
  f.resize(460);
  f.blur();
  f.window.innerHeight = 360;
  f.viewport.height = 360;
  f.emit(f.window, 'orientationchange');
  f.advance(1200);
  assert.equal(f.height(), '360px');
  f.mobile.matches = false;
  f.emit(f.mobile, 'change');
  assert.equal(f.properties.size, 0);
  assert.equal(f.timers.size, 0);
  f.emit(f.document, 'focusout');
  f.emit(f.window, 'pageshow');
  assert.equal(f.timers.size, 0);
});

test('image viewer zoom does not resize the underlying app', () => {
  const f = fixture();
  f.viewport.scale = 2;
  f.resize(400, 100);
  assert.equal(f.height(), '800px');
  assert.equal(f.top(), '0px');
  f.viewport.scale = 1;
  f.window.innerHeight = 820;
  f.resize(820);
  assert.equal(f.height(), '820px');
});

test('fallback uses innerHeight; disposal cancels timers and removes listeners', () => {
  const f = fixture({visualViewport: false});
  f.window.innerHeight = 700;
  f.emit(f.window, 'resize');
  assert.equal(f.height(), '700px');
  f.blur();
  assert.ok(f.timers.size);
  f.dispose();
  assert.equal(f.properties.size, 0);
  assert.equal(f.timers.size, 0);
  f.emit(f.window, 'resize');
  f.emit(f.window, 'scroll');
  f.emit(f.document, 'focusout');
  f.advance(2000);
  assert.equal(f.properties.size, 0);
});
