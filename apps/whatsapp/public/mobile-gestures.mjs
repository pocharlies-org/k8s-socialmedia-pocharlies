// Safari can ignore viewport scale limits. Dialogs live outside the app shell,
// so guard the document while leaving the image viewer free to zoom.
const inImageViewer = target => target instanceof Element && Boolean(target.closest('.media-viewer'));
for (const type of ['gesturestart', 'gesturechange']) {
  document.addEventListener(type, event => {
    if (!inImageViewer(event.target)) event.preventDefault();
  }, {passive: false});
}
document.addEventListener('touchmove', event => {
  if (event.touches.length > 1 && !inImageViewer(event.target)) event.preventDefault();
}, {passive: false});
