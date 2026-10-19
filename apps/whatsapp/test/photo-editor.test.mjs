import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_EDIT_DIM, EDIT_MEMORY_BUDGET, MIN_SNAPSHOTS, historyLimitFor, editCapNotice,
  editableImage, outputFileName, stickerFileName, rotatedSize, clampCrop, isFullCrop, History,
} from '../public/photo-editor.mjs';
import {attachmentError, MAX_ATTACHMENT_BYTES} from '../public/composer-attachment.mjs';

const file = type => ({type});

test('editableImage only accepts editable raster types', () => {
  assert.equal(editableImage(file('image/jpeg')), true);
  assert.equal(editableImage(file('image/png')), true);
  assert.equal(editableImage(file('image/webp')), true);
  assert.equal(editableImage(file('image/gif')), false);
  assert.equal(editableImage(file('video/mp4')), false);
  assert.equal(editableImage(file('')), false);
  assert.equal(editableImage(undefined), false);
  assert.equal(editableImage(file('image/png;base64')), false);
});

test('outputFileName strips the original extension and marks the edit', () => {
  assert.equal(outputFileName('via.jpg'), 'via-editada.jpg');
  assert.equal(outputFileName('mi foto.PNG'), 'mi foto-editada.jpg');
  assert.equal(outputFileName('sin-extension'), 'sin-extension-editada.jpg');
  assert.equal(outputFileName(''), 'imagen-editada.jpg');
  assert.equal(outputFileName('folder/x.webp'), 'folder/x-editada.jpg');
});

test('stickerFileName marks a WebP derived from the source photo', () => {
  assert.equal(stickerFileName('foto.png'), 'foto-sticker.webp');
  assert.equal(stickerFileName('sin-extension'), 'sin-extension-sticker.webp');
});

test('rotatedSize swaps dimensions only on odd quarter turns', () => {
  assert.deepEqual(rotatedSize(100, 80, 1), {width: 80, height: 100});
  assert.deepEqual(rotatedSize(100, 80, -1), {width: 80, height: 100});
  assert.deepEqual(rotatedSize(100, 80, 2), {width: 100, height: 80});
  assert.deepEqual(rotatedSize(100, 80, 0), {width: 100, height: 80});
  assert.deepEqual(rotatedSize(100, 80, 4), {width: 100, height: 80});
  assert.deepEqual(rotatedSize(100, 80, 5), {width: 80, height: 100});
});

test('clampCrop keeps the selection inside the image and above the minimum', () => {
  assert.deepEqual(clampCrop({x: -20, y: -30, width: 500, height: 500}, 100, 80), {x: 0, y: 0, width: 100, height: 80});
  const small = clampCrop({x: 10, y: 10, width: 2, height: 2}, 100, 80);
  assert.equal(small.width, 16);
  assert.equal(small.height, 16);
  assert.ok(small.x >= 0 && small.y >= 0);
  assert.ok(small.x + small.width <= 100 && small.y + small.height <= 80);
  const overflowing = clampCrop({x: 90, y: 70, width: 100, height: 100}, 100, 80);
  assert.deepEqual(overflowing, {x: 0, y: 0, width: 100, height: 80});
});

test('isFullCrop detects an untouched full-frame selection', () => {
  assert.equal(isFullCrop({x: 0, y: 0, width: 100, height: 80}, 100, 80), true);
  assert.equal(isFullCrop({x: 5, y: 0, width: 95, height: 80}, 100, 80), false);
  assert.equal(isFullCrop({x: 0, y: 0, width: 50, height: 80}, 100, 80), false);
});

test('History drives undo/redo and truncates the future on a new edit', () => {
  const history = new History();
  history.reset('base');
  assert.equal(history.canUndo(), false);
  assert.equal(history.canRedo(), false);
  history.push('a');
  history.push('b');
  assert.equal(history.current, 'b');
  assert.equal(history.undo(), 'a');
  assert.equal(history.undo(), 'base');
  assert.equal(history.undo(), undefined);
  assert.equal(history.redo(), 'a');
  history.push('c');
  assert.equal(history.canRedo(), false, 'a new edit must drop the redo branch');
  assert.equal(history.current, 'c');
});

test('History caps retained states', () => {
  const history = new History(3);
  history.reset(0);
  for (let i = 1; i <= 10; i += 1) history.push(i);
  assert.equal(history.states.length, 3);
  assert.equal(history.current, 10);
  assert.equal(history.undo(), 9);
  assert.equal(history.undo(), 8);
  assert.equal(history.undo(), undefined, 'the oldest retained state is the floor');
});

test('a normal edit is not downscaled: only a high canvas ceiling is enforced', () => {
  assert.equal(MAX_EDIT_DIM, 4096);
  const scale = dim => Math.min(1, MAX_EDIT_DIM / Math.max(...dim));
  assert.equal(scale([120, 80]), 1, 'small images keep full resolution');
  assert.equal(scale([1920, 1080]), 1, 'camera captures keep full resolution');
  assert.equal(scale([4000, 3000]), 1, 'typical photos keep full resolution');
  assert.ok(scale([8000, 6000]) < 1, 'only oversized canvases are reduced');
  assert.ok(editCapNotice().includes('4096'), 'the cap is surfaced to the user');
});

test('undo history is bounded in bytes, not just snapshot count', () => {
  const rgbaBytes = (w, h) => w * h * 4;
  assert.equal(historyLimitFor(120, 80), 15, 'tiny images keep the full stack');
  assert.equal(historyLimitFor(1920, 1080), 15, 'camera-size images keep the full stack');
  const big = historyLimitFor(4096, 4096);
  assert.ok(big < 15 && big >= MIN_SNAPSHOTS, `4096x4096 keeps ${big} snapshots`);
  assert.ok(big * rgbaBytes(4096, 4096) <= EDIT_MEMORY_BUDGET * 1.05,
    `retained bytes ${big * rgbaBytes(4096, 4096)} exceed the ${EDIT_MEMORY_BUDGET} budget`);
  const mid = historyLimitFor(3000, 3000);
  assert.ok(mid * rgbaBytes(3000, 3000) <= EDIT_MEMORY_BUDGET * 1.05, `3000x3000 keeps ${mid}`);
  assert.equal(historyLimitFor(0, 0), 15);
});

test('History.clear drops every retained snapshot on close', () => {
  const history = new History();
  history.reset('base');
  history.push('a');
  history.push('b');
  history.clear();
  assert.equal(history.states.length, 0);
  assert.equal(history.current, undefined);
  assert.equal(history.canUndo(), false);
  assert.equal(history.canRedo(), false);
});

test('applying an edit revalidates size and type through the attachment guard', () => {
  const oversize = {name: 'grande-editada.jpg', type: 'image/jpeg', size: MAX_ATTACHMENT_BYTES + 1};
  assert.equal(attachmentError(oversize), 'El archivo supera el límite de 10 MiB.');
  const wrongType = {name: 'editada.bin', type: 'application/octet-stream', size: 1000};
  assert.equal(attachmentError(wrongType), 'Este tipo de archivo no se puede enviar.');
  const valid = {name: 'bien-editada.jpg', type: 'image/jpeg', size: 4096};
  assert.equal(attachmentError(valid), '');
});
