# Mistra Portal MCP Server — Design Document

**Project:** `mistra-portal-mcp`
**Date:** 2026-11-09
**Status:** Implemented and verified end-to-end against the live portal (http://localhost:3000)

---

## 1. Purpose

Expose the NIPP portal's REST API to Mistra (a Mastra agent) — and any other
MCP-compatible client — as a Model Context Protocol server, so an agent can
drive the portal directly:

```
Mistra agent ──► Portal MCP server ──► Portal API ──► Portal app
   (Mastra        (this project,         (Next.js 16     (NIPP,
    agent)         Mastra MCPServer)      BetterAuth)     nipp-0111)
```

The MCP server is a **thin, spec-driven API bridge**: it holds a portal admin
session, translates MCP tool calls into authenticated HTTP requests, and
returns the portal's JSON responses. It contains no business logic of its own —
all authorization (RBAC, tenant isolation, Platform-org protection) stays in
the portal, which is exactly where it belongs.

The server targets the **Platform organization** (system admin functions):
organizations, users, roles, permissions, teams, work orders, contractors,
invoices, quotes, resources, units, jobs, scripts, calendar and audit data.

## 2. Source of truth: the OpenAPI spec

- Spec: `openapi/openapi.json` (copied from
  `/Users/johnlynas/dev/mastra_demo/docs/openapi/generated/openapi.json`).
  Regenerate it in the portal with `npm run docs:generate` and copy it over.
- **186 operations** across 109 paths; 204 component schemas.
- Domains (mirrors the portal's `services/` layer): admin orgs/users/roles/
  permissions, dashboard-admin (teams, scripts, stats), organizations +
  calendar, work orders, contractors, invoices, quotes, resources, units,
  jobs/scheduler, notifications, security, health.

**Scope decision:** the public surface (`/api/auth/*`, `/api/csp-report`,
`/api/health`) is excluded from tool generation — the BetterAuth catch-all is
handled by the session manager, CSP reporting is browser-only, and health is a
hand-written utility tool. **175 generated tools + 2 utility tools = 177.**

## 3. Verified portal behavior (live tests, 2026-11-09)

These findings shape the design; each was tested against the running portal:

| # | Finding | Design consequence |
|---|---------|--------------------|
| 1 | `POST /api/auth/sign-in/email` returns `better-auth.session_token` + `session_data` cookies and a JSON body with `token` | Client signs in once, stores the session cookie |
| 2 | **Admin/dashboard routes reject Bearer tokens** (307 → `/login`) but accept the session cookie. Only BetterAuth's own endpoints honor `Authorization: Bearer` | All portal calls carry the **Cookie** header — never a bearer token |
| 3 | Node's `fetch` sends `origin: null`; BetterAuth's CSRF check rejects that with 403 `MISSING_OR_NULL_ORIGIN` | Sign-in and all requests send `Origin: <portal base URL>` (plus `Referer`) |
| 4 | Portal rate-limits sign-ins aggressively (429 after a handful of attempts) | One shared `PortalClient` for the whole process + 30s sign-in cooldown; session reuse, transparent re-auth only on 401 |
| 5 | Most routes require **org context** via `x-org-id` header (or `?orgId=`); missing → 400 "Organization context required" | Every request sends `x-org-id`, defaulting to the Platform org id; tools accept an optional `orgId` argument to target a specific tenant |
| 6 | Spec types pagination params (`page`, `pageSize`) as string, but the API accepts numbers too | Query params typed `string \| number` in tool schemas; stringified on send |
| 7 | Session user is "System Administrator" with permissions `["*"]`, active org = Platform | The MCP server acts as a super-admin — destructive tools are real (see §9) |

## 4. Architecture

```
┌─────────────────────────────── mistra-portal-mcp ───────────────────────────────┐
│                                                                                  │
│  src/mastra/                                                                    │
│  ├── index.ts          Mastra instance; registers the MCPServer + LibSQL store   │
│  ├── config.ts         env → PortalMcpConfig (base URL, creds, default org)      │
│  ├── spec.ts           loads/caches openapi.json, resolves $refs                 │
│  ├── schema.ts         JSON Schema → Zod converter ($ref, object, array, enum…)  │
│  ├── client.ts         PortalClient: sign-in, cookie jar, x-org-id, 401 retry    │
│  ├── tools/                                                   │
│  │   ├── generate.ts   spec → one Mastra tool per endpoint (175)                 │
│  │   └── utility.ts    portal_health, portal_session_verify (2)                  │
│  └── mcp/                                                                     │
│      ├── server.ts     MCPServer 'nipp-portal' with all 177 tools                │
│      └── stdio.ts      stdio entry point for subprocess MCP clients              │
└──────────────────────────────────────────────────────────────────────────────────┘
        │ Streamable HTTP                          │ cookie-authed fetch
        ▼                                          ▼
MCP clients (Mistra, Claude Desktop…)      NIPP portal :3000
  http://localhost:4112/api/mcp/nipp-portal/mcp
```

### Transports

- **Streamable HTTP** (default): served by Mastra at
  `/api/mcp/nipp-portal/mcp` — the URL segment is the server **id**
  (`nipp-portal`), not the registration key. This is how Mistra connects.
- **stdio**: `npm run stdio` runs `src/mastra/mcp/stdio.ts`, so any client can
  also launch it as a subprocess:
  ```json
  { "mcpServers": { "portal": { "command": "npx",
      "args": ["tsx", "/Users/johnlynas/dev/mistra-portal-mcp/src/mastra/mcp/stdio.ts"] } } }
  ```

## 5. Tool generation (spec → tools)

For every `(method, path)` operation in the spec (minus excluded prefixes):

1. **id** = service-domain token + subpath + action suffix, mirroring the
   portal's `services/` layer: `GET /api/admin/users` → `user_list_admin`;
   `POST /api/admin/work-orders/{id}/transition` → `wo_transition_transition`.
   Domains: org, user, role, perm, team, wo, wonote, contractor, invoice, quote,
   resource, unit, job, script, calendar/calevent/calnotif, system, security, notif.
   When the same operation exists in multiple scopes (e.g. `/api/admin/users` and
   `/api/dashboard/admin/users`), a scope suffix disambiguates: `_admin`, `_dash`,
   `_tenant`. Two-pass assignment guarantees uniqueness (verified: 175/175). The id
   doubles as the MCP tool name.
2. **description** = `METHOD path — summary — first paragraph of the spec
   description` (kept ≤ ~500 chars so the model gets context without bloat).
3. **input schema** (Zod, from the JSON Schema):
   - path params → required fields;
   - query params → optional fields (`string | number` for string-typed ones);
   - request body object → top-level fields flattened into the same object
     (the model fills one flat input; non-object bodies get a `body` field);
   - objects use `.passthrough()` so extra spec-undeclared fields are allowed;
   - an optional **`orgId`** field is added to every tool for tenant targeting.
4. **execute**: splits the flat input back into path params / query / body,
   calls `PortalClient.request(method, path, {pathParams, query, body, orgId})`,
   returns `{ success, status, data }` on 2xx or `{ success:false, status, error }`
   otherwise — so the model always sees the portal's actual status and payload.

### Why generated tools instead of hand-written ones

- 175 endpoints is too many to maintain by hand; the spec is already generated
  from the code (`npm run docs:generate`), so tools stay in sync for free.
- Schema fidelity: required/optional, enums, descriptions all come from the
  same source the portal documents itself with.

## 6. Authentication & session lifecycle (`PortalClient`)

```
first tool call ─► ensureSession() ─► signIn()
                                │            ├─ POST /api/auth/sign-in/email
                                │            │   (Origin + Referer headers)
                                │            ├─ capture better-auth.session_token cookie
                                │            └─ 30s cooldown guard (rate limit)
                                ▼
                       request(method, path, opts)
                         Cookie: better-auth.session_token=…
                         Origin: <baseUrl>          ← CSRF requirement
                         x-org-id: <orgId|default>  ← tenant isolation
                                │
                        401? ──► invalidateSession() → re-sign-in → retry once
```

- **One shared instance** (`globalThis.__portalClient`) for the whole process.
  The Mastra dev server re-imports modules per request; without hoisting, every
  tool call would sign in fresh and trip the portal's rate limit (observed: 429).
- **Session expiry**: BetterAuth sessions outlive typical agent work; on 401 the
  client clears the cookie, signs in again (respecting the cooldown), retries
  once. A persistent 401/403 surfaces to the model as `success:false` with the
  portal's error body — `portal_session_verify` exists to diagnose identity/org.

## 7. Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `PORTAL_BASE_URL` | `http://localhost:3000` | Portal origin (no trailing slash) |
| `PORTAL_EMAIL` / `PORTAL_PASSWORD` | — | BetterAuth credentials for the admin session |
| `PORTAL_DEFAULT_ORG_ID` | Platform org id | `x-org-id` when a tool call omits `orgId` |
| `PORT` | `4112` | Mastra dev server port (4111 is used by mastra-agent) |

Credentials live in `.env` (gitignored); `.env.example` ships placeholders.

## 8. Security considerations

- **Least exposure of secrets**: portal credentials never leave the MCP server
  process; MCP clients only see tool names/schemas and responses. The session
  cookie is not exposed to tools or logs.
- **Authorization stays in the portal**: the server does not re-implement RBAC.
  A 403 from the portal (e.g. non-super-admin touching a Platform org) passes
  through as a tool error.
- **Trust boundary**: the MCP endpoint is currently unauthenticated — anyone who
  can reach port 4112 can drive the portal as super-admin. For LAN/production
  use, put it behind auth (Mastra supports OAuth middleware on MCP servers) or
  bind to localhost only. Documented here deliberately; not in scope for v1.
- **Destructive operations are real**: `*_delete`, user ban, org status changes,
  script triggers. The server's `instructions` block tells the model to confirm
  intent; a future phase can add `requireToolApproval` on the Mistra side for
  delete/mutation tools (MCPClient supports per-tool approval callbacks).
- **No SSRF surface**: the client only talks to the single configured
  `PORTAL_BASE_URL`; tool inputs cannot change the target host.

## 9. Verification results (live, 2026-11-09)

| Check | Result |
|---|---|
| `tsc --noEmit` | clean (exit 0) |
| Dev server boot (`mastra dev`, port 4112) | Studio 200, API ready |
| MCP `initialize` on `/api/mcp/nipp-portal/mcp` | 200, protocolVersion 2025-03-26, session id issued |
| `tools/list` | **177 tools** (175 generated + 2 utility) |
| `tools/call portal_session_verify` | success — user "System Administrator", org Platform, permissions `["*"]` |
| `tools/call org_list_admin {page:1,pageSize:3}` | success — live data: Test Tenant Ltd + Platform orgs with member/team counts |

Reproduce with the smoke script pattern in §10 of `PLAN.md`.

## 10. Known limitations / future work

- **No per-client identity**: one shared super-admin session for all MCP
  clients. Multi-user deployments need per-request credentials (MCPClient
  runtime toolsets) or portal API tokens if the portal ever adds them.
- **Spec staleness**: tools regenerate only when the spec file is re-copied.
  A `spec:sync` script (run portal's `docs:generate`, copy, diff) is a natural
  Phase 4 item.
- **No output schemas** on generated tools (responses are `unknown` JSON).
  Adding `outputSchema` from the spec's response objects would give models
  structured content — deferred; responses are already compact JSON.
- **Rate-limit backoff** is a fixed cooldown, not exponential. Fine for a
  single agent; a busy multi-agent setup should add jitter/backoff.
- **MCP Apps (ui://)**: list endpoints could later serve interactive tables in
  Studio — not needed for headless Mistra use.
