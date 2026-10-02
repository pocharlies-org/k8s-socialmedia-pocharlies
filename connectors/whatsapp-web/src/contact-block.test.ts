import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { ContactBlockError, readContactBlocked, setContactBlocked } from './contact-block';
import { BaileysClient } from './baileys-client';
import { createRouter } from './api/controller';
import { generateHMACSignature } from './api/auth';

test('provider block state is verified and repeated requests are idempotent across PN/LID', async () => {
  let list:string[]=[]; const calls:unknown[]=[];
  const socket={signalRepository:{lidMapping:{getLIDForPN:async()=> '777@lid'}},
    fetchBlocklist:async()=>list, updateBlockStatus:async(jid:string,action:string)=>{
      calls.push([jid,action]); list=action==='block'?['777@lid']:[];
    }};
  assert.deepEqual(await setContactBlocked(socket,'123@c.us',true),{blocked:true,changed:true,confirmed:true});
  assert.equal(await readContactBlocked(socket,'123@c.us'),true);
  assert.equal(await readContactBlocked({ ...socket, signalRepository:{lidMapping:{getPNForLID:async()=> '123@s.whatsapp.net'}} },'777@lid'),true);
  assert.equal(await readContactBlocked({ ...socket, signalRepository:{lidMapping:{getPNForLID:async()=> '123:0@s.whatsapp.net'}} },'777@lid'),true);
  assert.equal(await readContactBlocked({ ...socket, fetchBlocklist:async()=>['123@s.whatsapp.net'], signalRepository:{lidMapping:{getPNForLID:async()=> '123:0@s.whatsapp.net'}} },'777@lid'),true);
  assert.equal(await readContactBlocked({ ...socket, signalRepository:{lidMapping:{getPNForLID:async()=> 'unexpected-alias'}} },'777@lid'),true);
  assert.equal((await setContactBlocked(socket,'123@s.whatsapp.net',true)).changed,false);
  assert.equal(calls.length,1);
  await setContactBlocked(socket,'123@c.us',false);
  assert.equal((await setContactBlocked(socket,'123@c.us',false)).changed,false);
  assert.equal(calls.length,2);
  for(const chat of ['123@g.us','123@newsletter','other:123@c.us','status@broadcast'])
    await assert.rejects(setContactBlocked(socket,chat,true),/direct contact/);
  socket.updateBlockStatus=async()=>{};
  await assert.rejects(setContactBlocked(socket,'123@c.us',true),/not confirmed/);
});

test('block state read refuses a disconnected provider', async () => {
  await assert.rejects(BaileysClient.prototype.contactBlocked.call({sock:null,isConnected:()=>false} as any,'123@c.us'),
    (error:unknown)=>error instanceof Error && /not connected/.test(error.message));
});

test('connector requires HMAC, sending permission and a strict contact/boolean target', async () => {
  const previous={enable:process.env.ENABLE_SENDING,emergency:process.env.EMERGENCY_DISABLE_SENDING};
  const calls:unknown[]=[]; const secret='block-fixture';
  const app=express();app.use(express.json());app.use(createRouter({contactBlocked:async()=>true,blockContact:async(...args:unknown[])=>{
    calls.push(args);return {blocked:args[1],confirmed:true};
  }} as any,{} as any,secret));
  const server=app.listen(0,'127.0.0.1'); await new Promise<void>(r=>server.once('listening',r));
  const post=(chat:string,blocked:unknown,signed=true)=>{
    const body={blocked};const timestamp=Math.floor(Date.now()/1000);
    return fetch(`http://127.0.0.1:${(server.address() as any).port}/chats/${encodeURIComponent(chat)}/block`,{
      method:'POST',body:JSON.stringify(body),headers:{'content-type':'application/json',...(signed?{
        'x-connector-timestamp':String(timestamp),'x-connector-signature':generateHMACSignature(body,timestamp,secret)}:{})}});
  };
  const get=(chat:string,signed=true)=>{
    const timestamp=Math.floor(Date.now()/1000);
    return fetch(`http://127.0.0.1:${(server.address() as any).port}/chats/${encodeURIComponent(chat)}/block`,{
      headers:signed?{'x-connector-timestamp':String(timestamp),'x-connector-signature':generateHMACSignature({},timestamp,secret)}:{}});
  };
  try {
    assert.equal((await get('123@c.us',false)).status,401);
    assert.equal((await get('123@g.us')).status,400);
    assert.deepEqual(await (await get('123@c.us')).json(),{ok:true,blocked:true,confirmed:true});
    process.env.ENABLE_SENDING='true';delete process.env.EMERGENCY_DISABLE_SENDING;
    assert.equal((await post('123@c.us',true,false)).status,401);
    assert.equal((await post('123@g.us',true)).status,400);
    assert.equal((await post('123@c.us','true')).status,400);
    process.env.ENABLE_SENDING='false';assert.equal((await post('123@c.us',true)).status,403);
    process.env.ENABLE_SENDING='true';process.env.EMERGENCY_DISABLE_SENDING='true';
    assert.equal((await post('123@c.us',true)).status,403);assert.deepEqual(calls,[]);
    delete process.env.EMERGENCY_DISABLE_SENDING;
    assert.equal((await post('123@c.us',true)).status,200);
    assert.deepEqual(calls,[['123@s.whatsapp.net',true]]);
  } finally {
    for(const [key,value] of [['ENABLE_SENDING',previous.enable],['EMERGENCY_DISABLE_SENDING',previous.emergency]])
      if(value===undefined)delete process.env[key!];else process.env[key!]=value;
    await new Promise<void>(r=>server.close(()=>r()));
  }
});

/*
 * Provider-shaped fixture: the blocklist keeps one raw entry per identity, in the
 * spelling the provider happened to store, and a write is answered the way
 * Baileys answers it (its own `jidNormalizedUser`, then add or remove). With
 * `exactSpelling` the provider only removes an entry whose stored spelling is
 * identical to the address written, which is what makes a legacy `@c.us` row
 * survive a careless unblock. `refuse` rejects a write before it lands.
 */
function provider(options: {
  blocked: string[];
  mapping?: Record<string, string>;
  exactSpelling?: boolean;
  refuse?: (jid: string, action: string) => string | null;
}) {
  const bare = (jid: string) => jid.replace(/^(\d+):\d+@/, '$1@');
  const userAddress = (jid: string) => bare(jid).replace(/@c\.us$/, '@s.whatsapp.net');
  const sameEntry = (entry: string, written: string) =>
    options.exactSpelling ? bare(entry) === bare(written) : userAddress(entry) === userAddress(written);
  const state = { blocked: [...options.blocked], writes: [] as string[] };
  const mapping = options.mapping ?? {};
  const socket = {
    signalRepository: {
      lidMapping: {
        getPNForLID: async (lid: string) => mapping[lid] ?? null,
        getLIDForPN: async (pn: string) => mapping[pn] ?? null,
      },
    },
    fetchBlocklist: async () => [...state.blocked],
    updateBlockStatus: async (jid: string, action: string) => {
      state.writes.push(`${action}:${jid}`);
      const reason = options.refuse?.(jid, action) ?? null;
      if (reason) throw Object.assign(new Error(reason), { isBoom: true, output: { statusCode: 400 } });
      if (action === 'unblock') {
        state.blocked = state.blocked.filter(entry => !sameEntry(entry, jid));
        return;
      }
      const added = [userAddress(jid), mapping[userAddress(jid)]].filter(
        (value, index, list): value is string => typeof value === 'string' && list.indexOf(value) === index
      );
      state.blocked = [...new Set([...state.blocked, ...added])];
    },
  };
  return { socket, state };
}

test('every spelling the provider stores is read back and unblocked as the same contact', async () => {
  // One phone, four spellings, plus a LID that has no alias of its own.
  const spellings = [
    '34600111221@s.whatsapp.net',
    '34600111221@c.us',
    '34600111221:7@s.whatsapp.net',
    '34600111221:7@c.us',
  ];
  for (const stored of spellings) {
    const fixture = provider({ blocked: [stored] });
    const chat = '34600111221@s.whatsapp.net';
    assert.equal(await readContactBlocked(fixture.socket, chat), true, `stored as ${stored}`);
    assert.deepEqual(await setContactBlocked(fixture.socket, chat, false), {
      blocked: false, changed: true, confirmed: true,
    }, `unblock of ${stored}`);
    assert.deepEqual(fixture.state.blocked, [], `provider still holds a row stored as ${stored}`);
    assert.equal(await readContactBlocked(fixture.socket, chat), false, `still blocked after ${stored}`);

    // Re-blocking an address the provider spelled differently also confirms.
    const again = provider({ blocked: [] });
    assert.deepEqual(await setContactBlocked(again.socket, chat, true), {
      blocked: true, changed: true, confirmed: true,
    });
    assert.equal(await readContactBlocked(again.socket, chat), true);
  }
});

test('an unblock the provider did not carry out is never reported as done', async () => {
  // A provider that answers only to the exact stored spelling keeps the legacy row.
  const fixture = provider({ blocked: ['34600111221@c.us'], exactSpelling: true });
  await assert.rejects(
    setContactBlocked(fixture.socket, '34600111221@s.whatsapp.net', false),
    (error: unknown) =>
      error instanceof ContactBlockError &&
      error.status === 409 &&
      /not confirmed/.test(error.message)
  );
  // The row is really still there, so the caller is never told "unblocked".
  assert.deepEqual(fixture.state.blocked, ['34600111221@c.us']);
  assert.equal(await readContactBlocked(fixture.socket, '34600111221@s.whatsapp.net'), true);
});

test('a contact blocked under both identities is fully unblocked and then confirmed', async () => {
  const mapping = { '111@lid': '222@s.whatsapp.net', '222@s.whatsapp.net': '111@lid' };
  const fixture = provider({ blocked: ['111@lid', '222@s.whatsapp.net'], mapping });
  assert.deepEqual(await setContactBlocked(fixture.socket, '111@lid', false), {
    blocked: false, changed: true, confirmed: true,
  });
  assert.deepEqual(fixture.state.blocked, [], 'one identity still answers for this contact');
  // The LID goes first because Baileys can write it without a second lookup, and
  // the phone number is only written because the first write left it answering.
  assert.deepEqual(fixture.state.writes, ['unblock:111@lid', 'unblock:222@s.whatsapp.net']);
  assert.equal(await readContactBlocked(fixture.socket, '222@s.whatsapp.net'), false);

  // When the provider clears both identities in one write, no second write is wasted.
  const both = provider({ blocked: ['111@lid', '222@s.whatsapp.net'], mapping });
  const single = both.socket.updateBlockStatus;
  both.socket.updateBlockStatus = async (jid: string, action: string) => {
    await single(jid, action);
    both.state.blocked = [];
  };
  assert.deepEqual(await setContactBlocked(both.socket, '111@lid', false), {
    blocked: false, changed: true, confirmed: true,
  });
  assert.deepEqual(both.state.writes, ['unblock:111@lid']);
});

test('a write WhatsApp refuses is reported with its cause, after re-reading the state', async () => {
  const cause = 'Unable to resolve LID for PN JID: 34600111222@s.whatsapp.net';
  const refused = provider({
    blocked: ['34600111222@s.whatsapp.net'],
    refuse: (jid, action) => (action === 'unblock' && jid.endsWith('@s.whatsapp.net') ? cause : null),
  });
  await assert.rejects(
    setContactBlocked(refused.socket, '34600111222@s.whatsapp.net', false),
    (error: unknown) =>
      error instanceof ContactBlockError &&
      error.status === 409 &&
      error.message.includes(cause) &&
      /did not change/.test(error.message)
  );
  assert.deepEqual(refused.state.blocked, ['34600111222@s.whatsapp.net']);

  // The same refusal is a success when the provider had already applied the change.
  const landed = provider({ blocked: ['34600111222@s.whatsapp.net'] });
  const inner = landed.socket.updateBlockStatus;
  landed.socket.updateBlockStatus = async (jid: string, action: string) => {
    await inner(jid, action);
    throw new Error(cause);
  };
  assert.deepEqual(await setContactBlocked(landed.socket, '34600111222@s.whatsapp.net', false), {
    blocked: false, changed: true, confirmed: true,
  });
});

test('an unusable blocklist answer is refused on the read and on the write', async () => {
  for (const answer of [null, undefined, 'no-list', 7]) {
    const socket = { fetchBlocklist: async () => answer, signalRepository: { lidMapping: {} } };
    await assert.rejects(readContactBlocked(socket, '123@s.whatsapp.net'),
      (error: unknown) => error instanceof ContactBlockError && error.status === 502 && /unusable/.test(error.message));
    await assert.rejects(setContactBlocked(socket, '123@s.whatsapp.net', false),
      (error: unknown) => error instanceof ContactBlockError && error.status === 502 && /unusable/.test(error.message));
  }
});

test('a refused block change reaches the caller as a 409 contact block error', async () => {
  const previous = { enable: process.env.ENABLE_SENDING, emergency: process.env.EMERGENCY_DISABLE_SENDING };
  const secret = 'refused-block-fixture';
  process.env.CONNECTOR_ACCOUNT = 'personal';
  process.env.ENABLE_SENDING = 'true';
  delete process.env.EMERGENCY_DISABLE_SENDING;
  const app = express();
  app.use(express.json());
  app.use(createRouter({
    blockContact: async () => {
      throw new ContactBlockError(
        'WhatsApp refused the change and the contact block state did not change: Unable to resolve LID for PN JID',
        409
      );
    },
  } as any, {} as any, secret));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', r));
  try {
    const body = { blocked: false };
    const timestamp = Math.floor(Date.now() / 1000);
    const response = await fetch(
      `http://127.0.0.1:${(server.address() as any).port}/chats/34600111222%40s.whatsapp.net/block`,
      {
        method: 'POST', body: JSON.stringify(body),
        headers: {
          'content-type': 'application/json',
          'x-connector-timestamp': String(timestamp),
          'x-connector-signature': generateHMACSignature(body, timestamp, secret),
        },
      }
    );
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: {
        code: 'CONTACT_BLOCK_ERROR',
        message: 'WhatsApp refused the change and the contact block state did not change: Unable to resolve LID for PN JID',
      },
    });
  } finally {
    for (const [key, value] of [['ENABLE_SENDING', previous.enable], ['EMERGENCY_DISABLE_SENDING', previous.emergency]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
    await new Promise<void>(r => server.close(() => r()));
  }
});

test('a block the provider stores under both identities is confirmed by one write', async () => {
  const mapping = { '111@lid': '222@s.whatsapp.net', '222@s.whatsapp.net': '111@lid' };
  const fixture = provider({ blocked: [], mapping });
  assert.deepEqual(await setContactBlocked(fixture.socket, '111@lid', true), {
    blocked: true, changed: true, confirmed: true,
  });
  // WhatsApp keeps the pair together, so asking again is a no-op rather than a
  // second write that could half-apply.
  assert.deepEqual(fixture.state.blocked, ['111@lid', '222@s.whatsapp.net']);
  assert.deepEqual(fixture.state.writes, ['block:111@lid']);
  assert.equal((await setContactBlocked(fixture.socket, '222@s.whatsapp.net', true)).changed, false);
  assert.deepEqual(fixture.state.writes, ['block:111@lid']);
  assert.deepEqual(await setContactBlocked(fixture.socket, '222@s.whatsapp.net', false), {
    blocked: false, changed: true, confirmed: true,
  });
  assert.deepEqual(fixture.state.blocked, []);
});

test('a socket without a Signal mapping store still reads and clears the address it knows', async () => {
  const stored = ['34600111223@lid'];
  const socket = { fetchBlocklist: async () => [...stored], updateBlockStatus: async (jid: string) => {
    const index = stored.indexOf(jid);
    if (index >= 0) stored.splice(index, 1);
  } };
  assert.equal(await readContactBlocked(socket, '34600111223@lid'), true);
  assert.deepEqual(await setContactBlocked(socket, '34600111223@lid', false), {
    blocked: false, changed: true, confirmed: true,
  });
  assert.deepEqual(stored, []);
});
