import test from 'node:test';
import assert from 'node:assert/strict';
import {DRAFT_INSTRUCTION, DRAFT_LABEL, normalizeDraftText} from '../public/draft-suggest.mjs';

test('draft instruction is explicit and bounded', () => {
  assert.equal(typeof DRAFT_INSTRUCTION, 'string');
  assert.match(DRAFT_INSTRUCTION, /^Propón un mensaje/);
  assert.match(DRAFT_INSTRUCTION, /sin explicaciones/i);
  assert.ok(DRAFT_INSTRUCTION.length < 300);
});

test('the thread shows a short label instead of the full instruction', () => {
  assert.match(DRAFT_LABEL, /^Propón un mensaje/);
  assert.notEqual(DRAFT_LABEL, DRAFT_INSTRUCTION);
  assert.ok(DRAFT_LABEL.length < 40);
});

test('normalizeDraftText removes a whole-message code fence', () => {
  assert.equal(normalizeDraftText('```text\nVoy tarde, llego en 10\n```'), 'Voy tarde, llego en 10');
  assert.equal(normalizeDraftText('```\nSin lenguaje\n```'), 'Sin lenguaje');
  assert.equal(normalizeDraftText('```text\nuno\n\ndos\n```'), 'uno\n\ndos');
});

test('normalizeDraftText removes only wrapping quotes', () => {
  assert.equal(normalizeDraftText('"Hola, ¿qué tal?"'), 'Hola, ¿qué tal?');
  assert.equal(normalizeDraftText('“Buenos días”'), 'Buenos días');
  assert.equal(normalizeDraftText('«Anotado»'), 'Anotado');
  assert.equal(normalizeDraftText('Él dijo "hola" y se fue'), 'Él dijo "hola" y se fue');
  assert.equal(normalizeDraftText('"sin cerrar'), '"sin cerrar');
  assert.equal(normalizeDraftText('""'), '');
});

test('normalizeDraftText keeps the message body and ignores non-strings', () => {
  assert.equal(normalizeDraftText('  \n Respuesta \n\ncon dos líneas \n '), 'Respuesta\n\ncon dos líneas');
  assert.equal(normalizeDraftText('👍'), '👍');
  assert.equal(normalizeDraftText(''), '');
  assert.equal(normalizeDraftText('   '), '');
  assert.equal(normalizeDraftText(null), '');
  assert.equal(normalizeDraftText(undefined), '');
  assert.equal(normalizeDraftText(42), '');
});
