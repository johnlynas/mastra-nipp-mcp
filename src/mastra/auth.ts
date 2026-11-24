/**
 * Per-request caller verification (DESIGN §5.5 / phase 1 of the MCP authz work).
 *
 * The MCP server used to forward EVERY portal call under its own long-lived
 * Platform super-admin session (`PortalClient` service sign-in). Phase 1 adds
 * per-caller identity: the agent sends the calling user's portal session token
 * on each MCP request, and `verifyCaller()` resolves it into a caller record
 * (`userId`, active org, platform-admin flag) before the tool executes.
 *
 * Verification mirrors `mastra-nipp-agent/src/mastra/auth.ts` exactly: a thin
 * BetterAuth instance sharing the portal's `BETTER_AUTH_SECRET` + the same
 * PostgreSQL (Prisma client generated from the portal schema, copied verbatim).
 * The `bearer()` plugin lets `getSession({ headers })` resolve a session from
 * the Authorization header alone — no cookie round-trip.
 *
 * Fail-closed: any error (DB down, secret mismatch, missing user row) → null.
 * A short TTL cache (60s, keyed by sha256 of the token) bounds DB load — a chat
 * turn makes many tool calls with the same token. Staleness after ban/unban is
 * ≤60s and acceptable: the portal's own RBAC re-checks on every call.
 */
import { createHash } from 'node:crypto';
import 'dotenv/config';
import { betterAuth, type BetterAuthOptions } from 'better-auth/minimal';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { bearer } from 'better-auth/plugins';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma-gen/client';

export interface McpCaller {
  userId: string;
  /** Caller's active organization (x-org-id default) — undefined when unset. */
  orgId?: string;
  /** True only for members of the Platform org (mirrors portal verifySuperAdmin). */
  isPlatformAdmin: boolean;
}

/** Test seam: swap the live auth/prisma deps for mocks. */
interface CallerDeps {
  getSession: (opts: { headers: Headers }) => Promise<{ user?: { id?: string } } | null>;
  /** Prisma-shaped; `any` so unit tests can inject minimal fakes. */
  prisma: any;
}

const g = globalThis as unknown as {
  mcpAuthDeps?: CallerDeps;
  mcpAuth?: ReturnType<typeof betterAuth>;
  mcpPrisma?: PrismaClient;
};

export function __setDepsForTests(deps: CallerDeps): void {
  g.mcpAuthDeps = deps;
}

/** Live deps (lazy — unit tests inject mocks before the first verifyCaller). */
function liveDeps(): CallerDeps {
  if (!g.mcpPrisma) {
    const adapter = new PrismaPg({
      connectionString: process.env.DATABASE_URL!,
      connectionTimeoutMillis: 5_000,
    });
    g.mcpPrisma = new PrismaClient({ adapter });
  }
  if (!g.mcpAuth) {
    // Typed as full BetterAuthOptions so the instance is `Auth<BetterAuthOptions>`
    // (same reasoning as the agent's auth.ts). Verification only — no sign-in.
    const options: BetterAuthOptions = {
      baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:3000',
      secret: process.env.BETTER_AUTH_SECRET!, // MUST equal the portal's
      database: prismaAdapter(g.mcpPrisma, { provider: 'postgresql' }),
      emailAndPassword: { enabled: true },
      plugins: [bearer()],
    };
    g.mcpAuth = betterAuth(options);
  }
  return { getSession: (o) => g.mcpAuth!.api.getSession(o), prisma: g.mcpPrisma! };
}

function deps(): CallerDeps {
  return g.mcpAuthDeps ?? liveDeps();
}

/**
 * Platform org id from env. The .env value may carry quotes / an inline
 * comment (dotenv keeps both in the parsed string) — normalize to the bare id.
 */
function platformOrgId(): string {
  return (process.env.PLATFORM_ORG_ID ?? '').replace(/^["']|["'\s#].*$/g, '').trim();
}

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; value: McpCaller | null }>();

export function clearCallerCache(): void {
  cache.clear();
}

function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * Verify a portal session token → caller identity. `null` = reject (fail-closed
 * on any error). Cached per token hash for TTL_MS.
 */
export async function verifyCaller(token: string): Promise<McpCaller | null> {
  if (!token) return null;
  const key = sha256hex(token);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  let value: McpCaller | null = null;
  try {
    const { getSession, prisma } = deps();
    const session = await getSession({
      headers: new Headers({ authorization: `Bearer ${token}` }),
    });
    const user = session?.user;
    if (!user?.id) return null;

    const row = await prisma.user.findUnique({
      where: { id: user.id },
      select: { banned: true, banExpires: true, activeOrganizationId: true },
    });
    if (!row) return null;
    // Active-ban rule — same as the agent's authorizeUser.
    if (row.banned && !(row.banExpires && new Date(row.banExpires) < new Date())) return null;

    // Platform-admin = Member row in PLATFORM_ORG_ID. The Member table is
    // RLS-scoped on organizationId, so the explicit filter is what makes the
    // platform row visible under the non-owner nipp_app role (design doc R6).
    const pOrg = platformOrgId();
    const member = pOrg
      ? await prisma.member.findFirst({
          where: { userId: user.id, organizationId: pOrg },
          select: { id: true },
        })
      : null;

    value = {
      userId: user.id,
      orgId: row.activeOrganizationId ?? undefined,
      isPlatformAdmin: !!member,
    };
  } catch {
    value = null; // fail closed — DB/auth unavailable ⇒ reject
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}
