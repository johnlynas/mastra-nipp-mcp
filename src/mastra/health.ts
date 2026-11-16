/**
 * Public health endpoint for the MCP server itself (GET /mcp-health).
 *
 * Modeled on the portal's liveness probe (nipp-0111 app/api/health/route.ts +
 * lib/health-check.ts): JSON body with status / timestamp / uptime / per-dependency
 * checks. No authentication — polled by the APM, which alerts on red and can
 * restart the server; amber is a warning only.
 *
 * Dependency semantics (mirrors how the portal treats its PgBouncer pooler —
 * nice to have, the service keeps working without it):
 *   - storage: the MCP server's own LibSQL store → degraded when down
 *   - portal:  the NIPP portal's public /api/health endpoint → degraded when down
 *
 * A dead process is the only red state — the APM sees it as an unreachable
 * endpoint, not a JSON status. So this route answers 200 for healthy/degraded
 * and 503 only if we ever classify a check as critical (none currently).
 */
import type { Mastra } from '@mastra/core/mastra';

type CheckResult = {
  status: 'healthy' | 'unhealthy' | 'skipped';
  latency_ms?: number;
  error?: string;
  message?: string;
};

export interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  uptime: number;
  checks: Record<string, CheckResult>;
}

const PORTAL_HEALTH_TIMEOUT_MS = 5_000;

/** Probe the MCP server's LibSQL store with a trivial list query. */
async function checkStorage(mastra: Mastra): Promise<CheckResult> {
  const start = Date.now();
  try {
    const agentsStore = await mastra.getStorage()?.getStore('agents');
    if (!agentsStore) {
      return { status: 'skipped', message: 'Storage not configured' };
    }
    await agentsStore.list();
    return { status: 'healthy', latency_ms: Date.now() - start };
  } catch (error) {
    return {
      status: 'unhealthy',
      error: `Storage query failed (${error instanceof Error ? error.message : String(error)})`,
    };
  }
}

/** Probe the portal's own public health endpoint (no auth required). */
async function checkPortal(baseUrl: string): Promise<CheckResult> {
  if (!baseUrl) {
    return { status: 'skipped', message: 'Portal not configured' };
  }
  const start = Date.now();
  try {
    const res = await fetch(`${baseUrl}/api/health`, {
      signal: AbortSignal.timeout(PORTAL_HEALTH_TIMEOUT_MS),
    });
    if (!res.ok) {
      let detail: unknown;
      try {
        const body = (await res.json()) as { status?: string };
        detail = body.status ?? res.status;
      } catch {
        detail = res.status;
      }
      return {
        status: 'unhealthy',
        latency_ms: Date.now() - start,
        error: `Portal reported unhealthy (status ${detail})`,
      };
    }
    return { status: 'healthy', latency_ms: Date.now() - start };
  } catch (error) {
    return {
      status: 'unhealthy',
      error: `Portal unreachable (${error instanceof Error ? error.message : String(error)})`,
    };
  }
}

/** Run all health checks — returns current state only, no side effects. */
export async function checkHealthStatus(mastra: Mastra, baseUrl: string): Promise<HealthResponse> {
  const [storage, portal] = await Promise.all([checkStorage(mastra), checkPortal(baseUrl)]);

  // Both dependencies are non-critical (amber) — the MCP server process is up
  // and answering probes even if they fail. A dead process never reaches this code.
  const status: HealthResponse['status'] =
    storage.status === 'unhealthy' || portal.status === 'unhealthy' ? 'degraded' : 'healthy';

  const checks: Record<string, CheckResult> = { storage, portal };
  if (status !== 'healthy') {
    console.warn(`[HEALTH] ${status}: ${JSON.stringify(checks)}`);
  }

  return {
    status,
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    checks,
  };
}

/** Hono route object — spread into Mastra's `server.apiRoutes`. */
export function healthRoute(baseUrl: string) {
  return {
    path: '/mcp-health',
    method: 'GET' as const,
    requiresAuth: false,
    createHandler: async ({ mastra }: { mastra: Mastra }) => {
      return async () => {
        const health = await checkHealthStatus(mastra, baseUrl);
        return new Response(JSON.stringify(health), {
          status: health.status === 'unhealthy' ? 503 : 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };
    },
  };
}
