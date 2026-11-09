/**
 * Hand-written utility tools that are not generated from the spec.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { PortalClient } from '../client.js';

export function healthCheckTool(client: PortalClient) {
  return createTool({
    id: 'portal_health',
    description:
      'Check NIPP portal API health (database, cache, connection pool). Use to verify connectivity before other operations.',
    inputSchema: z.object({}),
    execute: async () => {
      const res = await client.request('GET', '/api/health');
      return { success: res.ok, status: res.status, data: res.data };
    },
  });
}

export function sessionVerifyTool(client: PortalClient) {
  return createTool({
    id: 'portal_session_verify',
    description:
      'Verify the MCP server\'s portal session is active and report the authenticated user, their organization, and permissions. Use when a call returns 401/403 or to confirm which identity/org the server acts as.',
    inputSchema: z.object({}),
    execute: async () => {
      const me = await client.request('GET', '/api/auth/me');
      if (!me.ok) {
        return { success: false, status: me.status, error: 'Session not active — sign-in may have failed' };
      }
      const perms = await client.request('GET', '/api/auth/user-permissions');
      return {
        success: true,
        user: me.data,
        permissions: perms.ok ? perms.data : null,
      };
    },
  });
}
