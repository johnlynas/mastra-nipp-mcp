import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
import { portalMcpServer } from './mcp/server.js';
import { healthRoute } from './health.js';

export const mastra = new Mastra({
  mcpServers: { portalMcpServer },
  storage: new LibSQLStore({
    id: 'mastra-storage',
    url: process.env.TURSO_DATABASE_URL || 'file:./mastra.db',
    authToken: process.env.TURSO_AUTH_TOKEN || undefined,
  }),
  server: {
    apiRoutes: [
      // Public liveness/readiness probe for the MCP server itself (no auth).
      // Note: /api/* is reserved by Mastra's built-in routes, hence /mcp-health.
      healthRoute(),
    ],
  },
});
