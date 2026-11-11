const heightProperty = '--mobile-viewport-height';
const topProperty = '--mobile-viewport-top';
const bottomProperty = '--mobile-viewport-bottom-inset';
export const mobileViewportQuery = '(max-width: 760px), (max-width: 1024px) and (max-height: 500px) and (pointer: coarse)';

function hasKeyboardFocus(document) {
  const element = document.activeElement;
  if (!element || element.disabled || element.readOnly) return false;
  if (element.isContentEditable || element.tagName === 'TEXTAREA') return true;
  return element.tagName === 'INPUT' && !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(element.type);
}

export function installMobileViewport(window, document) {
  const style = document.documentElement.style;
  const mobile = window.matchMedia(mobileViewportQuery);
  const viewport = window.visualViewport;
  const installedIPhone = window.navigator?.standalone === true && /iPhone|iPod/.test(window.navigator.userAgent || '');
  const listeners = [];
  const timers = new Set();
  let unfocusedHeight = 0;
  let keyboardVisible = false;

  function clearTimers() {
    for (const timer of timers) window.clearTimeout(timer);
    timers.clear();
  }

  function update() {
    if (!mobile.matches) {
      style.removeProperty(heightProperty);
      style.removeProperty(topProperty);
      style.removeProperty(bottomProperty);
      unfocusedHeight = 0;
      keyboardVisible = false;
      clearTimers();
      return;
    }
    // Pinch zoom in the image viewer must not resize the underlying app.
    if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
    const layoutHeight = window.innerHeight;
    const measuredHeight = viewport?.height ?? layoutHeight;
    if (!Number.isFinite(measuredHeight) || measuredHeight <= 0) return;
    const availableHeight = Number.isFinite(layoutHeight) && layoutHeight > 0 ? layoutHeight : measuredHeight;
    // Screen dimensions do not describe the drawable PWA canvas. A previous
    // height can identify a keyboard, but must never enlarge that canvas.
    const keyboard = hasKeyboardFocus(document) && Math.max(availableHeight, unfocusedHeight) - measuredHeight > 100;
    const keyboardClosed = keyboardVisible && !keyboard;
    keyboardVisible = keyboard;
    const height = keyboard ? measuredHeight : installedIPhone ? Math.min(availableHeight, measuredHeight) : availableHeight;
    if (!keyboard) unfocusedHeight = height;
    const top = keyboard ? Math.max(0, viewport?.offsetTop || 0) : 0;
    style.setProperty(heightProperty, `${height}px`);
    style.setProperty(topProperty, `${top}px`);
    if (keyboard) style.setProperty(bottomProperty, '0px');
    else {
      style.removeProperty(bottomProperty);
      // Only content panes scroll. WebKit may scroll the root to reveal an
      // input even with overflow:hidden, leaving headers outside hit testing.
      if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
    }
    if (keyboardClosed) scheduleMeasurements();
  }

  function scheduleMeasurements() {
    clearTimers();
    if (!mobile.matches) return;
    // Resample after WebKit's keyboard/chrome animations, including events
    // whose final metrics arrive without a final viewport resize notification.
    for (const delay of [350, 700, 1200]) {
      const timer = window.setTimeout(() => {
        timers.delete(timer);
        update();
      }, delay);
      timers.add(timer);
    }
  }

  function settle() {
    update();
    scheduleMeasurements();
  }

  function focus() {
    if (!hasKeyboardFocus(document)) {
      settle();
      return;
    }
    clearTimers();
    update();
  }

  function rotate() {
    unfocusedHeight = 0;
    keyboardVisible = false;
    settle();
  }

  function listen(target, type, handler) {
    if (!target) return;
    target.addEventListener(type, handler);
    listeners.push(() => target.removeEventListener(type, handler));
  }

  listen(viewport, 'resize', update);
  listen(viewport, 'scroll', update);
  listen(window, 'resize', update);
  listen(window, 'scroll', update);
  listen(window, 'orientationchange', rotate);
  listen(window, 'pageshow', () => settle());
  listen(document, 'visibilitychange', () => {
    if (document.visibilityState === 'visible') settle();
  });
  listen(document, 'focusin', focus);
  listen(document, 'focusout', settle);
  listen(mobile, 'change', update);
  update();

  return () => {
    clearTimers();
    for (const remove of listeners) remove();
    style.removeProperty(heightProperty);
    style.removeProperty(topProperty);
    style.removeProperty(bottomProperty);
  };
}
