import { afterEach, describe, it, expect, vi } from 'vitest';
import { PortalClient } from '../../src/mastra/client.js';

const cfg = {
  baseUrl: 'http://portal.test',
  email: '',
  password: '',
  defaultOrgId: 'org_p',
  excludePathPrefixes: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.MCP_ALLOW_SERVICE_FALLBACK;
});

describe('PortalClient per-request token', () => {
  it('forwards the caller token as Authorization and never signs in', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) =>
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const c = new PortalClient(cfg as any);
    await c.request('GET', '/api/organizations/org_t1/work-orders', {
      bearerToken: 'tok-user-123',
      orgId: 'org_t1',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1); // no sign-in call
    const [, init] = fetchMock.mock.calls[0];
    const headers = (init as unknown as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok-user-123');
    expect(headers['x-org-id']).toBe('org_t1');
  });

  it('falls back to service sign-in when no token and fallback allowed', async () => {
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        n++;
        if (String(url).includes('/api/auth/sign-in/email')) {
          return new Response(JSON.stringify({ token: 'svc-tok' }), {
            status: 200,
            headers: { 'set-auth-token': 'svc-tok', 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      })
    );
    process.env.MCP_ALLOW_SERVICE_FALLBACK = '1';
    const c = new PortalClient({ ...cfg, email: 'a@x.io', password: 'p' } as any);
    await c.request('GET', '/api/admin/users');
    expect(n).toBe(2); // sign-in + request
  });

  it('rejects by default when no token (phase 3 — flag unset)', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const c = new PortalClient(cfg as any);
    await expect(c.request('GET', '/api/admin/users')).rejects.toThrow(/no caller token/i);
  });

  it('rejects when no token and fallback disabled', async () => {
    vi.stubGlobal('fetch', vi.fn());
    process.env.MCP_ALLOW_SERVICE_FALLBACK = '0';
    const c = new PortalClient(cfg as any);
    await expect(c.request('GET', '/api/admin/users')).rejects.toThrow(/no caller token/i);
  });

  it('does not retry on 401 for a caller-token request (the portal already rejected the user)', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ message: 'forbidden' }), { status: 403, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const c = new PortalClient(cfg as any);
    const res = await c.request('GET', '/api/admin/users', { bearerToken: 'tok-user' });
    expect(res.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
