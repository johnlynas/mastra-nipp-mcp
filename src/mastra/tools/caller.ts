/**
 * Per-request caller resolution for generated tools (phase 1).
 *
 * The MCP server receives `Authorization: Bearer <portal session token>` on
 * every Streamable HTTP POST (the agent's transport fetch hook injects it).
 * Mastra surfaces that header as `authInfo.token` in the tool execution
 * context (`server.mcpOptions.setRequestAuth` → `req.auth` → `ctx.http.authInfo`
 * → `toRequestContext` → `requestContext.get('authInfo')`).
 *
 * `extractTokenFromContext()` pulls the raw token out of a tool execution
 * context; `resolveCaller()` verifies it via `verifyCaller` and returns the
 * verified caller record (identity + platform-admin flag) only when valid.
 * null = no usable caller (legacy service fallback in phase 1 — removed in
 * phase 3); a token that FAILS verification is a fail-closed signal (403 on
 * admin-scoped tools, phase 2).
 */
import type { McpCaller } from '../auth.js';
import { verifyCaller as liveVerifyCaller } from '../auth.js';

/** Test seam: swap verifyCaller for a mock in unit tests. */
type VerifyCaller = (token: string) => Promise<McpCaller | null>;
const g = globalThis as unknown as { __verifyCallerForTests?: VerifyCaller };

export function __setVerifyCallerForTests(fn: VerifyCaller): void {
  g.__verifyCallerForTests = fn;
}

function verify(token: string): Promise<McpCaller | null> {
  return (g.__verifyCallerForTests ?? liveVerifyCaller)(token);
}

/**
 * Read the raw caller token from a tool execution context. Returns '' when
 * absent (legacy service-fallback path — phase 1 keeps that working).
 */
export function extractTokenFromContext(context: unknown): string {
  const rc = (context as any)?.requestContext;
  if (!rc || typeof rc.get !== 'function') return '';
  // Primary: authInfo populated by the MCP transport (setRequestAuth hook).
  const authInfo = rc.get('authInfo');
  if (authInfo && typeof authInfo.token === 'string' && authInfo.token) return authInfo.token;
  // Fallback: explicit key (direct/stdio clients that set it themselves).
  const explicit = rc.get('mastra__mcpToken');
  return typeof explicit === 'string' ? explicit : '';
}

/**
 * Phase 2: resolve the FULL verified caller (identity + platform-admin flag),
 * not just the token. The scope gate needs `isPlatformAdmin` before deciding
 * whether an admin-scoped tool may run.
 *
 * Returns `{ token, caller }`:
 * - no token → `{ token: null, caller: null }` (legacy service fallback)
 * - verified token → `{ token, caller }`
 * - token present but verification failed/threw → `{ token: null, caller: null,
 *   verifyFailed: true }` — the gate treats this as 403 (fail closed), NOT as
 *   legacy: a token-bearing request that cannot be verified must not ride the
 *   service account.
 */
export interface ResolvedCaller {
  token: string | null;
  caller: McpCaller | null;
  /** True when a token WAS present but could not be verified (fail-closed signal). */
  verifyFailed?: boolean;
}

export async function resolveCaller(context: unknown): Promise<ResolvedCaller> {
  const token = extractTokenFromContext(context);
  if (!token) return { token: null, caller: null };
  try {
    const caller = await verify(token);
    if (caller) return { token, caller };
    console.warn('[mcp-authz] caller token failed verification');
    return { token: null, caller: null, verifyFailed: true };
  } catch {
    console.warn('[mcp-authz] caller verification error — failing closed');
    return { token: null, caller: null, verifyFailed: true };
  }
}
