import { describe, it, expect, vi } from 'vitest';
import { verifyCaller, __setDepsForTests, clearCallerCache } from '../../src/mastra/auth.js';

const fakeSession = { user: { id: 'u_tenant', name: 'T', email: 't@x.io' } };
function deps(getSession: unknown, prisma: unknown) {
  __setDepsForTests({ getSession: getSession as any, prisma: prisma as any });
}

describe('verifyCaller', () => {
  it('rejects empty token', async () => {
    deps(vi.fn(), {});
    await expect(verifyCaller('')).resolves.toBeNull();
  });
  it('rejects invalid session', async () => {
    deps(async () => null, {});
    await expect(verifyCaller('tok-bad')).resolves.toBeNull();
  });
  it('resolves tenant caller with org + non-admin flag', async () => {
    process.env.PLATFORM_ORG_ID = 'org_platform';
    clearCallerCache();
    deps(async () => fakeSession, { user: { findUnique: async () => ({ banned: false, banExpires: null, activeOrganizationId: 'org_t1' }) }, member: { findFirst: async () => null } });
    const c = await verifyCaller('tok-tenant');
    expect(c).toMatchObject({ userId: 'u_tenant', orgId: 'org_t1', isPlatformAdmin: false });
  });
  it('flags platform admin via Member row for PLATFORM_ORG_ID', async () => {
    process.env.PLATFORM_ORG_ID = 'org_platform';
    clearCallerCache();
    deps(async () => fakeSession, { user: { findUnique: async () => ({ banned: false, banExpires: null, activeOrganizationId: 'org_platform' }) }, member: { findFirst: async () => ({ id: 'm1' }) } });
    expect((await verifyCaller('tok-admin'))?.isPlatformAdmin).toBe(true);
  });
  it('rejects banned user (active ban)', async () => {
    clearCallerCache();
    deps(async () => fakeSession, { user: { findUnique: async () => ({ banned: true, banExpires: new Date(Date.now() + 864e5), activeOrganizationId: 'org_t1' }) } });
    await expect(verifyCaller('tok-banned')).resolves.toBeNull();
  });
  it('caches by token (second call hits no DB)', async () => {
    const findUnique = vi.fn(async () => ({ banned: false, banExpires: null, activeOrganizationId: 'org_t1' }));
    deps(async () => fakeSession, { user: { findUnique: findUnique }, member: { findFirst: async () => null } });
    clearCallerCache();
    await verifyCaller('tok-cache');
    await verifyCaller('tok-cache');
    expect(findUnique).toHaveBeenCalledTimes(1);
  });
});
