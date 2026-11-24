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
 * context; `resolveCallerToken()` verifies it via `verifyCaller` and returns
 * it only when valid. null = no usable caller (legacy service fallback in
 * phase 1 — removed in phase 3).
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
 * Resolve + verify the caller token from a tool execution context.
 * - no token → null (legacy fallback)
 * - invalid/unverifiable token → null + warning (phase 1 degrades to legacy;
 *   phase 2 turns this into a 401 — fail closed on the token path)
 */
export async function resolveCallerToken(context: unknown): Promise<string | null> {
  const token = extractTokenFromContext(context);
  if (!token) return null;
  try {
    const caller = await verify(token);
    if (caller) return token;
    console.warn('[mcp-authz] caller token failed verification — falling back to legacy service session');
    return null;
  } catch {
    console.warn('[mcp-authz] caller verification error — falling back to legacy service session');
    return null;
  }
}
