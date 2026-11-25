/**
 * Per-call audit logging (phase 3).
 *
 * Every MCP tool call — successful, portal-rejected, gate-rejected (403), or
 * unauthenticated (401) — produces exactly one JSON line:
 *
 *   { ts, userId, toolId, scope, orgId?, status, latencyMs }
 *
 * - `userId` is the verified caller's user id, or the literal `'legacy-service'`
 *   when the call ran on the service-account fallback (phase 3: only when
 *   MCP_ALLOW_SERVICE_FALLBACK=1).
 * - Tokens and request bodies NEVER reach the file: the entry whitelist below
 *   is enforced at the boundary — any other field dropped before serialization,
 *   not by convention.
 *
 * Destination: a local JSON-lines file (pino.destination append stream),
 * default `./audit/mcp-audit.log`, override with `MCP_AUDIT_LOG_FILE`.
 * Size-based rotation is a named follow-up, not this phase (dev/LAN deployment).
 */
import pino from 'pino';

export interface AuditEntry {
  /** Verified caller user id, or `'legacy-service'` for the service fallback. */
  userId: string;
  toolId: string;
  /** Scope class of the tool endpoint (classifyTool) — utility tools use 'system'. */
  scope: string;
  /** Organization context sent to the portal (x-org-id), when known. */
  orgId?: string;
  /** Final outcome status: portal status, 403 from the gate, 401 missing caller. */
  status: number;
  latencyMs: number;
}

/** Sink seam — tests replace this with an in-memory collector. */
export type AuditSink = (line: string) => void;

const g = globalThis as unknown as { __auditSinkForTests?: AuditSink | null };

export function __setAuditSinkForTests(sink: AuditSink | null): void {
  g.__auditSinkForTests = sink;
}

/** Field whitelist — the ONLY keys that may appear in an audit line. */
const AUDIT_FIELDS = ['userId', 'toolId', 'scope', 'orgId', 'status', 'latencyMs'] as const;

let dest: pino.DestinationStream | null = null;

function fileSink(): AuditSink {
  if (!dest) {
    const path = process.env.MCP_AUDIT_LOG_FILE ?? './audit/mcp-audit.log';
    // Async append stream with mkdir — one write() per audit line, pure JSON.
    dest = pino.destination({ dest: path, sync: false, mkdir: true });
  }
  const d = dest;
  return (line) => d.write(line + '\n');
}

/**
 * Record one tool call. Whitelist-enforced: unknown fields (meta, body, token,
 * ts…) are dropped here, at the boundary — callers cannot smuggle secrets in.
 */
export function logToolCall(entry: AuditEntry): void {
  const rec: Record<string, unknown> = { ts: new Date().toISOString() };
  for (const f of AUDIT_FIELDS) {
    const v = (entry as unknown as Record<string, unknown>)[f];
    if (v !== undefined && v !== null) rec[f] = v;
  }
  const line = JSON.stringify(rec);
  const sink = g.__auditSinkForTests ?? fileSink();
  sink(line);
}
