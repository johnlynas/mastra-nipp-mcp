/**
 * HTTP client for the NIPP portal API with BetterAuth bearer-token auth.
 *
 * The portal runs BetterAuth's `bearer()` plugin (nipp-0111 lib/auth.ts): a
 * server-to-server client signs in once and receives its session token as the
 * `set-auth-token` response header (and `{token}` in the JSON body). Every
 * subsequent request carries `Authorization: Bearer <token>` — no cookies, so
 * this works identically in dev and production (production mints
 * `__Secure-` prefixed cookies over plain HTTP, which is exactly what broke
 * the old cookie-based client). The plugin rewrites the header to an internal
 * session per request, so all portal auth gates (ban, super-admin, org
 * isolation) apply unchanged.
 *
 * This client:
 *   1. signs in via POST /api/auth/sign-in/email and captures the bearer token
 *   2. sends it as Authorization: Bearer on every request
 *   3. re-authenticates transparently on 401 and retries once
 */
import type { PortalMcpConfig } from './config.js';

export interface PortalRequestOptions {
  /** Path params, e.g. { id: 'cmw...' } → replaces {id} in the path. */
  pathParams?: Record<string, string>;
  /** Query params appended to the URL. */
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON body for POST/PATCH/PUT. */
  body?: unknown;
  /** Organization context → x-org-id header (tenant isolation). */
  orgId?: string;
  /**
   * Caller's portal session token — forwarded verbatim as `Authorization:
   * Bearer <token>`. When present the service-account session is NOT used and
   * no re-auth retry happens (a 401/403 here means the *caller* was rejected).
   */
  bearerToken?: string;
}

export interface PortalResponse {
  status: number;
  ok: boolean;
  /** Parsed JSON body when the response is JSON, otherwise raw text. */
  data: unknown;
}

const MAX_BODY_CHARS = 100_000;

export class PortalClient {
  private token = '';
  private signingIn: Promise<void> | null = null;
  /** Last sign-in attempt timestamp — cooldown guard against the portal's sign-in rate limit. */
  private lastSignInAt = 0;

  constructor(private config: PortalMcpConfig) {}

  /** Sign in and capture the BetterAuth bearer token (set-auth-token header / {token} body). */
  async signIn(): Promise<void> {
    if (!this.config.email || !this.config.password) {
      throw new Error(
        'Portal credentials not configured. Set PORTAL_EMAIL and PORTAL_PASSWORD in .env'
      );
    }
    // Cooldown: never attempt more than one sign-in per 30s (portal rate-limits
    // sign-ins aggressively; repeated failures must not hammer it).
    const sinceLast = Date.now() - this.lastSignInAt;
    if (sinceLast < 30_000) {
      throw new Error(
        `Portal sign-in attempted ${Math.round(sinceLast / 1000)}s after a previous attempt — ` +
          'the portal rate-limits sign-ins. Wait before retrying.'
      );
    }
    this.lastSignInAt = Date.now();

    const res = await fetch(`${this.config.baseUrl}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // BetterAuth's CSRF check rejects a null/missing Origin (Node fetch sends
        // origin:null by default). Send the portal's own origin.
        Origin: this.config.baseUrl,
        Referer: `${this.config.baseUrl}/login`,
      },
      body: JSON.stringify({ email: this.config.email, password: this.config.password }),
      redirect: 'manual',
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Portal sign-in failed (${res.status}): ${text.slice(0, 300)}`);
    }

    // The bearer() plugin emits the session token in-band: `set-auth-token`
    // response header (primary) and `{token}` in the JSON body (fallback).
    let body: { token?: string } | null = null;
    try {
      body = JSON.parse(await res.text());
    } catch {
      body = null;
    }
    const token = res.headers.get('set-auth-token') || body?.token;
    if (!token) {
      throw new Error(
        'Portal sign-in succeeded but no bearer token was returned (expected set-auth-token header)'
      );
    }
    this.token = token;
  }

  private async ensureSession(): Promise<void> {
    if (this.token) return;
    if (!this.signingIn) {
      this.signingIn = this.signIn().finally(() => {
        this.signingIn = null;
      });
    }
    await this.signingIn;
  }

  /** Invalidate the session (called on 401). */
  invalidateSession(): void {
    this.token = '';
  }

  async request(method: string, path: string, opts: PortalRequestOptions = {}): Promise<PortalResponse> {
    // Caller-token path (phase 1): forward the calling user's portal session
    // verbatim. No service sign-in, no re-auth retry — a 401/403 here means the
    // CALLER was rejected by portal RBAC, and re-signing the service account
    // would silently escalate (exactly the bug this phase removes).
    if (opts.bearerToken) {
      return this.doRequest(method, path, opts);
    }
    // Legacy path: shared Platform super-admin session. Kept for existing
    // non-agent MCP clients (Studio, scripts) during rollout; removed in phase 3.
    if (process.env.MCP_ALLOW_SERVICE_FALLBACK === '0') {
      throw new Error(
        'No caller token provided and service-account fallback is disabled (MCP_ALLOW_SERVICE_FALLBACK=0).'
      );
    }
    await this.ensureSession();
    const result = await this.doRequest(method, path, opts);
    // Transparent re-auth on 401 (expired session) — retry once.
    if (result.status === 401 && this.token) {
      this.invalidateSession();
      await this.ensureSession();
      return this.doRequest(method, path, opts);
    }
    return result;
  }

  private async doRequest(
    method: string,
    path: string,
    opts: PortalRequestOptions
  ): Promise<PortalResponse> {
    // Substitute path params
    let url = path;
    for (const [name, value] of Object.entries(opts.pathParams ?? {})) {
      url = url.replace(`{${name}}`, encodeURIComponent(String(value)));
    }

    // Query string
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== '') qs.set(k, String(v));
    }
    const qsStr = qs.toString();
    const fullUrl = `${this.config.baseUrl}${url}${qsStr ? `?${qsStr}` : ''}`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${opts.bearerToken ?? this.token}`,
      Accept: 'application/json',
    };
    const orgId = opts.orgId ?? this.config.defaultOrgId;
    if (orgId) headers['x-org-id'] = orgId;

    const init: RequestInit = { method, headers, redirect: 'manual' };
    if (opts.body !== undefined && ['POST', 'PATCH', 'PUT'].includes(method)) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }

    const res = await fetch(fullUrl, init);
    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = text.slice(0, MAX_BODY_CHARS);
    }
    return { status: res.status, ok: res.ok, data };
  }
}
