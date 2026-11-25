// Phase 2 Task 6 — integration smoke against the live MCP dev server (:4112) + portal (:3000).
//
// Extends scripts/smoke-phase1.ts with the phase-2 exit criteria:
//   1. tenant token  → tools/list        → zero _admin tools visible (record count)
//   2. admin token   → tools/list        → full surface (record count, includes _admin)
//   3. tenant token  → user_list_admin   → 403 FROM THE MCP GATE (error text proves it;
//                                          no portal round-trip — the gate returns before client.request)
//   4. tenant token  → wo list (own org) → 200, scoped data (gate doesn't affect tenant tools)
//   5. admin token   → user_list_admin   → 200
//   6. no token      → user_list_admin   → 200 via legacy service fallback (unchanged in phase 2)
import 'dotenv/config';
import { betterAuth } from 'better-auth/minimal';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { bearer } from 'better-auth/plugins';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma-gen/client';
import { MCPClient, type MastraFetchLike } from '@mastra/mcp';

const MCP_URL = 'http://localhost:4112/api/mcp/nipp-portal/mcp';
const TENANT_USER_ID = 'probe1795536867'; // probe tenant on the test stack

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
    headers: new Headers({ authorization: 'Bear' + 'er ' + probeSession.token }),
  });
} catch (e) {
  if (!/PASSWORD_ALREADY_SET/.test(JSON.stringify(e))) throw e;
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

// A fresh MCPClient per token so tools/list reflects that caller's surface.
async function clientFor(token: string | null): Promise<MCPClient> {
  currentToken = token;
  const mcp = new MCPClient({
    id: `phase2-smoke-${token ? 'authed' : 'legacy'}`,
    servers: { nippPortal: { url: new URL(MCP_URL), fetch: authFetch } },
  });
  return mcp;
}

async function listToolIds(mcp: MCPClient): Promise<string[]> {
  const { tools, errors } = await mcp.listToolsWithErrors();
  if (errors.nippPortal) throw new Error(`MCP server unreachable: ${errors.nippPortal}`);
  return Object.keys(tools).map((k) => k.replace(/^nippPortal_/, ''));
}

async function callTool(mcp: MCPClient, name: string, args: Record<string, unknown>): Promise<{ status?: number; data?: any; error?: string }> {
  const { tools } = await mcp.listToolsWithErrors();
  const tool = tools[`nippPortal_${name}`];
  if (!tool) throw new Error(`tool not found in list: ${name}`);
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

// 1. tenant token → tools/list → no _admin tools
{
  const mcp = await clientFor(tenantTok);
  const ids = await listToolIds(mcp);
  const adminIds = ids.filter((id) => id.endsWith('_admin'));
  check(
    'tenant token → tools/list → zero _admin tools',
    adminIds.length === 0,
    `total=${ids.length}, _admin=${adminIds.length}${adminIds.length ? ` (${adminIds.slice(0, 5).join(', ')})` : ''}`
  );
}

// 2. admin token → tools/list → full surface incl. _admin
{
  const mcp = await clientFor(adminTok);
  const ids = await listToolIds(mcp);
  const adminIds = ids.filter((id) => id.endsWith('_admin'));
  check(
    'admin token → tools/list → full surface',
    adminIds.length > 0,
    `total=${ids.length}, _admin=${adminIds.length}`
  );
}

// 3. tenant token → user_list_admin → 403 FROM THE MCP GATE (no portal round-trip)
{
  const mcp = await clientFor(tenantTok);
  // The tool is hidden from the list, so call it via a legacy-surface client's
  // tool object — the gate is per-call and model-independent.
  const legacy = await clientFor(null);
  const { tools } = await legacy.listToolsWithErrors();
  const tool = tools['nippPortal_user_list_admin']!;
  currentToken = tenantTok; // switch back to the tenant token for this call
  const raw = await (tool as { execute: (i: unknown, c?: unknown) => Promise<unknown> }).execute({ page: 1 }, undefined);
  const content = (raw as { content?: Array<{ type?: string; text?: string }> })?.content?.[0]?.text ?? '';
  let parsed: any = {};
  try { parsed = JSON.parse(content); } catch { /* keep raw */ }
  const fromMcpGate = /platform admin/i.test(String(parsed.error ?? content));
  check(
    'tenant token → user_list_admin → 403 from MCP gate (no portal call)',
    parsed.status === 403 && fromMcpGate,
    `status=${parsed.status}, error=${String(parsed.error ?? content).slice(0, 120)}`
  );
}

// 4. tenant token → wo list (own org) → 200 scoped data
{
  const u = await prisma.user.findUnique({ where: { id: TENANT_USER_ID }, select: { activeOrganizationId: true } });
  if (u?.activeOrganizationId) {
    await prisma.member.upsert({
      where: { userId_organizationId: { userId: TENANT_USER_ID, organizationId: u.activeOrganizationId } },
      update: {},
      create: { userId: TENANT_USER_ID, organizationId: u.activeOrganizationId, role: 'member' },
    });
  }
  const mcp = await clientFor(tenantTok);
  const r = await callTool(mcp, 'wo_organizations_work_orders_list', { orgId: u?.activeOrganizationId ?? '' });
  check(
    'tenant token → wo list (own org) → 200 scoped data',
    r.status === 200 && Array.isArray(r.data?.items ?? r.data),
    `status=${r.status}`
  );
}

// 5. admin token → user_list_admin → 200
{
  const mcp = await clientFor(adminTok);
  const r = await callTool(mcp, 'user_list_admin', { page: 1 });
  check('admin token → user_list_admin → 200', r.status === 200, `status=${r.status}`);
}

// 6. no token → legacy service fallback unchanged (phase 3 removes it)
{
  const mcp = await clientFor(null);
  const r = await callTool(mcp, 'user_list_admin', { page: 1 });
  check('no token → legacy service fallback → 200', r.status === 200, `status=${r.status}`);
}

await prisma.$disconnect();
const failed = results.filter(([, ok]) => !ok);
console.log(failed.length === 0 ? '\nSMOKE PASS (6/6)' : `\nSMOKE FAIL (${failed.length}/6)`);
process.exit(failed.length === 0 ? 0 : 1);
