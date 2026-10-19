const MIN_ZOOM = 1;
const MAX_ZOOM = 8;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function clampImageTransform(state, bounds) {
  const scale = clamp(state.scale, MIN_ZOOM, MAX_ZOOM);
  const limitX = Math.max(0, (bounds.imageWidth * scale - bounds.width) / 2);
  const limitY = Math.max(0, (bounds.imageHeight * scale - bounds.height) / 2);
  return { scale, x: clamp(state.x, -limitX, limitX), y: clamp(state.y, -limitY, limitY) };
}

export function zoomImageAt(state, scale, point, bounds) {
  const nextScale = clamp(scale, MIN_ZOOM, MAX_ZOOM);
  const ratio = nextScale / state.scale;
  return clampImageTransform({
    scale: nextScale,
    x: point.x - (point.x - state.x) * ratio,
    y: point.y - (point.y - state.y) * ratio,
  }, bounds);
}

/** Image transforms use stage-centred coordinates; the page viewport never changes. */
export function installMediaViewerZoom({ stage, image, overlay, controls }) {
  let state = { scale: 1, x: 0, y: 0 };
  let disposed = false;
  let suppressClick = false;
  let gesture = null;
  const pointers = new Map();
  const removers = [];
  const listen = (target, type, handler, options) => {
    target?.addEventListener?.(type, handler, options);
    removers.push(() => target?.removeEventListener?.(type, handler, options));
  };
  const bounds = () => ({
    width: stage.clientWidth || 0, height: stage.clientHeight || 0,
    imageWidth: image.offsetWidth || 0, imageHeight: image.offsetHeight || 0,
  });
  const point = event => {
    const rect = stage.getBoundingClientRect?.() || { left: 0, top: 0, width: 0, height: 0 };
    return { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 };
  };
  const render = next => {
    if (disposed) return;
    state = clampImageTransform(next, bounds());
    if (image.style) image.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.scale})`;
    stage.dataset.zoom = String(state.scale);
    stage.dataset.zoomed = String(state.scale > 1);
    stage.dataset.dragging = String(pointers.size > 0 && state.scale > 1);
    controls.level.textContent = `${Math.round(state.scale * 100)}%`;
    controls.out.disabled = state.scale <= MIN_ZOOM;
    controls.in.disabled = state.scale >= MAX_ZOOM;
    controls.reset.disabled = state.scale === MIN_ZOOM && state.x === 0 && state.y === 0;
  };
  const pair = () => {
    const [a, b] = [...pointers.values()];
    if (!b) return null;
    return { midpoint: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, distance: Math.hypot(a.x - b.x, a.y - b.y) };
  };
  const beginGesture = () => {
    gesture = { state: { ...state }, pair: pair(), point: pointers.values().next().value };
  };
  const release = id => {
    try { if (stage.hasPointerCapture?.(id)) stage.releasePointerCapture(id); } catch { /* A removed pointer may already have lost capture. */ }
  };
  const clearPointers = () => {
    const ids = [...pointers.keys()];
    pointers.clear();
    gesture = null;
    ids.forEach(release);
  };
  const reset = () => {
    clearPointers();
    render({ scale: 1, x: 0, y: 0 });
  };
  const zoom = (scale, focal = { x: 0, y: 0 }) => {
    render(zoomImageAt(state, scale, focal, bounds()));
    if (pointers.size) beginGesture();
  };
  listen(stage, 'pointerdown', event => {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    pointers.set(event.pointerId, point(event));
    try { stage.setPointerCapture?.(event.pointerId); } catch { /* Synthetic pointers cannot be captured. */ }
    beginGesture();
    render(state);
  });
  listen(stage, 'pointermove', event => {
    if (!pointers.has(event.pointerId)) return;
    event.preventDefault();
    pointers.set(event.pointerId, point(event));
    const current = pair();
    if (current && gesture?.pair?.distance > 0) {
      suppressClick = true;
      const scale = clamp(gesture.state.scale * current.distance / gesture.pair.distance, MIN_ZOOM, MAX_ZOOM);
      const ratio = scale / gesture.state.scale;
      // Preserve the image point under the initial pinch midpoint as both fingers move.
      render({ scale,
        x: current.midpoint.x - (gesture.pair.midpoint.x - gesture.state.x) * ratio,
        y: current.midpoint.y - (gesture.pair.midpoint.y - gesture.state.y) * ratio,
      });
    } else if (!current && gesture?.point && state.scale > 1) {
      const currentPoint = pointers.values().next().value;
      if (Math.hypot(currentPoint.x - gesture.point.x, currentPoint.y - gesture.point.y) > 3) suppressClick = true;
      render({ ...state, x: gesture.state.x + currentPoint.x - gesture.point.x, y: gesture.state.y + currentPoint.y - gesture.point.y });
    }
  });
  const endPointer = event => {
    if (!pointers.delete(event.pointerId)) return;
    release(event.pointerId);
    beginGesture();
    render(state);
  };
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) listen(stage, type, endPointer);
  listen(stage, 'wheel', event => {
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.clientHeight : 1;
    zoom(state.scale * Math.exp(-clamp(event.deltaY * unit, -600, 600) * .002), point(event));
  }, { passive: false });
  listen(stage, 'dblclick', event => { event.preventDefault(); zoom(state.scale > 1 ? 1 : 2, point(event)); });
  listen(image, 'dragstart', event => event.preventDefault());
  listen(image, 'load', () => render(state));
  listen(controls.in, 'click', () => zoom(state.scale * 1.25));
  listen(controls.out, 'click', () => zoom(state.scale / 1.25));
  listen(controls.reset, 'click', reset);
  listen(overlay, 'pointerdown', () => { if (!pointers.size) suppressClick = false; }, { capture: true });
  listen(overlay, 'touchstart', event => { if (event.touches?.length > 1) suppressClick = true; }, { passive: true });
  listen(overlay, 'click', event => {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  }, { capture: true });
  // Safari's legacy gesture events can bypass touch-action on the viewer controls.
  for (const type of ['gesturestart', 'gesturechange']) listen(overlay, type, event => event.preventDefault(), { passive: false });
  listen(overlay, 'touchmove', event => { if (event.touches?.length > 1) event.preventDefault(); }, { passive: false });
  const ResizeObserverRef = stage.ownerDocument?.defaultView?.ResizeObserver;
  const observer = ResizeObserverRef ? new ResizeObserverRef(() => { render(state); if (pointers.size) beginGesture(); }) : null;
  observer?.observe(stage);
  observer?.observe(image);
  render(state);
  return {
    reset,
    handleKey(event) {
      if (event.altKey || event.ctrlKey || event.metaKey) return false;
      if (['+', '=', 'Add'].includes(event.key)) zoom(state.scale * 1.25);
      else if (['-', '_', 'Subtract'].includes(event.key)) zoom(state.scale / 1.25);
      else if (event.key === '0') reset();
      else return false;
      event.preventDefault();
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      removers.forEach(remove => remove());
      observer?.disconnect();
      clearPointers();
    },
  };
}
