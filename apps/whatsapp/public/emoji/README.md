# Emoji catalog

`catalog-es.json` is generated from **emojibase-data 17.0.0** (MIT, see LICENSE),
using Spanish CLDR labels and English search keywords. Skin variants retain
their original Unicode sequences. Standalone components are excluded.

Source: https://github.com/milesj/emojibase

Regenerate from the application directory:

```sh
npm pack emojibase-data@17.0.0 --pack-destination /tmp
mkdir -p /tmp/socialmedia-emoji-source
tar -xzf /tmp/emojibase-data-17.0.0.tgz -C /tmp/socialmedia-emoji-source
node scripts/generate-emoji-data.mjs /tmp/socialmedia-emoji-source/package
```

The application loads this file from its own origin only when the picker opens.
No CDN or external search service receives user input.
