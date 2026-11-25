import { afterEach, describe, expect, it, vi } from 'vitest';
import { filterToolsForCaller, registerToolScope, toolScopeRegistry, __resetToolScopeRegistryForTests } from '../../src/mastra/tools/filter.js';
import { generateTools } from '../../src/mastra/tools/generate.js';
import type { OpenApiSpec } from '../../src/mastra/spec.js';

/**
 * Phase 2 task 3: per-caller tools/list filtering. Non-admins don't see
 * _admin tools (context savings + smaller injection surface); the call-time
 * gate remains authoritative. Legacy token-less requests keep the full list.
 */

const miniSpec: OpenApiSpec = {
  openapi: '3.1.0',
  info: { title: 'mini', version: '0' },
  paths: {
    '/api/admin/users': { get: { summary: 'List users (admin)', responses: { 200: { description: 'ok' } } } },
    '/api/organizations/{orgId}/calendar-events': {
      get: {
        summary: 'List tenant calendar events',
        parameters: [{ name: 'orgId', in: 'path', schema: { type: 'string' } }],
        responses: { 200: { description: 'ok' } },
      },
    },
  },
  components: { schemas: {} },
};

afterEach(() => __resetToolScopeRegistryForTests());

describe('filterToolsForCaller (phase 2 task 3)', () => {
  it('hides admin tools from non-admins', () => {
    registerToolScope('user_list_admin', 'admin');
    registerToolScope('calevent_list_tenant', 'tenant');
    const out = filterToolsForCaller(
      { user_list_admin: {}, calevent_list_tenant: {} },
      { userId: 'u', isPlatformAdmin: false },
    );
    expect(Object.keys(out)).not.toContain('user_list_admin');
    expect(Object.keys(out)).toContain('calevent_list_tenant');
  });

  it('shows everything to admins', () => {
    registerToolScope('user_list_admin', 'admin');
    const out = filterToolsForCaller(
      { user_list_admin: {}, calevent_list_tenant: {} },
      { userId: 'u', isPlatformAdmin: true },
    );
    expect(Object.keys(out).sort()).toEqual(['calevent_list_tenant', 'user_list_admin']);
  });

  it('shows everything to legacy (no-caller) requests', () => {
    registerToolScope('user_list_admin', 'admin');
    const out = filterToolsForCaller({ user_list_admin: {}, calevent_list_tenant: {} }, null);
    expect(Object.keys(out).sort()).toEqual(['calevent_list_tenant', 'user_list_admin']);
  });

  it('keeps dash/tenant/single tools for non-admins (portal RBAC is their authority)', () => {
    registerToolScope('org_delete_dash', 'dash');
    registerToolScope('calevent_list_tenant', 'tenant');
    registerToolScope('role_members_list', 'single');
    const out = filterToolsForCaller(
      { org_delete_dash: {}, calevent_list_tenant: {}, role_members_list: {} },
      { userId: 'u', isPlatformAdmin: false },
    );
    expect(Object.keys(out).sort()).toEqual(['calevent_list_tenant', 'org_delete_dash', 'role_members_list']);
  });

  it('keeps tools not in the registry (utility tools like portal_health)', () => {
    registerToolScope('user_list_admin', 'admin');
    const out = filterToolsForCaller(
      { user_list_admin: {}, portal_health: {} },
      { userId: 'u', isPlatformAdmin: false },
    );
    expect(Object.keys(out)).toEqual(['portal_health']);
  });

  it('generateTools registers scopes for the tools it builds', () => {
    const request = vi.fn(async () => ({ status: 200, ok: true, data: {} }));
    generateTools(miniSpec, { request } as any, ['/api/auth']);
    expect(toolScopeRegistry.get('user_list')).toBe('admin');
    expect(toolScopeRegistry.get('calevent_organizations_calendar_events_list')).toBe('tenant');
  });
});
