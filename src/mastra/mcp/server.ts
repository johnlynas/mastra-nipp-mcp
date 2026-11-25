/**
 * The NIPP Portal MCP server.
 *
 * Exposes the portal's admin API (generated from the OpenAPI spec) plus
 * utility tools to any MCP client — Mistra, Claude Desktop, Cursor, etc.
 */
import { MCPServer } from '@mastra/mcp';
import { loadConfig } from '../config.js';
import type { PortalMcpConfig } from '../config.js';
import { PortalClient } from '../client.js';
import { buildPortalTools } from '../tools/generate.js';
import { healthCheckTool, sessionVerifyTool } from '../tools/utility.js';
import { filterToolsForCaller } from '../tools/filter.js';
import { verifyCaller } from '../auth.js';

/**
 * Shared PortalClient instance, hoisted to globalThis.
 *
 * The Mastra dev server re-imports modules between requests (worker-thread
 * reload), which would otherwise create a fresh client per request — and thus
 * a fresh portal sign-in per tool call, tripping the portal's sign-in rate
 * limit (429). A single shared instance signs in once and reuses the session.
 */
const g = globalThis as unknown as { __portalClient?: PortalClient };
export function getPortalClient(config: PortalMcpConfig): PortalClient {
  if (!g.__portalClient) {
    g.__portalClient = new PortalClient(config);
  }
  return g.__portalClient;
}

const config = loadConfig();
const client = getPortalClient(config);

const portalTools = buildPortalTools(config, client);

export const portalMcpServer = new MCPServer({
  id: 'nipp-portal',
  name: 'NIPP Portal MCP Server',
  version: '1.0.0',
  description:
    'Control the NIPP property-management portal (admin/Platform org) via its REST API: organizations, users, roles, permissions, teams, work orders, contractors, invoices, quotes, resources, units, jobs, scripts and more.',
  instructions: `
This server exposes the NIPP portal's admin API. The server acts as a Platform-organization
admin session; every call is forwarded to ${config.baseUrl} with that session.

Conventions:
- Tool ids are grouped by the portal's service domains: \`user_list_admin\` = GET /api/admin/users,
  \`wo_transition_transition\` = POST /api/admin/work-orders/{id}/transition,
  \`calevent_organizations_calendar_events_list\` = list a tenant's calendar events.
- Domains: org, user, role, perm, team, wo (work orders), wonote, contractor, invoice, quote,
  resource, unit, job (scheduler), script, calendar/calevent/calnotif, system, security, notif.
- Scope suffixes mark where an operation lives: _admin (/api/admin), _dash (/api/dashboard/admin),
  _tenant (/api/organizations/{orgId}). No suffix = single scope.
- Most operations are scoped to an organization (tenant isolation). Pass \`orgId\` to target
  a specific tenant; when omitted the Platform org is used by default.
- List endpoints support pagination via \`page\` and \`pageSize\` where documented.
- If a call returns success:false with status 401, the portal session expired — call
  \`portal_session_verify\`; the server re-authenticates automatically on the next call.
- Destructive operations (delete, ban, status changes) are real — confirm intent before use.
`.trim(),
  tools: {
    ...portalTools,
    portal_health: healthCheckTool(client),
    portal_session_verify: sessionVerifyTool(client),
  },
});

/**
 * Phase 2 task 3: per-caller tools/list filtering.
 *
 * @mastra/mcp 2.9 has no public per-request tool-list hook (the FGA path in
 * `authorizedToolEntries` only runs when a Mastra FGA provider is configured),
 * so we wrap the server's own `authorizedToolEntries` — the single method both
 * the protocol `tools/list` handler and `getToolListInfo` (Mastra REST/Studio)
 * go through. The caller is resolved from the same requestContext key the
 * generated tools use (`authInfo.token`, set by the setRequestAuth bridge):
 * - no token / verification failed → unfiltered (legacy surface, phase 3 removes it)
 * - verified non-admin → _admin tools dropped
 * - platform admin → full list
 */
const serverAny = portalMcpServer as unknown as {
  authorizedToolEntries: (rc?: { get: (k: string) => unknown }) => Promise<[string, unknown][]>;
};
const baseAuthorizedToolEntries = serverAny.authorizedToolEntries.bind(portalMcpServer);
serverAny.authorizedToolEntries = async (requestContext) => {
  const entries = await baseAuthorizedToolEntries(requestContext);
  if (!requestContext) return entries;
  const authInfo = requestContext.get('authInfo') as { token?: string } | undefined;
  const explicit = requestContext.get('mastra__mcpToken');
  const token =
    (typeof authInfo?.token === 'string' && authInfo.token) ||
    (typeof explicit === 'string' && explicit) ||
    '';
  if (!token) return entries; // legacy token-less request → full surface
  const caller = await verifyCaller(token); // never throws (fail-closed internally)
  if (!caller) return entries; // unverified → keep the full surface for listing;
                               // the call-time scope gate stays authoritative
  const visible = filterToolsForCaller(
    Object.fromEntries(entries.map(([id, tool]) => [id, tool])) as Record<string, { id?: string }>,
    caller,
  );
  return entries.filter(([id]) => id in visible);
};
