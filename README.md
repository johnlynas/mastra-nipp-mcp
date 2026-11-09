# mistra-portal-mcp

MCP server (Mastra framework) that exposes the NIPP portal's admin API to Mistra
and any other MCP client:

```
Mistra agent → Portal MCP server → Portal API → Portal app
```

175 tools generated from the portal's OpenAPI spec + 2 utility tools
(`portal_health`, `portal_session_verify`). The server holds a BetterAuth
cookie session (Platform org super-admin) and forwards every call with
`x-org-id` tenant context.

Docs: [DESIGN.md](docs/DESIGN.md) · [PLAN.md](docs/PLAN.md)

## Quick start

```bash
cp .env.example .env        # fill in PORTAL_EMAIL / PORTAL_PASSWORD / PORTAL_DEFAULT_ORG_ID
npm install
npm run dev                 # Studio on http://localhost:4112 (PORT env to change)
```

MCP endpoint (Streamable HTTP):

```
http://localhost:4112/api/mcp/nipp-portal/mcp
```

Stdio mode (for clients that launch servers as subprocesses):

```bash
npm run stdio
```

Client config example:

```json
{
  "mcpServers": {
    "nipp-portal": {
      "url": "http://localhost:4112/api/mcp/nipp-portal/mcp"
    }
  }
}
```

## Connecting Mistra (mastra-agent)

In `mastra-agent/src/mastra/mcp/client.ts`:

```ts
import { MCPClient } from '@mastra/mcp';

export const portalMcp = new MCPClient({
  id: 'portal-client',
  servers: {
    nippPortal: { url: new URL('http://localhost:4112/api/mcp/nipp-portal/mcp') },
  },
});
```

Then pass `await portalMcp.listTools()` to the agent's `tools` and register the
client in `src/mastra/index.ts`. See PLAN.md Phase 5.

## Tool naming

Tool ids are grouped by the portal's service domains (mirroring `nipp-0111/services`):
`user_list_admin` = `GET /api/admin/users`, `wo_transition_transition` =
`POST /api/admin/work-orders/{id}/transition`, `calevent_organizations_calendar_events_list` =
list a tenant's calendar events. Scope suffixes: `_admin` (/api/admin), `_dash`
(/api/dashboard/admin), `_tenant` (/api/organizations/{orgId}).
Every tool accepts an optional `orgId` argument to target a specific tenant
(defaults to the Platform org from `.env`).

## Regenerating after portal API changes

```bash
cd ../nipp-0111 && npm run docs:generate
cp docs/openapi/generated/openapi.json ../mistra-portal-mcp/openapi/openapi.json
# restart the dev server — tools regenerate automatically
```
