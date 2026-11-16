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
