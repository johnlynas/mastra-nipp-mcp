import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateTools } from '../../src/mastra/tools/generate.js';
import type { OpenApiSpec } from '../../src/mastra/spec.js';
import { __setVerifyCallerForTests } from '../../src/mastra/tools/caller.js';

const miniSpec: OpenApiSpec = {
  openapi: '3.1.0',
  info: { title: 'mini', version: '0' },
  paths: {
    '/api/admin/users': {
      get: {
        summary: 'List users (admin)',
        parameters: [
          { name: 'page', in: 'query', schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'ok' } },
      },
    },
  },
  components: { schemas: {} },
};

/** Minimal RequestContext stand-in (same surface the tools use). */
class FakeRC {
  private m = new Map<string, unknown>();
  set(k: string, v: unknown) { this.m.set(k, v); return this; }
  get(k: string) { return this.m.get(k); }
}

const TOOL_ID = 'user_list'; // GET /api/admin/users — no scope suffix (single-scope path)

const fakeCaller = { userId: 'u1', orgId: 'o1', isPlatformAdmin: true };

afterEach(() => {
  __setVerifyCallerForTests(async () => null);
  delete process.env.MCP_ALLOW_SERVICE_FALLBACK; // phase 3: default = off
});

describe('generated tools forward the verified caller token (phase 1)', () => {
  it('passes the verified caller token to client.request', async () => {
    const request = vi.fn(async () => ({ status: 200, ok: true, data: {} }));
    __setVerifyCallerForTests(async (t) => (t === 'tok-ok' ? fakeCaller : null));
    const tools = generateTools(miniSpec, { request } as any, ['/api/auth']);
    const tool = tools[TOOL_ID];
    expect(tool).toBeDefined();

    await tool.execute({ page: 1 }, { requestContext: new FakeRC().set('authInfo', { token: 'tok-ok' }) });
    expect(request).toHaveBeenCalledWith(
      'GET',
      '/api/admin/users',
      expect.objectContaining({ bearerToken: 'tok-ok' })
    );
  });

  it('rejects (no token) by default — phase 3 removed the implicit fallback', async () => {
    const request = vi.fn(async () => ({ status: 200, ok: true, data: {} }));
    __setVerifyCallerForTests(async (t) => (t === 'tok-ok' ? fakeCaller : null));
    const tools = generateTools(miniSpec, { request } as any, ['/api/auth']);

    const out = await tools[TOOL_ID].execute({ page: 1 }, {});
    expect(out).toMatchObject({ success: false, status: 401 });
    expect(request).not.toHaveBeenCalled();
  });

  it('keeps the service-account fallback when MCP_ALLOW_SERVICE_FALLBACK=1', async () => {
    process.env.MCP_ALLOW_SERVICE_FALLBACK = '1';
    const request = vi.fn(async () => ({ status: 200, ok: true, data: {} }));
    __setVerifyCallerForTests(async (t) => (t === 'tok-ok' ? fakeCaller : null));
    const tools = generateTools(miniSpec, { request } as any, ['/api/auth']);

    await tools[TOOL_ID].execute({ page: 1 }, {});
    expect(request).toHaveBeenCalledWith(
      'GET',
      '/api/admin/users',
      expect.objectContaining({ bearerToken: undefined })
    );
  });

  it('fail-closed (phase 2): token present but failing verification → 403, no portal call', async () => {
    const request = vi.fn(async () => ({ status: 200, ok: true, data: {} }));
    __setVerifyCallerForTests(async () => null); // invalid token
    const tools = generateTools(miniSpec, { request } as any, ['/api/auth']);

    const out = await tools[TOOL_ID].execute({ page: 1 }, { requestContext: new FakeRC().set('authInfo', { token: 'tok-bad' }) });
    expect(out).toMatchObject({ success: false, status: 403 });
    expect(request).not.toHaveBeenCalled(); // must not ride the service account
  });

  it('reads the explicit mastra__mcpToken key as a fallback source', async () => {
    const request = vi.fn(async () => ({ status: 200, ok: true, data: {} }));
    __setVerifyCallerForTests(async (t) => (t === 'tok-explicit' ? fakeCaller : null));
    const tools = generateTools(miniSpec, { request } as any, ['/api/auth']);

    await tools[TOOL_ID].execute({ page: 1 }, { requestContext: new FakeRC().set('mastra__mcpToken', 'tok-explicit') });
    expect(request).toHaveBeenCalledWith(
      'GET',
      '/api/admin/users',
      expect.objectContaining({ bearerToken: 'tok-explicit' })
    );
  });
});
