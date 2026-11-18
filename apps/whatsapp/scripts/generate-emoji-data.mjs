import {readFile, writeFile, mkdir, copyFile} from 'node:fs/promises';
import {resolve} from 'node:path';

// Regenerate from an unpacked `npm pack emojibase-data@17.0.0` package.
const source = process.argv[2];
if (!source) throw new Error('Pass the unpacked emojibase-data package directory');
const read = async path => JSON.parse(await readFile(resolve(source, path), 'utf8'));
const pkg = await read('package.json');
if (pkg.name !== 'emojibase-data' || pkg.version !== '17.0.0') throw new Error('Expected emojibase-data 17.0.0');
const english = new Map((await read('en/data.json')).map(item => [item.hexcode, item]));
const localized = await read('es/data.json');
const {groups} = await read('es/messages.json');
const items = localized.filter(item => Number.isInteger(item.group) && item.group !== 2)
  .sort((a, b) => a.order - b.order).map(item => {
    const en = english.get(item.hexcode);
    return {
      emoji: item.emoji, label: item.label, group: item.group,
      keywords: [...new Set([...(item.tags || []), en?.label, ...(en?.tags || [])].filter(Boolean))],
      ...(item.skins?.length ? {skins: item.skins.map(skin => ({emoji: skin.emoji, label: skin.label, tone: skin.tone}))} : {}),
    };
  });
const target = new URL('../public/emoji/', import.meta.url);
await mkdir(target, {recursive: true});
await writeFile(new URL('catalog-es.json', target), JSON.stringify({version: pkg.version, groups: groups.filter(group => group.order !== 2), items}) + '\n');
await copyFile(resolve(source, 'LICENSE'), new URL('LICENSE', target));
console.log(`Generated ${items.length} base emojis from Emojibase ${pkg.version}`);
