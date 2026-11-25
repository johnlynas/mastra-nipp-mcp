import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateTools } from '../../src/mastra/tools/generate.js';
import type { OpenApiSpec } from '../../src/mastra/spec.js';
import { __setVerifyCallerForTests } from '../../src/mastra/tools/caller.js';
import { __setAuditSinkForTests } from '../../src/mastra/audit.js';

/**
 * Phase 2 task 2: the call-time scope gate is THE security boundary.
 * Admin-scoped tools (/api/admin/*) must return a 403-shaped result for
 * verified non-admin callers BEFORE any portal round-trip — model-independent,
 * and fail-closed when token verification itself fails.
 */

const miniSpec: OpenApiSpec = {
  openapi: '3.1.0',
  info: { title: 'mini', version: '0' },
  paths: {
    '/api/admin/users': {
      get: {
        summary: 'List users (admin)',
        parameters: [{ name: 'page', in: 'query', schema: { type: 'string' } }],
        responses: { 200: { description: 'ok' } },
      },
    },
    '/api/organizations/{orgId}/calendar-events': {
      get: {
        summary: 'List tenant calendar events',
        parameters: [{ name: 'orgId', in: 'path', schema: { type: 'string' } }],
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

const ADMIN_TOOL = 'user_list'; // GET /api/admin/users (single-scope path → no suffix)
const TENANT_TOOL = 'calevent_organizations_calendar_events_list';

const tenantCaller = { userId: 'u_tenant', orgId: 'org_t1', isPlatformAdmin: false };
const adminCaller = { userId: 'u_admin', orgId: 'org_p', isPlatformAdmin: true };

function ctxWithToken(token: string) {
  return { requestContext: new FakeRC().set('authInfo', { token }) };
}

afterEach(() => {
  __setVerifyCallerForTests(async () => null);
  __setAuditSinkForTests(null);
  delete process.env.MCP_ENFORCE_SCOPE_GATE; // default = on
  delete process.env.MCP_ALLOW_SERVICE_FALLBACK; // phase 3: default = off
});

let auditLines: string[] = [];
function collectAudit() {
  auditLines = [];
  __setAuditSinkForTests((line) => auditLines.push(line));
}

describe('call-time admin scope gate (phase 2 task 2)', () => {
  it('blocks _admin tool for non-admin caller with 403, no portal call', async () => {
    const request = vi.fn();
    __setVerifyCallerForTests(async () => tenantCaller);
    const tools = generateTools(miniSpec, { request } as any, ['/api/auth']);

    const out = await tools[ADMIN_TOOL].execute({}, ctxWithToken('tok'));
    expect(out).toMatchObject({ success: false, status: 403 });
    expect(String(out.error)).toMatch(/platform admin/i);
    expect(request).not.toHaveBeenCalled(); // never reached the portal
  });

  it('audits gate rejections: one line with the tenant userId and status 403', async () => {
    collectAudit();
    const request = vi.fn();
    __setVerifyCallerForTests(async () => tenantCaller);
    const tools = generateTools(miniSpec, { request } as any, ['/api/auth']);

    await tools[ADMIN_TOOL].execute({}, ctxWithToken('tok'));
    expect(auditLines).toHaveLength(1);
    const rec = JSON.parse(auditLines[0]);
    expect(rec).toMatchObject({ userId: 'u_tenant', toolId: ADMIN_TOOL, scope: 'admin', status: 403 });
    expect(rec.ts).toBeTypeOf('string');
    expect(rec.latencyMs).toBeTypeOf('number');
  });

  it('audits successful calls with the caller userId and portal status', async () => {
    collectAudit();
    const request = vi.fn(async () => ({ status: 200, ok: true, data: {} }));
    __setVerifyCallerForTests(async () => adminCaller);
    const tools = generateTools(miniSpec, { request } as any, ['/api/auth']);

    await tools[ADMIN_TOOL].execute({}, ctxWithToken('tok'));
    expect(auditLines).toHaveLength(1);
    const rec = JSON.parse(auditLines[0]);
    expect(rec).toMatchObject({ userId: 'u_admin', toolId: ADMIN_TOOL, scope: 'admin', status: 200 });
  });

  it('audits unauthenticated calls as "unverified" with status 401 (fallback off by default)', async () => {
    collectAudit();
    const request = vi.fn();
    __setVerifyCallerForTests(async () => tenantCaller);
    const tools = generateTools(miniSpec, { request } as any, ['/api/auth']);

    const out = await tools[TENANT_TOOL].execute({ orgId: 'org_t1' }, {}); // no token at all
    expect(out).toMatchObject({ success: false, status: 401 });
    expect(request).not.toHaveBeenCalled();
    expect(auditLines).toHaveLength(1);
    const rec = JSON.parse(auditLines[0]);
    expect(rec.status).toBe(401);
    expect(rec.userId).not.toBe('legacy-service'); // no token → not the service account
  });

  it('allows _admin tool for platform admin', async () => {
    const request = vi.fn(async () => ({ status: 200, ok: true, data: {} }));
    __setVerifyCallerForTests(async () => adminCaller);
    const tools = generateTools(miniSpec, { request } as any, ['/api/auth']);

    const out = await tools[ADMIN_TOOL].execute({}, ctxWithToken('tok'));
    expect(out.success).toBe(true);
    expect(request).toHaveBeenCalled();
  });

  it('allows tenant tool for tenant caller (no gate impact)', async () => {
    const request = vi.fn(async () => ({ status: 200, ok: true, data: {} }));
    __setVerifyCallerForTests(async () => tenantCaller);
    const tools = generateTools(miniSpec, { request } as any, ['/api/auth']);

    const out = await tools[TENANT_TOOL].execute({ orgId: 'org_t1' }, ctxWithToken('tok'));
    expect(out.success).toBe(true);
    expect(request).toHaveBeenCalledWith(
      'GET',
      '/api/organizations/{orgId}/calendar-events',
      expect.objectContaining({ bearerToken: 'tok' })
    );
  });

  it('gate disabled via config → falls back to Phase 1 behavior (portal decides)', async () => {
    process.env.MCP_ENFORCE_SCOPE_GATE = '0';
    const request = vi.fn(async () => ({ status: 403, ok: false, data: { error: 'Forbidden' } }));
    __setVerifyCallerForTests(async () => tenantCaller);
    const tools = generateTools(miniSpec, { request } as any, ['/api/auth']);

    const out = await tools[ADMIN_TOOL].execute({}, ctxWithToken('tok'));
    expect(out.success).toBe(false);
    expect(request).toHaveBeenCalled(); // reached the portal — its RBAC returns 403
    expect(out.status).toBe(403);
  });

  it('legacy no-token caller keeps the service-account fallback when explicitly enabled', async () => {
    collectAudit();
    process.env.MCP_ALLOW_SERVICE_FALLBACK = '1';
    const request = vi.fn(async () => ({ status: 200, ok: true, data: {} }));
    __setVerifyCallerForTests(async () => tenantCaller);
    const tools = generateTools(miniSpec, { request } as any, ['/api/auth']);

    await tools[ADMIN_TOOL].execute({}, {}); // no token at all
    expect(request).toHaveBeenCalledWith(
      'GET',
      '/api/admin/users',
      expect.objectContaining({ bearerToken: undefined })
    );
    const rec = JSON.parse(auditLines[0]);
    expect(rec.userId).toBe('legacy-service'); // ran on the service account
  });

  it('no-token call is rejected with 401 by default (phase 3)', async () => {
    const request = vi.fn();
    __setVerifyCallerForTests(async () => tenantCaller);
    const tools = generateTools(miniSpec, { request } as any, ['/api/auth']);

    const out = await tools[ADMIN_TOOL].execute({}, {}); // no token at all
    expect(out).toMatchObject({ success: false, status: 401 });
    expect(request).not.toHaveBeenCalled(); // service account unreachable by default
  });

  it('fail-closed: token present but verification fails → 403, not legacy fallback', async () => {
    const request = vi.fn();
    __setVerifyCallerForTests(async () => null); // invalid / unverifiable token
    const tools = generateTools(miniSpec, { request } as any, ['/api/auth']);

    const out = await tools[ADMIN_TOOL].execute({}, ctxWithToken('tok-bad'));
    expect(out).toMatchObject({ success: false, status: 403 });
    expect(request).not.toHaveBeenCalled(); // must not ride the service account
  });

  it('fail-closed: verification throws (DB down) → 403', async () => {
    const request = vi.fn();
    __setVerifyCallerForTests(async () => { throw new Error('db down'); });
    const tools = generateTools(miniSpec, { request } as any, ['/api/auth']);

    const out = await tools[ADMIN_TOOL].execute({}, ctxWithToken('tok'));
    expect(out).toMatchObject({ success: false, status: 403 });
    expect(request).not.toHaveBeenCalled();
  });
});
