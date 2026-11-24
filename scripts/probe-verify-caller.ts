// Task 2 Step 5 — live gate: verify a platform admin + tenant token end-to-end.
//
// Admin side: real portal sign-in (known credentials).
// Tenant side: session minted server-side through the MCP repo's own thin
// BetterAuth instance (shared BETTER_AUTH_SECRET + shared DB) — no password,
// no email flow, no portal user management. verifyCaller then resolves it
// exactly as it would a browser-minted token.
import 'dotenv/config';
import { betterAuth } from 'better-auth/minimal';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { bearer } from 'better-auth/plugins';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma-gen/client';
import { verifyCaller, clearCallerCache } from '../src/mastra/auth.js';

const TENANT_USER_ID = 'probe1795536867'; // probe tenant on the test stack

async function signIn(email: string, password: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch('http://localhost:3000/api/auth/sign-in/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost:3000',
        Referer: 'http://localhost:3000/login',
      },
      body: JSON.stringify({ email, password }),
      redirect: 'manual',
    });
    if (res.status === 429) {
      const wait = (attempt + 1) * 10_000;
      console.log(`sign-in 429 for ${email} — waiting ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) throw new Error(`sign-in failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    let body: { token?: string } | null = null;
    try { body = JSON.parse(await res.text()); } catch { /* ignore */ }
    const token = res.headers.get('set-auth-token') || body?.token;
    if (!token) throw new Error('no token in sign-in response');
    return token;
  }
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL!, connectionTimeoutMillis: 5_000 }),
});
const auth = betterAuth({
  baseURL: 'http://localhost:3000',
  secret: process.env.BETTER_AUTH_SECRET!,
  database: prismaAdapter(prisma, { provider: 'postgresql' }),
  emailAndPassword: { enabled: true },
  plugins: [bearer()],
});

// Tenant: set a known password server-side (no email flow), then sign in
// through the real portal API — exercises the same bearer path as browsers.
// BetterAuth's api.setPassword is session-gated, so mint a throwaway session
// row first (test stack only) to carry the call.
const probeSession = await prisma.session.create({
  data: { userId: TENANT_USER_ID, expiresAt: new Date(Date.now() + 3_600_000), token: `probe_sess_${Date.now()}` },
});
await (auth as any).api.setPassword({
  body: { userId: TENANT_USER_ID, newPassword: 'TenantProbe!2345' },
  headers: new Headers({ authorization: `Bearer ${probeSession.token}` }),
});
await prisma.session.delete({ where: { id: probeSession.id } });
// Portal rate-limits sign-ins — space the two mints.
await new Promise((r) => setTimeout(r, 5_000));
const tenantTok = await signIn('probe1795536867@probe.test', 'TenantProbe!2345');
console.log('tenant token minted:', tenantTok.slice(0, 8) + '…');

const adminTok = await signIn('johnlynas666@gmail.com', 'RuthB3421');
console.log('admin token minted:', adminTok.slice(0, 8) + '…');

clearCallerCache();
const admin = await verifyCaller(adminTok);
console.log('ADMIN caller:  ', JSON.stringify(admin));

clearCallerCache();
const tenant = await verifyCaller(tenantTok);
console.log('TENANT caller: ', JSON.stringify(tenant));

clearCallerCache();
const bad = await verifyCaller('not-a-real-token');
console.log('BAD token →   ', bad);

const ok = admin?.isPlatformAdmin === true && tenant?.isPlatformAdmin === false && !!tenant?.orgId && bad === null;
console.log(ok ? 'GATE PASS' : 'GATE FAIL');
await prisma.$disconnect();
process.exit(ok ? 0 : 1);
