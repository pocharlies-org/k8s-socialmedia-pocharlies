# Connector contracts audit, 2026-10-20

Scope: fork baseline `ef500ec7442a4fdf491d2b9a43355644015a8e87`, compared with
`upstream/deploy/prod` at `1470fa85ec529cafb7090baa9f22429812a34236`
(SC-2760). Source and fixture HTTP tests only; no live WhatsApp send, contact
change, browser mutation, deployment or database repair.

## Route matrix

All paths below have the `/api/v1` prefix. Each uses connector access plus
`createHMACAuth`; the timestamp and original JSON body are checked before the
handler reads path parameters. Parameterized fork handlers do not merge path
parameters into the signed body. GET requests use the existing `{}` signature
convention. The HMAC covers timestamp and JSON body, not method/path/query;
this audit preserves that existing protocol.

| Feature | Method and path in fork | Handler / contract | Gate and evidence |
| --- | --- | --- | --- |
| Chat modify | POST `/chats/modify` | `modifyChat`, body `conversationId`, action, mute options | Existing sending and connection gates |
| App chat modify | POST `/chats/:chatId/modify` | `modifyCapabilityChat`, `action`, `value`, `messageIds` | Sending/emergency gate added in this audit after route input validation; retains `star`/`unstar` |
| Block state | GET `/chats/:chatId/block` | `contactBlocked`, `{blocked, confirmed:true}` | Read, HMAC; no sending gate |
| Block write | POST `/chats/:chatId/block` | `blockContact`, boolean `blocked` required | Existing sending/emergency gate; boolean validation retained |
| Block list | GET `/contacts/blocklist` | `listBlockedContacts`, provider list | Read, HMAC, connection gate |
| Presence read | GET `/chats/:chatId/presence` | `getCapabilityPresence` | Read, HMAC |
| Presence subscription | POST `/chats/:chatId/presence` with `{action:'subscribe'}` | `subscribePresence` | Authenticated subscription, no message send |
| Presence stream | GET `/chats/:chatId/presence/stream` | `getPresence`, subscribe, chat-filtered SSE | HMAC, listener cleanup; fixture stream tests pass |
| Presence publish | POST `/chats/presence` | `sendPresence` | Existing sending and available-presence policy |
| Message info | POST `/messages/info` | `getMessageInfo`, `{chatId,messageId,refresh?}` | Read/receipt query, input validation, HMAC |
| History recovery | POST `/history/recover` | `recoverChatHistory`, `{chatId}` | HMAC; requests provider history and persists recovered records, does not send a chat message |
| Status reads | GET `/novedades/status/authors`, `/novedades/status` | account-scoped `NovedadesReader` | HMAC, reader validation |
| Status publish | POST `/novedades/status` | `publishNovedadesStatus` | Existing sending/emergency gate, validated recipients, uncertain outcome handling |
| Channel reads | GET `/novedades/channels`, `/novedades/channels/lookup`, `/novedades/channels/:jid/posts`, `/novedades/channels/:jid/posts/:messageId`, `/novedades/media` | reader / `ChannelService.lookup` | HMAC, account scope, reader validation |
| Channel subscription | POST `/novedades/channels/subscription` | `ChannelService.subscription` | Existing sending/emergency and connection gates, read-back confirmation |
| Star API | POST `/messages/star`, `/messages/starred` | `starMessage`, `listStarredMessages` | Star write has existing sending/connection gate; list is a read |
| App star | POST `/chats/:chatId/modify` with `star`/`unstar`, value, message refs | `modifyCapabilityChat` | Same new gate as other app chat modifications; enabled star/unstar round-trip tested |
| Disappearing timer | POST `/chats/disappearing`, POST `/chats/:chatId/disappearing` | `setDisappearing` | Flat gate already present; parameterized sending/emergency gate added after route input validation |
| Group update | POST `/groups/:id/update` | `updateGroup` | Already exists with sending/emergency gate; no missing alias |
| Delete for me | DELETE `/messages/:chatId/:msgId/for-me` | `deleteMessageForMe` | Already exists with sending/emergency gate; no missing alias |
| Delete for everyone | DELETE `/messages/:chatId/:msgId` | `deleteMessage` | Already exists with sending/emergency gate |
| Legacy read receipt | POST `/messages/read/:chatId` | `markAsRead` | Sending/emergency gate added before provider call |

Source: `connectors/whatsapp-web/src/api/controller.ts`, `api/access.ts`,
`api/auth.ts`, `baileys-client.ts`, `whatsapp-capabilities.ts`.

## Minimal upstream adoption

Upstream commit `2bdda1da0fc40eb934c7b956e3fb9ee400ee61e4` (#282)
introduces five parameterized aliases because that branch lacked them. All five
already exist in this fork. A full cherry-pick is unnecessary and would conflict
with fork behavior: its chat-modify alias delegates to the flat handler, which
does not support the app's `star`/`unstar` actions; its block alias also translates
an absent/non-boolean `blocked` field to `block`, whereas the fork rejects it.

The concrete fork defect was missing sending gates on parameterized modify and
disappearing routes, plus the legacy read-receipt route. With sending disabled
and the emergency switch active, fixture requests reached the first two client
methods and returned 200 while the flat routes returned 403. This audit adds
three gate checks and a regression test, preserving handlers, payloads,
responses, star/unstar support, authentication order and existing validation.

Upstream lacks the fork's GET block state, parameterized presence/stream,
message info, recovery and novedades surface at the compared revision. This
matrix does not establish compatibility of every upstream commit or a runtime
image merely from its tag.

## Trusted contact / 463

The supplied object name `8a21aea6c40ea7fcd7bc9` is not present locally.
The matching historical commit is
`8a21aea52172b072f282e1362f0edc54cb6d0bd4` (professional LID with trusted phone),
already an ancestor of the fork. Its caller-phone fallback has since been
replaced deliberately:

- `mcp-server/src/mcp/server.ts:resolveProfessionalSendTarget` preserves a LID
  destination and ignores caller `phone`, `phoneE164` and `manualOpenUrl` hints.
- `professionalInboundDestination` requires same-account inbound. Phone-to-LID
  resolution uses provider-derived `metadata.senderPnE164` and requires a unique
  mapped LID; arbitrary caller PN evidence cannot redirect a LID send.
- `requireProfessionalInboundChat` gates the actual destination for text,
  files and forwards. Forwarding gates `toChatId`, not the source chat.
- Connector `guardDirectSend` accepts known-contact evidence (fresh token,
  historical token record or canonical inbound history); true first contacts
  require privacy-token preflight. Missing evidence fails closed as
  `account_restricted`. This reduces local false rejections; it cannot guarantee
  WhatsApp will accept a send or eliminate real provider 463 restrictions.
- `sendFile` invokes the direct guard before fetching the file.
  `forwardMessage` loads the original, then guards the destination before the
  provider send. No guard reordering is needed.

Existing MCP regression coverage: `server.lid.spec.ts` explicitly rejects
caller-phone redirection and requires provider identity evidence;
`server.coldsend-gate.spec.ts` covers inbound policy. Those MCP suites were
inspected, not executed for this connector task. No real 463 send was authorized
or attempted; runtime behavior remains external validation.

## Validation

The new regression test failed before the fix (`200 !== 403`) and passes after
it. It exercises real Express routing and HMAC with fixture client methods:
both locks separately, invalid input returning 400 before the gate, no provider
calls while blocked, rejection of a signature for a different body, and enabled
star/unstar/timer/read operations receiving the decoded path ID.

Executed `api/access.test.ts`, `api/controller-security.test.ts`,
`api/controller-presence-stream.test.ts`, and `direct-send-guard.test.ts`:
27 tests passed, zero failed, process exit 0. `git diff --check` passed for the
changed source and test. Existing direct-guard tests verify first-contact
refusal before file fetch and the same policy for forwarding, voice, poll,
contact and event sends, with fake WhatsApp sockets. Some existing tests attempt
dummy localhost database lookups that are refused; no successful live database
validation is claimed. Existing combined-suite warning: more than ten process
exit listeners; it does not fail the suite.

This worktree has only the root `node_modules` symlink into `pr74-rebase`;
the normal invocation initially failed to resolve `express`. Tests were run
without installing or changing dependencies using Node's `registerHooks` to
retry missing bare-package resolution relative to that checkout's connector
entrypoint. Source modules came from this audit worktree:

```sh
DATABASE_URL=postgresql://test:test@127.0.0.1:5432/test node --import tsx <<'JS'
(async () => {
  const { registerHooks } = await import('node:module');
  registerHooks({ resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || specifier.startsWith('.') || specifier.startsWith('/')) throw error;
      return nextResolve(specifier, { ...context, parentURL: 'file:///home/staticduo/git/pr74-rebase/connectors/whatsapp-web/src/main.ts' });
    }
  }});
  for (const path of ['api/access.test.ts', 'api/controller-security.test.ts', 'api/controller-presence-stream.test.ts', 'direct-send-guard.test.ts'])
    await import('./connectors/whatsapp-web/src/' + path);
})().catch(error => { console.error(error); process.exitCode = 1; });
JS
```

Shared Hindsight recall was consulted for scope/history. LazyMCP Kindly search
and Context7 `/whiskeysockets/baileys` were consulted for the public socket
contracts, including `chatModify`, starring and `issuePrivacyTokens`:
`https://github.com/WhiskeySockets/Baileys`, `https://baileys.wiki/`.
Public docs refer to current upstream and are supporting context; the pinned
local `7.0.0-rc13` code and tests determine the findings here.
