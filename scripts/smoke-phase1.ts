// Phase 1 Task 9 — integration smoke against the live MCP dev server (:4112) + portal (:3000).
//
// Uses @mastra/mcp's MCPClient with a per-call Authorization fetch hook —
// exactly the transport the agent uses (portalMcpFetch in mastra-nipp-agent).
//
// Scenarios (exit criteria):
//   1. tenant token  → wo list (their org)        → 200, data scoped to their org
//   2. tenant token  → user_list (admin users)    → 403 from the portal (RBAC)
//   3. admin token   → user_list (admin users)    → 200
//   4. no token      → user_list                  → works via legacy service fallback
import 'dotenv/config';
import { betterAuth } from 'better-auth/minimal';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { bearer } from 'better-auth/plugins';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma-gen/client';
import { MCPClient, type MastraFetchLike } from '@mastra/mcp';

const MCP_URL = 'http://localhost:4112/api/mcp/nipp-portal/mcp'; // same URL the agent's config uses
const TENANT_USER_ID = 'probe1795536867'; // probe tenant on the test stack

// ── token minting (same approach as scripts/probe-verify-caller.ts) ──────────
async function signIn(email: string, password: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch('http://localhost:3000/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000', Referer: 'http://localhost:3000/login' },
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

const probeSession = await prisma.session.create({
  data: { userId: TENANT_USER_ID, expiresAt: new Date(Date.now() + 3_600_000), token: `probe_sess_${Date.now()}` },
});
try {
  await (auth as any).api.setPassword({
    body: { userId: TENANT_USER_ID, newPassword: 'TenantProbe!2345' },
    headers: new Headers({ authorization: `Bearer ${probeSession.token}` }),
  });
} catch (e) {
  if (!/PASSWORD_ALREADY_SET/.test(JSON.stringify(e))) throw e;
  // already TenantProbe!2345 from a previous run — fine.
}
await prisma.session.delete({ where: { id: probeSession.id } });
await new Promise((r) => setTimeout(r, 5_000)); // portal sign-in rate limit
const tenantTok = await signIn('probe1795536867@probe.test', 'TenantProbe!2345');
await new Promise((r) => setTimeout(r, 5_000));
const adminTok = await signIn('johnlynas666@gmail.com', 'RuthB3421');
console.log('tokens minted (tenant + admin)');

// ── MCP client with per-call Authorization (mirrors the agent's portalMcpFetch) ─
let currentToken: string | null = null;
const authFetch: MastraFetchLike = async (url, init) => {
  const headers = new Headers(init?.headers);
  if (currentToken) headers.set('authorization', `Bearer ${currentToken}`);
  return fetch(url as URL, { ...init, headers });
};

const mcp = new MCPClient({
  id: 'phase1-smoke-client',
  servers: { nippPortal: { url: new URL(MCP_URL), fetch: authFetch } },
});
const { tools, errors } = await mcp.listToolsWithErrors();
if (errors.nippPortal) throw new Error(`MCP server unreachable: ${errors.nippPortal}`);
console.log('tools listed:', Object.keys(tools).length);

async function callTool(name: string, args: Record<string, unknown>): Promise<{ status?: number; data?: any; error?: string }> {
  const tool = tools[`nippPortal_${name}`];
  if (!tool) throw new Error(`tool not found: ${name}`);
  const raw = await (tool as { execute: (i: unknown, c?: unknown) => Promise<unknown> }).execute(args, undefined);
  const content = (raw as { content?: Array<{ type?: string; text?: string }> })?.content?.[0]?.text ?? '';
  try { return JSON.parse(content) as any; } catch { return { error: content.slice(0, 300) }; }
}

// ── scenarios ────────────────────────────────────────────────────────────────
const results: Array<[string, boolean, string]> = [];
const check = (label: string, ok: boolean, detail: string) => {
  results.push([label, ok, detail]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  — ${detail}`);
};

// 1. tenant token → work-order list for their org (tenant-scoped endpoint)
{
  const u = await prisma.user.findUnique({ where: { id: TENANT_USER_ID }, select: { activeOrganizationId: true } });
  // The probe tenant was created without a Member row; the portal route
  // requires membership (or platform admin). Ensure one, idempotently.
  if (u?.activeOrganizationId) {
    await prisma.member.upsert({
      where: { userId_organizationId: { userId: TENANT_USER_ID, organizationId: u.activeOrganizationId } },
      update: {},
      create: { userId: TENANT_USER_ID, organizationId: u.activeOrganizationId, role: 'member' },
    });
  }
  currentToken = tenantTok;
  const r = await callTool('wo_organizations_work_orders_list', { orgId: u?.activeOrganizationId ?? '' });
  check(
    'tenant token → wo list (own org) → 200 scoped data',
    r.status === 200 && Array.isArray(r.data?.items ?? r.data),
    `status=${r.status}`
  );
}

// 2. tenant token → admin user list → portal RBAC 403
{
  currentToken = tenantTok;
  const r = await callTool('user_list_admin', { page: 1 });
  check(
    'tenant token → user_list_admin (admin) → 403 from portal',
    r.status === 403,
    `status=${r.status}`
  );
}

// 3. admin token → admin user list → 200
{
  currentToken = adminTok;
  const r = await callTool('user_list_admin', { page: 1 });
  check(
    'admin token → user_list_admin (admin) → 200',
    r.status === 200,
    `status=${r.status}`
  );
}

// 4. no token → legacy service fallback still works
{
  currentToken = null;
  const r = await callTool('user_list_admin', { page: 1 });
  check(
    'no token → legacy service fallback → 200',
    r.status === 200,
    `status=${r.status}`
  );
}

await prisma.$disconnect();
const failed = results.filter(([, ok]) => !ok);
console.log(failed.length === 0 ? '\nSMOKE PASS (4/4)' : `\nSMOKE FAIL (${failed.length}/4)`);
process.exit(failed.length === 0 ? 0 : 1);
