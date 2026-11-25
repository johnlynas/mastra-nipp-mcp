import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { Hono } from 'hono';
import { createHonoServer } from '@mastra/deployer/server';
import { MCPClient, type MastraFetchLike } from '@mastra/mcp';
import { mastra } from '../../src/mastra/index.js';
import { __setDepsForTests } from '../../src/mastra/auth.js';
import { __setAuditSinkForTests } from '../../src/mastra/audit.js';

/**
 * Phase 3 task 4 — context-propagation CANARY (design doc R5).
 *
 * The whole per-user authz design leans on `@mastra/mcp` + Mastra's server
 * adapter passing the request's `Authorization: Bearer *** header through
 * `setRequestAuth` → `requestContext('authInfo')` → tool `execute`. This test
 * boots the REAL production stack in-process (Mastra instance + createHonoServer
 * + the real portalMcpServer) and drives it with the REAL MCPClient over a
 * custom fetch — proving one thing: a token sent on the wire arrives inside the
 * tool's execute context.
 *
 * It is deliberately green-by-construction — it must PASS today. Before bumping
 * `@mastra/mcp` (or `@mastra/core`/`@mastra/server`), run this test first; a
 * failure means the requestContext/authInfo plumbing changed and the authz
 * model silently degrades (tokens stop reaching verifyCaller). See SECURITY.md
 * "Framework upgrade checklist".
 */

const CANARY_TOKEN = 'canary-token-do-not-leak';

let server: Hono | undefined;
let mcp: MCPClient | undefined;

beforeAll(async () => {
  // Hermetic auth: fake session → known user id. No DB, no portal — the canary
  // is about PLUMBING, not verification (auth.test.ts covers that).
  __setDepsForTests({
    getSession: async ({ headers }: { headers: Headers }) => {
      const auth = headers.get('authorization') ?? '';
      return auth.includes(CANARY_TOKEN) ? { user: { id: 'u_canary' } } : null;
    },
    prisma: {
      user: { findUnique: async () => ({ banned: false, banExpires: null, activeOrganizationId: 'org_canary' }) },
      member: { findFirst: async () => ({ id: 'm1' }) },
    },
  });
  // Keep the audit file clean during tests.
  __setAuditSinkForTests(() => {});

  server = (await createHonoServer(mastra)) as unknown as Hono;

  // Route the MCP client's fetch to the in-process Hono app, injecting the
  // canary Authorization header on every request (mirrors the agent's hook).
  const fetchToApp: MastraFetchLike = async (url, init) => {
    const headers = new Headers(init?.headers);
    headers.set('authorization', `Bearer ${CANARY_TOKEN}`);
    return server!.fetch(new Request(url as URL, { ...init, headers }));
  };

  mcp = new MCPClient({
    id: 'context-canary-client',
    servers: { nippPortal: { url: new URL('http://localhost/api/mcp/nipp-portal/mcp'), fetch: fetchToApp } },
  });
});

afterAll(async () => {
  (globalThis as any).mcpAuthDeps = undefined;
  __setAuditSinkForTests(null);
});

describe('context propagation canary (phase 3 task 4)', () => {
  it('a tools/call Authorization header reaches the tool execute context', async () => {
    expect(server).toBeDefined();
    expect(mcp).toBeDefined();

    // List tools to force a full initialize + handshake, then call the canary.
    const { tools, errors } = await mcp!.listToolsWithErrors();
    if (errors.nippPortal) throw new Error(`MCP server unreachable: ${errors.nippPortal}`);
    const tool = tools['nippPortal_context_canary'];
    expect(tool, 'context_canary tool should be listed').toBeDefined();

    const raw = await (tool as { execute: (i: unknown, c?: unknown) => Promise<unknown> }).execute({}, undefined);
    const content = (raw as { content?: Array<{ type?: string; text?: string }> })?.content?.[0]?.text ?? '';
    const observed = JSON.parse(content || '{}') as { tokenSha256?: string | null; verifiedUserId?: string | null };

    // THE assertion: the wire token reached the execute context (fingerprint match).
    expect(observed.tokenSha256).toBe(createHash('sha256').update(CANARY_TOKEN).digest('hex'));
    // And verification resolved it to the fake user — plumbing end to end.
    expect(observed.verifiedUserId).toBe('u_canary');
  }, 30_000);
});
