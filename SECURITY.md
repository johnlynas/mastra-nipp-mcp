# Security

## Reporting vulnerabilities

Please report security issues privately via a GitHub Security Advisory on this repository (do not open a public issue).

## npm audit status

Checks gate on `npm audit --audit-level=high` — the command must exit 0 for CI and local verification. Current state against the committed lockfile:

| Severity | Count | Notes |
| --- | --- | --- |
| high / critical | 0 | — |
| low | 4 | All four entries are a single advisory, [GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4), counted once per package in the chain below |

The only finding is `deepmerge` prototype poisoning (CWE-1321, CVSS 5.3) in a dev-only toolchain chain:

```
mastra@1.39.0 → @mastra/deployer@1.83.0 → @rollup/plugin-node-resolve@16.0.3 → deepmerge@4.3.1
```

### Accepted risks

Findings that cannot be fixed without breaking changes, or for which no patched upstream version exists, are tracked here with their rationale. Re-check each row when the owning dependency chain is upgraded.

| Package | Advisory | Severity | Status | Rationale / follow-up |
| --- | --- | --- | --- | --- |
| deepmerge (transitive via @rollup/plugin-node-resolve → @mastra/deployer) | [GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4) | low | Accepted — no patched version published (latest is 4.3.1, inside the vulnerable range `>=4.2.0 <=4.3.1`) | Dev-only toolchain chain (used by mastra's deployer bundling), not reachable from runtime request handling. Re-check on next major mastra release; npm audit currently reports the fix as `mastra@0.1.56`, which is a downgrade and not viable. |

### Pinned overrides

`package.json` contains `overrides` that force patched transitive versions beyond what upstream ranges allow:

- `@hono/node-server` → `^2.1.8` (fixes GHSA-rmxm-3fg6-px4f, serveStatic double-decode middleware bypass; pulled in via @mastra/deployer and @modelcontextprotocol/node).
- `minimatch` → `^11.0.8` (fixes GHSA-g3hv-75wg-m249, globparts DoS; pulled in via readdir-glob/archiver and serve-handler).

Drop each override once the upstream chain publishes compatible ranges.

## Recent remediation

Commit `b81c8b8` reduced the audit from 14 findings (including high-severity MCP SDK issues) to the single accepted low above:

| Package | Change | Advisories addressed |
| --- | --- | --- |
| @modelcontextprotocol/client | 2.0.0 → 2.4.0 | GHSA-6qxp-vccf-f47h, GHSA-6prh-2h8m-c8cw |
| @modelcontextprotocol/server | 2.0.0 → 2.4.0 | GHSA-jm63-cq47-j5jp, GHSA-46jr-4wx8-v453, GHSA-rvq5-wwqv-78pq, GHSA-f897-62hf-6gxq |
| @modelcontextprotocol/node | 2.0.0 → 2.1.2 | GHSA-f897-62hf-6gxq |
| @mastra/mcp | ^1.15.0 → ^2.9.0 | Pins the patched MCP SDKs; peer requirements pulled in @mastra/core 1.83.0, @mastra/libsql 1.30.0, mastra CLI 1.39.0 |

`@modelcontextprotocol/server-legacy` was removed from the tree as part of the same bump.

## Per-request user authorization (phase 1–3)

The MCP server no longer executes every tool call under its own long-lived
Platform super-admin session. Each call runs under the **calling user's** portal
session, and admin-scoped endpoints are unreachable for non-admins — enforced
server-side, independent of any LLM prompt. Design doc:
`mastra-nipp-agent/.hermes/plans/2026-11-23_234507-mcp-per-user-authz.md`.

### Architecture flow

| Step | Where | What happens |
| --- | --- | --- |
| 1. Chat request | agent `/api/chat` | Portal session cookie/bearer verified (shared `BETTER_AUTH_SECRET` + shared PostgreSQL); user id → `mastra__resourceId`, session token → `mastra__portalSessionToken` in requestContext. Banned users rejected fail-closed. |
| 2. Tool dispatch | agent `callMcpTool()` | Role-filtered: admin-scoped tool ids blocked for non-admin callers before the MCP transport (defense in depth). Caller's active org injected as default `orgId`. |
| 3. Transport | agent `MCPClient` custom `fetch` | Injects `Authorization: Bearer *** user's portal session token>` on every MCP request. The token is never read from the client body. |
| 4. Verification | MCP `auth.ts` `verifyCaller()` | Thin BetterAuth instance (same secret + DB) resolves the token → `{ userId, orgId, isPlatformAdmin }`. 60s per-token-hash cache. Any error → null (fail closed). |
| 5. Scope gate | MCP `generate.ts` execute | `_admin` tools (`/api/admin/*`) require `isPlatformAdmin`; non-admin → **403 before any portal round-trip**. Unverifiable token → 403 (admin) / 401 (other). No token → **401** (phase 3 default). |
| 6. Forwarding | MCP `PortalClient` | Caller's token forwarded verbatim as `Authorization: Bearer *** — no service sign-in, no re-auth retry on caller 401/403 (re-signing the service account would silently escalate). |
| 7. Final authority | portal RBAC/RLS | Unchanged. Every call is re-checked by the portal's own `requirePermission` + Postgres RLS under the non-owner `nipp_app` role. |

### Gate semantics

- `_admin` (`/api/admin/*`): platform-org membership required (mirror of the
  portal's `verifySuperAdmin`). Non-admin → 403, never reaches the portal.
- `_dash` (`/api/dashboard/admin/*`): **not** gated in MCP — the portal's
  `requirePermission` enforces org-admin rights per target org and returns its
  own 403 (design doc open question 1, resolved: portal is the authority).
- `_tenant` / single-scope tools: run under the caller's session with their org context.
- Tool list filtering: non-admin callers don't see `_admin` tools in `tools/list`
  (UX + reduced injection surface); the call-time gate remains authoritative.

### Legacy service fallback (phase 3: off by default)

`MCP_ALLOW_SERVICE_FALLBACK` controls whether a token-less tool call may run on
the server's Platform super-admin session:

- **default (`0` / unset): OFF** — token-less calls get `401`; the super-admin
  session is unreachable from MCP.
- `1`: restores pre-phase-3 behavior for Studio / ad-hoc scripts (announced via
  this section + `.env.example`). Rollback needs only an env reload.

### Audit log

Every tool call — success, portal rejection, gate 403, unauthenticated 401, and
500 on throw — appends one JSON line to `MCP_AUDIT_LOG_FILE` (default
`./audit/mcp-audit.log`):

```json
{ "ts": "2026-11-25T11:00:00.000Z", "userId": "u_abc123", "toolId": "user_list_admin", "scope": "admin", "orgId": "cmw_platform", "status": 403, "latencyMs": 2 }
```

- `userId`: verified user id; `legacy-service` only when the opt-in fallback ran;
  `unverified` for token-less/failed-verification rejections.
- Tokens and request bodies are **never** logged — the field whitelist is
  enforced at the boundary (`src/mastra/audit.ts`).
- Local file first (design doc open question 2, resolved); portal `AuditLog`
  table writes are a named follow-up. Size-based rotation is a named follow-up.

### Framework upgrade checklist (R5)

The authz model depends on `@mastra/mcp` + Mastra's server adapter passing the
request's `Authorization` header into tool execute via
`setRequestAuth → requestContext('authInfo')`. **Before bumping
`@mastra/mcp`, `@mastra/core`, `@mastra/server`, or `mastra`:**

1. Run `npx vitest run tests/integration/context-propagation.test.ts` — the
   canary boots the real production stack in-process and asserts a wire token
   reaches the tool execute context (SHA-256 fingerprint, never the raw token).
2. If it fails, do **not** bump: the plumbing changed and tokens would silently
   stop reaching `verifyCaller` (calls degrade to 401, or worse, to the service
   account if the fallback is enabled).

Pinned versions: `@mastra/mcp ^2.9.0`, `@mastra/core 1.83.0`, `mastra 1.39.0`.

### Threat model (what each layer stops)

| Attack | Stopped by |
| --- | --- |
| Tenant user asks LLM to list all orgs / ban a user | Phase 2 gate: `_admin` tools → 403 before the portal; tool hidden from the model in `tools/list` |
| Prompt injection makes the model call an admin tool | Same — server-side, model-independent |
| Malicious MCP client calls `tools/call` directly with a tenant token | Same gate + portal RBAC (defense in depth) |
| Client sends no token | 401 by default (phase 3); service account reachable only with `MCP_ALLOW_SERVICE_FALLBACK=1` |
| Stale/revoked session token | BetterAuth verification is a DB lookup per token (cached ≤60s) + portal rejects expired sessions with 401 |
| Banned user | `verifyCaller` checks `banned`/`banExpires` (same rule as the agent's `authorizeUser`) → reject |
| Token leakage in logs | Audit log stores caller user id, never the token; field whitelist at the boundary; canary tool reports a SHA-256 fingerprint only |

