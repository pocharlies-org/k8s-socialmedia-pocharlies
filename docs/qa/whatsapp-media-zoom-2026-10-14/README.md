# Attachment image viewer zoom

The existing image viewer now supports local 1..8x magnification with mouse
wheel/trackpad input, two-finger pinch, and bounded mouse/touch dragging. Zoom
keeps the cursor/pinch midpoint anchored to the image. Buttons and keyboard
`+`, `-`, `0` provide accessible controls; double-click toggles magnification.
Image navigation and reopening reset to fit. Escape/focus return, downloads,
gallery pagination and safe attachment URLs remain intact.

Transforms are limited to the clipped image stage. Native Safari gesture events
are prevented inside the viewer, while single-touch controls keep working.
Closing removes listeners, pointer captures and resize observers. Pan/pinch
does not activate backdrop-close through a trailing click.

Validation:

- Ten unit cases cover focal geometry, clamping, wheel delta modes, trackpad
  input, pinch-to-pan continuity, cancellation, reset, keyboard, resize,
  native gesture suppression and cleanup.
- Playwright at 1280x900 and 390x844 passed wheel zoom, mouse/touch drag,
  real Chromium CDP two-finger input, controls/keyboard, navigation reset,
  reopening and focus restoration, with zero browser errors.
- Underlying fixture bounds and `visualViewport.scale=1` remained unchanged.
- Existing renderer browser integration passed gallery navigation, pagination
  and keyboard focus after adding the new controls.
- Independent static review found no blocking defect; pinned contract checker
  accepted 106 entries with its existing unrelated missing-marker note.

Screenshots, traces and measured results here use synthetic gallery images,
not production chat content. Chromium CDP verifies browser touch handling;
native Safari on a physical iPhone has not been tested. The implementation uses
Pointer Events and local native-gesture prevention for that environment.

Published image digest, full suite result and runtime readback are recorded in
PR74 after deployment. This release changes only the web image.
