/**
 * Hand-written utility tools that are not generated from the spec.
 *
 * Phase 3: audited like every other tool call — scope 'system', verified user
 * id (or 'legacy-service' / 'unverified'), never the token.
 */
import { createHash } from 'node:crypto';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { PortalClient } from '../client.js';
import { resolveCaller, extractTokenFromContext } from './caller.js';
import { logToolCall } from '../audit.js';

/** Shared audit wrapper for the diagnostic tools. */
async function auditedExecute(
  toolId: string,
  context: unknown,
  fn: () => Promise<any>,
): Promise<any> {
  const startedAt = Date.now();
  const resolved = await resolveCaller(context);
  const userId =
    resolved.caller?.userId ?? (resolved.token === null && !resolved.verifyFailed ? 'legacy-service' : 'unverified');
  let result: any;
  try {
    result = await fn();
  } catch (err) {
    logToolCall({ userId, toolId, scope: 'system', status: 500, latencyMs: Date.now() - startedAt });
    throw err;
  }
  logToolCall({
    userId,
    toolId,
    scope: 'system',
    status: typeof result?.status === 'number' ? result.status : 500,
    latencyMs: Date.now() - startedAt,
  });
  return result;
}

export function healthCheckTool(client: PortalClient) {
  return createTool({
    id: 'portal_health',
    description:
      'Check NIPP portal API health (database, cache, connection pool). Use to verify connectivity before other operations.',
    inputSchema: z.object({}),
    execute: async (_input: any, context?: any) => {
      return auditedExecute('portal_health', context, async () => {
        const res = await client.request('GET', '/api/health');
        return { success: res.ok, status: res.status, data: res.data };
      });
    },
  });
}

export function sessionVerifyTool(client: PortalClient) {
  return createTool({
    id: 'portal_session_verify',
    description:
      'Verify the MCP server\'s portal session is active and report the authenticated user, their organization, and permissions. Use when a call returns 401/403 or to confirm which identity/org the server acts as.',
    inputSchema: z.object({}),
    execute: async (_input: any, context?: any) => {
      return auditedExecute('portal_session_verify', context, async () => {
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
      });
    },
  });
}

/**
 * Context-propagation canary (phase 3 task 4). Echoes back a SHA-256
 * fingerprint of the raw token observed in this tool's execution context plus
 * the verified caller identity — WITHOUT ever returning the token itself.
 * Used by tests/integration/context-propagation.test.ts to prove that an
 * `Authorization: Bearer *** header on the wire reaches `requestContext`
 * inside tool execute (the plumbing the whole authz model depends on).
 */
export function contextCanaryTool() {
  return createTool({
    id: 'context_canary',
    description:
      'Diagnostic: reports a SHA-256 fingerprint of the request token observed in this tool\'s execution context and the verified caller. For integration tests only — not a portal operation.',
    inputSchema: z.object({}),
    execute: async (_input: any, context?: any) => {
      const raw = extractTokenFromContext(context);
      const resolved = await resolveCaller(context);
      return {
        tokenSha256: raw ? createHash('sha256').update(raw).digest('hex') : null,
        verifiedUserId: resolved.caller?.userId ?? null,
        isPlatformAdmin: resolved.caller?.isPlatformAdmin ?? false,
      };
    },
  });
}
