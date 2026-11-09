# Mistra Portal MCP — Phased Implementation Plan

**Project:** `mistra-portal-mcp` (new Mastra project at `/Users/johnlynas/dev/mistra-portal-mcp`)
**Companion doc:** `docs/DESIGN.md` (architecture, verified portal behavior, security)
**Date:** 2026-11-09

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** An MCP server built on the Mastra framework that lets Mistra control the NIPP portal through its REST API: `Mistra agent → Portal MCP server → Portal API → Portal app`.

**Architecture:** Spec-driven tool generation from the portal's OpenAPI document (175 endpoints → 175 tools) plus a shared `PortalClient` that holds a BetterAuth cookie session and forwards every call with org context. Served over Streamable HTTP by Mastra (`/api/mcp/nipp-portal/mcp`) and stdio.

**Tech Stack:** Mastra 1.38 / `@mastra/core` 1.82 / `@mastra/mcp` 1.18, TypeScript (Node16 ESM), Zod 4, Node 22+ fetch.

---

## Phase 0 — Recon & ground truth ✅ DONE

Understand the portal's auth model before writing code. All findings verified
against the live portal and recorded in `DESIGN.md` §3.

### Task 0.1: Inventory the OpenAPI spec
- Read `docs/openapi/generated/openapi.json`: 186 ops, 109 paths, 204 schemas,
  security scheme = BetterAuth session cookie.
- Map endpoints to the portal's service domains (`nipp-0111/services/*`):
  organization, user, role, team, work-order, contractor, invoice, quote,
  resource, unit, permission, job-scheduler, calendar.

### Task 0.2: Verify auth behavior with curl
Run and record results (all done; see DESIGN.md §3):
```bash
# sign-in → cookie + token
curl -X POST http://localhost:3000/api/auth/sign-in/email \
  -H 'Content-Type: application/json' \
  -d '{"email":"<admin>","password":"<pw>"}' -c /tmp/cj.txt
# cookie works on admin routes:
curl http://localhost:3000/api/dashboard/admin/organizations \
  -b /tmp/cj.txt -H 'x-org-id: <platform-org-id>'
# bearer does NOT work on admin routes (307 → /login):
curl http://localhost:3000/api/dashboard/admin/stats -H "Authorization: Bearer $TOKEN"
```
**Result:** cookie-only for admin surface; `x-org-id` required; Node fetch needs
an explicit `Origin` header (CSRF); sign-ins are rate-limited.

### Task 0.3: Check Mastra MCP APIs against installed docs
- `MCPServer` from `@mastra/mcp`; registered on the `Mastra` instance via
  `mcpServers`; served at `/api/mcp/:serverId/mcp`; `startStdio()` for stdio.

**Exit criteria:** auth model documented; tool-grouping strategy chosen (path-derived ids mirroring service domains).

---

## Phase 1 — Project scaffold ✅ DONE

### Task 1.1: Create project skeleton
- `package.json` (deps: `@mastra/core`, `@mastra/mcp`, `@mastra/libsql`, `zod`; dev: `mastra`, `tsx`, `typescript`, `@types/node`)
- `tsconfig.json` (Node16 ESM, strict, `types:["node"]`)
- `.env` / `.env.example` / `.gitignore`
- Copy spec to `openapi/openapi.json` (self-contained project)

### Task 1.2: Install & type-check
```bash
npm install --no-audit --no-fund
npx tsc --noEmit   # exit 0
```

**Exit criteria:** empty Mastra project installs and type-checks.

---

## Phase 2 — Core modules ✅ DONE

### Task 2.1: `src/mastra/config.ts`
Env-driven config: base URL, credentials, default org id (Platform org),
excluded path prefixes (`/api/auth`, `/api/csp-report`, `/api/health`).

### Task 2.2: `src/mastra/spec.ts`
Load + cache `openapi/openapi.json`; `$ref` resolver.

### Task 2.3: `src/mastra/schema.ts` — JSON Schema → Zod
Handles `$ref` (recursive, depth-capped), object (`.passthrough()`, required vs
optional), array, string (enum/email/min/max), number (int/min/max), boolean,
nullable, defaults, allOf/oneOf fallbacks.

### Task 2.4: `src/mastra/client.ts` — PortalClient
- `signIn()`: POST `/api/auth/sign-in/email` with `Origin`+`Referer` headers;
  capture `better-auth.session_token` cookie; 30s cooldown guard (rate limit).
- `request(method, path, {pathParams, query, body, orgId})`: cookie + Origin +
  `x-org-id`; transparent re-auth on 401 with single retry.

### Task 2.5: `src/mastra/tools/generate.ts` — spec → tools
- id derivation (segments + action suffix; 0 collisions across 175 endpoints)
- input schema assembly (path params, query params as `string|number`, flattened
  body fields, optional `orgId`)
- execute: split flat input → path/query/body; return `{success,status,data|error}`

### Task 2.6: `src/mastra/tools/utility.ts`
`portal_health`, `portal_session_verify` (identity + permissions).

**Exit criteria:** `tsc --noEmit` clean with all modules in place.

---

## Phase 3 — MCP server wiring ✅ DONE

### Task 3.1: `src/mastra/mcp/server.ts`
`MCPServer` id `nipp-portal`, name/version/description/instructions (conventions,
org context, 401 guidance, destructive-op warning), all 177 tools. Shared client
hoisted to `globalThis` (dev-server module re-imports would otherwise sign in per
request → 429).

### Task 3.2: `src/mastra/index.ts` + `src/mastra/mcp/stdio.ts`
Mastra instance with `mcpServers: { portalMcpServer }` + LibSQL storage; stdio
entry point for subprocess clients.

**Exit criteria:** `mastra dev` boots; MCP endpoint answers `initialize`.

---

## Phase 4 — End-to-end verification ✅ DONE

### Task 4.1: Boot & protocol smoke test
```bash
npm run dev   # port 4112 (4111 taken by mastra-agent)
curl -X POST http://localhost:4112/api/mcp/nipp-portal/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}'
# → 200 + mcp-session-id header
```

### Task 4.2: tools/list
**Result:** 177 tools; spot-checked `user_list_admin`, `org_create_admin`,
`portal_health`, `portal_session_verify` present.

### Task 4.3: Authenticated live calls (the real test)
```bash
tools/call portal_session_verify {}
# → user "System Administrator", org Platform, permissions ["*"]
tools/call org_list_admin {"page":1,"pageSize":3}
# → live data: Test Tenant Ltd + Platform, member/team counts, pagination
```

### Task 4.4: Failure-path checks (observed & fixed during this phase)
- Bearer vs cookie → cookie required (Phase 0 finding, enforced in client)
- `origin: null` 403 → explicit Origin header
- page/pageSize number-vs-string validation → union schema
- sign-in 429 → shared client + cooldown

**Exit criteria:** every gate above green — **all passed 2026-11-09**.

---

## Phase 5 — Connect Mistra (next step)

Wire the existing `mastra-agent` (Mistra) at `/Users/johnlynas/dev/mastra_demo/mastra-agent`
to this server.

### Task 5.1: Add MCPClient to mastra-agent
In a new `src/mastra/mcp/client.ts`:
```ts
import { MCPClient } from '@mastra/mcp';
export const portalMcp = new MCPClient({
  id: 'portal-client',
  servers: {
    nippPortal: { url: new URL('http://localhost:4112/api/mcp/nipp-portal/mcp') },
  },
});
```
Register in `src/mastra/index.ts`; pass tools to the agent:
`tools: await portalMcp.listTools()` (static — shared fixed config).

### Task 5.2: Tool approval for destructive ops (recommended)
```ts
requireToolApproval: ({ toolName }) => /_(delete|ban|trigger|dry_run)$/.test(toolName),
```
so Mistra asks before mutations/deletes.

### Task 5.3: End-to-end agent test
```bash
npx mastra api --url http://localhost:4111 --timeout 300000 agent run <agentId> \
  '{"messages":"List all organizations in the portal and report their names and member counts","memory":{"thread":"t1","resource":"r1"}}'
```
Expected: agent calls `org_list_admin` via MCP and reports Test Tenant Ltd + Platform.

**Exit criteria:** Mistra answers a real question using portal data through the MCP server.

---

## Phase 6 — Hardening (optional, later)

| # | Item | Notes |
|---|------|-------|
| 6.1 | `spec:sync` script | Run portal `npm run docs:generate`, copy spec, diff tool count; fail CI on drift |
| 6.2 | Auth on the MCP endpoint | Mastra OAuth middleware or reverse-proxy auth before exposing beyond localhost |
| 6.3 | Output schemas | Derive `outputSchema` from spec response objects → structuredContent for models |
| 6.4 | Backoff/jitter on sign-in | Exponential backoff if multi-agent load grows |
| 6.5 | Tests | Vitest unit tests for `deriveToolId`, `schemaToZod`, input-splitting; integration test against a stubbed portal |
| 6.6 | Packaging | Publish stdio build (`bin` → `dist/stdio.js`) so any machine can `npx` it |

---

## Files in the project (as built)

```
mistra-portal-mcp/
├── package.json / tsconfig.json / .env / .env.example / .gitignore
├── openapi/openapi.json            # portal spec (copied, self-contained)
├── docs/DESIGN.md                  # this design doc
├── docs/PLAN.md                    # this plan
└── src/mastra/
    ├── index.ts                    # Mastra instance + storage
    ├── config.ts                   # env config
    ├── spec.ts                     # spec loader + $ref resolver
    ├── schema.ts                   # JSON Schema → Zod
    ├── client.ts                   # PortalClient (session, org context, retry)
    ├── tools/generate.ts           # 175 spec-derived tools
    ├── tools/utility.ts            # health + session verify
    └── mcp/server.ts               # MCPServer 'nipp-portal' (177 tools)
    └── mcp/stdio.ts                # stdio entry point
```

## Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| Portal sign-in rate limit (429) | Single shared client, session reuse, 30s cooldown, retry-once on 401 |
| Spec drift from portal code | `spec:sync` script (Phase 6.1); tools regenerate from spec only |
| Unauthenticated MCP endpoint = super-admin access for anyone on the port | Documented; Phase 6.2 auth before any non-localhost exposure |
| Destructive tool calls by an over-eager agent | Server instructions warn the model; Phase 5.2 approval gate on delete/mutation tools |
| BetterAuth behavior changes (CSRF, cookies) | Verified findings live in DESIGN.md §3; smoke test re-runs catch regressions |
