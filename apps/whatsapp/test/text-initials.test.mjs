import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {firstGrapheme, initialsOf} from '../public/text-initials.mjs';
import {publicCommunity} from '../lib/communities.mjs';

test('las iniciales no parten graphemes compuestos (UX #45.2)', () => {
  assert.equal(firstGrapheme('🇪🇸 España'), '🇪🇸');
  assert.equal(initialsOf('🐜 Formigues'), '🐜F');
  assert.equal(initialsOf('Ana Ruiz'), 'AR');
  assert.equal(initialsOf('Pedro'), 'PE');
  assert.equal(initialsOf('   ', '?'), '?');
});

test('una comunidad se subtitula por sus grupos (UX #45.1)', async () => {
  const community = publicCommunity({
    id: '123@g.us', name: 'Casa', participantCount: 9,
    linkedGroups: [{id: 'a@g.us', name: 'A'}, {id: 'b@g.us', name: 'B'}],
  });
  assert.equal(community.groupCount, 2);
  assert.equal(publicCommunity({id: '123@g.us', name: 'Casa'}).groupCount, null);
  const ui = await readFile(new URL('../public/communities-ui.mjs', import.meta.url), 'utf8');
  assert.match(ui, /displayGroups\(community\.groupCount\)/);
  assert.match(ui, /displayGroups\(linkedGroups\.length\)/);
  assert.match(ui, /N grupo\(s\)|\? 'grupo' : 'grupos'/);
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /Intl\.Segmenter/);
});
