import { describe, expect, it } from 'vitest';
import { classifyTool } from '../../src/mastra/tools/generate.js';

describe('classifyTool (phase 2 task 1)', () => {
  it('admin scope for /api/admin/*', () => expect(classifyTool('/api/admin/users')).toBe('admin'));
  it('dash scope for /api/dashboard/admin/*', () => expect(classifyTool('/api/dashboard/admin/stats/overview')).toBe('dash'));
  it('tenant scope for /api/organizations/{id}/*', () => expect(classifyTool('/api/organizations/org1/work-orders')).toBe('tenant'));
  it('single scope otherwise', () => expect(classifyTool('/api/roles')).toBe('single'));
});
