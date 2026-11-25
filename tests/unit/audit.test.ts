import { afterEach, describe, expect, it } from 'vitest';
import { logToolCall, __setAuditSinkForTests } from '../../src/mastra/audit.js';

/**
 * Phase 3 task 1: the audit logger must emit exactly one JSON line per tool
 * call with a fixed field whitelist — tokens and request bodies can never
 * reach the file, by construction (whitelist at the boundary).
 */

let lines: string[] = [];
afterEach(() => {
  __setAuditSinkForTests(null);
  lines = [];
});

describe('audit logger', () => {
  it('writes one JSON line per call with the required fields', () => {
    __setAuditSinkForTests((line) => lines.push(line));
    logToolCall({ userId: 'u1', toolId: 'user_list_admin', scope: 'admin', orgId: 'org_p', status: 200, latencyMs: 42 });

    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]);
    expect(rec).toMatchObject({ userId: 'u1', toolId: 'user_list_admin', scope: 'admin', orgId: 'org_p', status: 200, latencyMs: 42 });
    expect(rec.ts).toBeTypeOf('string');
    expect(new Date(rec.ts).toString()).not.toBe('Invalid Date');
  });

  it('uses the literal "legacy-service" userId for unauthenticated calls', () => {
    __setAuditSinkForTests((line) => lines.push(line));
    logToolCall({ userId: 'legacy-service', toolId: 'user_list_admin', scope: 'admin', status: 200, latencyMs: 7 });
    const rec = JSON.parse(lines[0]);
    expect(rec.userId).toBe('legacy-service');
    // orgId is optional — absent here, must not appear as undefined/null noise
    expect('orgId' in rec).toBe(false);
  });

  it('never logs tokens or full request bodies (whitelist at the boundary)', () => {
    __setAuditSinkForTests((line) => lines.push(line));
    logToolCall({
      userId: 'u1',
      toolId: 'x',
      scope: 'single',
      status: 200,
      latencyMs: 1,
      // attacker-controlled extras must be dropped at the boundary:
      meta: { token: 'SECRET-TOKEN-VALUE' },
      body: { password: 'hunter2' },
    } as any);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('SECRET-TOKEN-VALUE');
    expect(lines[0]).not.toContain('hunter2');
    const rec = JSON.parse(lines[0]);
    expect(Object.keys(rec).sort()).toEqual(['latencyMs', 'scope', 'status', 'toolId', 'ts', 'userId']);
  });

  it('logs gate rejections (403) with the tenant userId, not legacy-service', () => {
    __setAuditSinkForTests((line) => lines.push(line));
    logToolCall({ userId: 'u_tenant', toolId: 'user_list_admin', scope: 'admin', orgId: 'org_t1', status: 403, latencyMs: 2 });
    const rec = JSON.parse(lines[0]);
    expect(rec).toMatchObject({ userId: 'u_tenant', status: 403 });
  });

  it('omits ts from the entry — the logger stamps it, callers cannot override', () => {
    __setAuditSinkForTests((line) => lines.push(line));
    logToolCall({ userId: 'u1', toolId: 'x', scope: 'single', status: 200, latencyMs: 1, ts: 'forged' } as any);
    const rec = JSON.parse(lines[0]);
    expect(rec.ts).not.toBe('forged');
    expect(new Date(rec.ts).toString()).not.toBe('Invalid Date');
  });

  it('emits multiple calls as multiple lines in order', () => {
    __setAuditSinkForTests((line) => lines.push(line));
    logToolCall({ userId: 'u1', toolId: 'a', scope: 'single', status: 200, latencyMs: 1 });
    logToolCall({ userId: 'u2', toolId: 'b', scope: 'admin', status: 403, latencyMs: 2 });
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).toolId).toBe('a');
    expect(JSON.parse(lines[1]).toolId).toBe('b');
  });
});
