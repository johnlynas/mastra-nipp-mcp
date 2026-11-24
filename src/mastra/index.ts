import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
import { portalMcpServer } from './mcp/server.js';
import { healthRoute } from './health.js';

/**
 * Phase 1 per-request caller identity: surface the incoming
 * `Authorization: Bearer <portal session token>` as `req.auth` on every MCP
 * request. Mastra's auth bridge then puts it in the tool execution context as
 * `requestContext.get('authInfo').token`, where the generated tools read and
 * verify it (src/mastra/tools/caller.ts → verifyCaller) before forwarding the
 * call to the portal under the CALLER's session.
 *
 * The token is passed through opaquely here — verification happens in
 * verifyCaller (shared BETTER_AUTH_SECRET + DB), and the token is never logged.
 */
function setRequestAuth(req: { headers: { authorization?: string | string[] } }): void {
  const header = req.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  const match = value?.match(/^Bearer\s+(.+)$/i);
  if (match?.[1]) {
    (req as any).auth = { token: match[1], clientId: '', scopes: [] };
  }
}

export const mastra = new Mastra({
  mcpServers: { portalMcpServer },
  storage: new LibSQLStore({
    id: 'mastra-storage',
    url: process.env.TURSO_DATABASE_URL || 'file:./mastra.db',
    authToken: process.env.TURSO_AUTH_TOKEN || undefined,
  }),
  server: {
    mcpOptions: { setRequestAuth },
    apiRoutes: [
      // Public liveness/readiness probe for the MCP server itself (no auth).
      // Note: /api/* is reserved by Mastra's built-in routes, hence /mcp-health.
      healthRoute(),
    ],
  },
});
