/**
 * Central configuration for the Mistra Portal MCP server.
 * All values come from environment variables (see .env.example).
 */

export interface PortalMcpConfig {
  /** Base URL of the NIPP portal, no trailing slash. */
  baseUrl: string;
  /** BetterAuth credentials used to obtain a session cookie. */
  email: string;
  password: string;
  /** Org id sent as x-org-id by default (Platform org for admin functions). */
  defaultOrgId: string;
  /** Path segments under /api that are excluded from tool generation. */
  excludePathPrefixes: string[];
}

function env(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v.trim();
}

export function loadConfig(): PortalMcpConfig {
  const baseUrl = env('PORTAL_BASE_URL', 'http://localhost:3000').replace(/\/+$/, '');
  return {
    baseUrl,
    email: env('PORTAL_EMAIL'),
    password: env('PORTAL_PASSWORD'),
    defaultOrgId: env('PORTAL_DEFAULT_ORG_ID'),
    // Public / non-admin surface is intentionally not exposed as tools:
    // the MCP server is for controlling the portal's admin (Platform org) API.
    excludePathPrefixes: [
      '/api/auth', // BetterAuth catch-all — handled by the session manager, not a tool
      '/api/csp-report', // browser CSP reporting endpoint
      '/api/health', // liveness probe; exposed as its own dedicated tool
    ],
  };
}
