# Socialmedia MCP contract v2

Socialmedia exposes one provider-neutral MCP contract for WhatsApp, Telegram,
and Instagram. The canonical registry lives in
`mcp-server/src/mcp/tool-registry.ts`; `contracts/socialmedia-tools.json` is its
deterministic, SHA-256-addressed projection for AgentGateway, OpenClaw,
documentation, and deployment checks.

There is no legacy catalog, alias layer, `_live` variant, or `/v2` endpoint.
Unknown historical names return `method not found`.

## Endpoint

- Streamable HTTP: `https://mcp-socialmedia.lan.e-dani.com/mcp`
- SSE: `https://mcp-socialmedia.lan.e-dani.com/sse`
- In-cluster: `http://mcp-sse.whatsapp-mcp.svc.cluster.local:3010/mcp`

AgentGateway exposes the authorized route at `/social`. Its rules and the MCP
catalog must carry the same contract digest before deployment.

## Common contract

- `channel`: `whatsapp`, `telegram`, or `instagram`.
- `accountId`: the configured provider account.
- `target`: always a string containing the provider-native peer, group,
  conversation, message, media, or comment target expected by that operation.
- Every mutation requires explicit `channel` and `accountId`.
- A numeric-looking target never selects a channel.
- Reads accept `readSource: auto | provider | index`.
- Unsupported source/provider combinations return
  `unsupported_capability`; they never masquerade as an empty list.

Read results include:

```json
{
  "source": {
    "kind": "providerQuery",
    "asOf": "2026-07-27T12:00:00.000Z",
    "completeness": "complete"
  }
}
```

Aggregated reads may return `completeness: partial` and `partialErrors` per
channel/account.

Tool results use `structuredContent`:

```json
{
  "ok": true,
  "status": "accepted",
  "data": {},
  "meta": {}
}
```

Provider failures set MCP `isError` and include a structured `error`. A timeout
after a provider may have accepted a mutation returns `outcome_unknown`.

## Canonical tools

The exact catalog table is generated at
`contracts/socialmedia-tools.md`. The machine-readable manifest and test
fixture is `contracts/socialmedia-tools.json`; it contains every input/output
schema, effect, scope, annotation and capability. Both files are regenerated
from the same typed registry and checked by CI.

## Sending

```json
{
  "channel": "telegram",
  "accountId": "personal",
  "target": "-100123456",
  "message": "Texto",
  "attachments": [],
  "replyTo": null,
  "threadId": null,
  "idempotencyKey": "optional"
}
```

`replyTo` and `threadId` are independent. Reusing an `idempotencyKey` with the
same payload replays the stored result; changing the payload returns
`conflict`.

The deployed WhatsApp accounts use Baileys. They advertise
`templates: false`; official Cloud API templates are not claimed until that
transport is actually deployed.

## Telegram administration

`social_manage_forum` supports:

- `createTopic`, `editTopic`, `closeTopic`, `reopenTopic`, `pinTopic`,
  `unpinTopic`, `deleteTopic`
- `createGroup` (`group`, `supergroup`, `channel`; optional forum)
- `addMembers`
- `setAdminPermissions`

`social_manage_chat` supports `setTitle`, `setDescription`, `setPhoto`, and
`setForumEnabled`.

## OpenClaw

OpenClaw registers channel adapters named `socialmedia-whatsapp`,
`socialmedia-telegram`, and `socialmedia-instagram`. Sending, attachments,
replies, and deletion use OpenClaw's shared `message` tool. The plugin does not
register another set of Socialmedia tool wrappers.

Other canonical operations arrive from this MCP contract through Tool Search.

## Regeneration and validation

```bash
pnpm contract:generate
pnpm contract:check
```

CI rejects a stale manifest or mismatched catalog/digest. AgentGateway and
OpenClaw vendor the generated manifest and validate the same digest.
