/**
 * HTTP client for the NIPP portal API with BetterAuth session management.
 *
 * The portal's admin/dashboard routes require a cookie session
 * (better-auth.session_token). Bearer tokens are NOT accepted by those
 * routes — verified against the live portal. So this client:
 *   1. signs in via POST /api/auth/sign-in/email to obtain the session cookie
 *   2. sends it as a Cookie header on every request
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
}

export interface PortalResponse {
  status: number;
  ok: boolean;
  /** Parsed JSON body when the response is JSON, otherwise raw text. */
  data: unknown;
}

const MAX_BODY_CHARS = 100_000;

export class PortalClient {
  private cookie = '';
  private signingIn: Promise<void> | null = null;
  /** Last sign-in attempt timestamp — cooldown guard against the portal's sign-in rate limit. */
  private lastSignInAt = 0;

  constructor(private config: PortalMcpConfig) {}

  /** Sign in and capture the BetterAuth session cookie. */
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

    // Node 18+: getSetCookie() returns the raw Set-Cookie header values.
    const setCookies: string[] = res.headers.getSetCookie?.() ?? [];
    const sessionToken = setCookies.find((c) => c.startsWith('better-auth.session_token='));
    if (!sessionToken) {
      throw new Error('Portal sign-in succeeded but no session cookie was returned');
    }
    this.cookie = sessionToken.split(';')[0]; // name=value only
  }

  private async ensureSession(): Promise<void> {
    if (this.cookie) return;
    if (!this.signingIn) {
      this.signingIn = this.signIn().finally(() => {
        this.signingIn = null;
      });
    }
    await this.signingIn;
  }

  /** Invalidate the session (called on 401). */
  invalidateSession(): void {
    this.cookie = '';
  }

  async request(method: string, path: string, opts: PortalRequestOptions = {}): Promise<PortalResponse> {
    await this.ensureSession();
    const result = await this.doRequest(method, path, opts);
    // Transparent re-auth on 401 (expired session) — retry once.
    if (result.status === 401 && this.cookie) {
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
      Cookie: this.cookie,
      Accept: 'application/json',
      Origin: this.config.baseUrl, // BetterAuth CSRF check requires a non-null origin
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
