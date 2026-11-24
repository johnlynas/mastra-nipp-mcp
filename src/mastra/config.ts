/**
 * Central configuration for the Mistra Portal MCP server.
 * All values come from environment variables (see .env.example).
 */

export interface PortalMcpConfig {
  /** Base URL of the NIPP portal, no trailing slash. */
  baseUrl: string;
  /** BetterAuth credentials used to obtain a bearer token on sign-in. */
  email: string;
  password: string;
  /** Org id sent as x-org-id by default (Platform org for admin functions). */
  defaultOrgId: string;
  /** Path segments under /api that are excluded from tool generation. */
  excludePathPrefixes: string[];
  /**
   * Phase 1: allow the legacy service-account session when a tool call has no
   * caller token (existing non-agent MCP clients). Env `MCP_ALLOW_SERVICE_FALLBACK`,
   * default on. Phase 3 flips the default and removes the path.
   */
  allowServiceFallback: boolean;
  /**
   * Phase 1: Platform org id — membership here is what makes a caller a
   * platform admin (mirrors portal `verifySuperAdmin`). Env `PLATFORM_ORG_ID`.
   */
  platformOrgId: string;
}

function env(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v.trim();
}

/**
 * The .env value may carry quotes / an inline comment (dotenv keeps both in
 * the parsed string) — normalize to the bare id.
 */
function bareId(v: string): string {
  return v.replace(/^["']|["'\s#].*$/g, '').trim();
}

export function loadConfig(): PortalMcpConfig {
  const baseUrl = env('PORTAL_BASE_URL', 'http://localhost:3000').replace(/\/+$/, '');
  return {
    baseUrl,
    email: env('PORTAL_EMAIL'),
    password: env('PORTAL_PASSWORD'),
    defaultOrgId: env('PORTAL_DEFAULT_ORG_ID'),
    allowServiceFallback: env('MCP_ALLOW_SERVICE_FALLBACK', '1') !== '0',
    platformOrgId: bareId(env('PLATFORM_ORG_ID')),
    // Public / non-admin surface is intentionally not exposed as tools:
    // the MCP server is for controlling the portal's admin (Platform org) API.
    excludePathPrefixes: [
      '/api/auth', // BetterAuth catch-all — handled by the session manager, not a tool
      '/api/csp-report', // browser CSP reporting endpoint
      '/api/health', // liveness probe; exposed as its own dedicated tool
      '/api/notifications/stream', // SSE long-lived stream — fetch() would block; not a REST call
    ],
  };
}
