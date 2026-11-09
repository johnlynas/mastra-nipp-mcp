/**
 * Generates Mastra tools from the NIPP portal OpenAPI spec.
 *
 * Each (method, path) operation becomes one MCP tool:
 *   - id:      grouped by the portal's service domains (mirrors nipp-0111/services):
 *              `<domain>[_subpath]_<action>` — e.g. `user_list_admin` = GET /api/admin/users,
 *              `wo_transition_transition` = POST /api/admin/work-orders/{id}/transition.
 *              Colliding base ids (same operation in admin + dashboard scopes) get a
 *              scope suffix: `_admin`, `_dash`, `_tenant`.
 *   - input:   zod object from path params + query params + request body schema
 *   - execute: forwards the call to the portal via PortalClient with the session cookie
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { OpenApiSpec } from '../spec.js';
import { loadSpec } from '../spec.js';
import { schemaToZod } from '../schema.js';
import { PortalClient } from '../client.js';
import type { PortalMcpConfig } from '../config.js';

interface EndpointDef {
  method: string; // GET, POST, ...
  path: string; // /api/...
  summary?: string;
  description?: string;
  pathParams: Record<string, any>; // name → schema
  queryParams: Record<string, any>; // name → { schema, required }
  bodySchema?: any;
}

/** Extract endpoint definitions from the spec (skipping excluded prefixes). */
export function extractEndpoints(spec: OpenApiSpec, excludePrefixes: string[]): EndpointDef[] {
  const out: EndpointDef[] = [];
  for (const [path, methods] of Object.entries(spec.paths)) {
    if (excludePrefixes.some((p) => path.startsWith(p))) continue;
    for (const [method, op] of Object.entries(methods)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      const operation = op as any;
      if (!operation || typeof operation !== 'object') continue;

      const pathParams: Record<string, any> = {};
      const queryParams: Record<string, any> = {};
      for (const prm of operation.parameters ?? []) {
        if (!prm || typeof prm !== 'object' || !('schema' in prm)) continue;
        if (prm.in === 'path') pathParams[prm.name] = prm.schema;
        else if (prm.in === 'query') queryParams[prm.name] = { schema: prm.schema, required: !!prm.required };
      }

      let bodySchema: any;
      const rb = operation.requestBody;
      if (rb?.content) {
        const json = rb.content['application/json'];
        if (json?.schema) bodySchema = json.schema;
      }

      out.push({
        method: method.toUpperCase(),
        path,
        summary: operation.summary,
        description: operation.description,
        pathParams,
        queryParams,
        bodySchema,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tool id derivation — grouped by the portal's service domains
// (mirrors nipp-0111/services: organization, user, role, team, work-order,
// contractor, invoice, quote, resource, unit, permission, job-scheduler,
// calendar). Collisions between scopes (admin vs dashboard-admin vs tenant)
// are resolved with a scope suffix.
// ---------------------------------------------------------------------------

/** Domain root path segment for each domain token (used to strip the prefix). */
const DOMAIN_ROOTS: Record<string, string> = {
  org: 'organizations',
  user: 'users',
  role: 'roles',
  wo: 'work-orders',
  wonote: 'work-order-notes',
  contractor: 'contractors',
  invoice: 'invoices',
  quote: 'quotes',
  calevent: 'calendar-events',
  calnotif: 'calendar-notifications',
  calendar: 'calendar',
  perm: 'permissions',
  resource: 'resources',
  unit: 'units',
  job: 'jobs',
  script: 'scripts',
};

/** Map a spec path (without /api/) to a service-domain token. */
export function deriveDomain(pathNoApi: string): string {
  const s = pathNoApi;
  if (s.includes('work-order-notes')) return 'wonote';
  if (s.includes('work-orders') || s.includes('work-order')) return 'wo';
  if (s.includes('contractors')) return 'contractor';
  if (s.includes('invoices')) return 'invoice';
  if (s.includes('quotes')) return 'quote';
  if (s.includes('calendar-events')) return 'calevent';
  if (s.includes('calendar-notifications')) return 'calnotif';
  if (s.includes('/calendar')) return 'calendar';
  if (s.includes('teams')) return 'team';
  if (s.startsWith('admin/organizations') || s.startsWith('dashboard/admin/organizations')) return 'org';
  if (s.startsWith('admin/users') || s.startsWith('dashboard/admin/users')) return 'user';
  if (s.startsWith('admin/roles') || s.startsWith('dashboard/admin/roles') || s === 'roles' || s.startsWith('roles/')) return 'role';
  if (s.includes('permissions/resources')) return 'resource';
  if (s.includes('permissions')) return 'perm';
  if (s.includes('/resources')) return 'resource';
  if (s.includes('/units')) return 'unit';
  if (s.startsWith('admin/jobs')) return 'job';
  if (s.includes('/scripts')) return 'script';
  if (s.includes('audit-logs') || s.includes('system-logs') || s.includes('metrics') || s.startsWith('cache/')) return 'system';
  if (s.startsWith('security/')) return 'security';
  if (s.startsWith('admin/notifications') || s === 'notifications/stream') return 'notif';
  if (s.startsWith('dashboard/admin/stats') || s.startsWith('dashboard/admin/errors')) return 'system';
  if (s.startsWith('organizations/')) return 'tenant_org';
  return 'misc';
}

/** Path segments after the domain root, params dropped, dashes → underscores. */
export function deriveSubpath(pathNoApi: string, domain: string): string[] {
  let t = pathNoApi;
  for (const pref of ['admin/', 'dashboard/admin/']) {
    if (t.startsWith(pref)) t = t.slice(pref.length);
  }
  const root = DOMAIN_ROOTS[domain];
  if (root) {
    if (t === root) t = '';
    else if (t.startsWith(root + '/')) t = t.slice(root.length + 1);
  }
  return t.split('/').filter((x) => x && !x.startsWith('{')).map((x) => x.replace(/-/g, '_'));
}

/** Action suffix from method + last path segments. */
export function deriveAction(method: string, path: string): string {
  const segs = path.split('/').filter(Boolean);
  const last = segs[segs.length - 1] ?? '';
  const prev = segs[segs.length - 2] ?? '';
  const lastIsParam = last.startsWith('{');
  const prevIsParam = prev.startsWith('{');
  if (method === 'GET') return lastIsParam ? 'get' : 'list';
  if (method === 'DELETE') return 'delete';
  if (method === 'PATCH') return prevIsParam && !lastIsParam ? last.replace(/-/g, '_') : 'update';
  if (method === 'POST') return prevIsParam && !lastIsParam ? last.replace(/-/g, '_') : 'create';
  return method.toLowerCase();
}

/** Scope token used to disambiguate same-domain operations in different scopes. */
export function deriveScope(path: string): string {
  const s = path.replace(/^\/api\//, '');
  if (s.startsWith('dashboard/admin/')) return 'dash';
  if (s.startsWith('admin/')) return 'admin';
  if (s.startsWith('organizations/')) return 'tenant';
  return '';
}

/** Base id: `<domain>[_subpath]_<action>` (no scope suffix). */
export function deriveBaseToolId(method: string, path: string): string {
  const s = path.replace(/^\/api\//, '');
  const domain = deriveDomain(s);
  return [domain, ...deriveSubpath(s, domain), deriveAction(method, path)].join('_');
}

/**
 * Assign unique tool ids to all endpoints (two-pass):
 * pass 1 groups by base id; pass 2 disambiguates collisions with the scope token.
 */
export function assignToolIds(endpoints: EndpointDef[]): Map<EndpointDef, string> {
  const baseCount = new Map<string, number>();
  for (const ep of endpoints) {
    const bid = deriveBaseToolId(ep.method, ep.path);
    baseCount.set(bid, (baseCount.get(bid) ?? 0) + 1);
  }
  const result = new Map<EndpointDef, string>();
  for (const ep of endpoints) {
    const bid = deriveBaseToolId(ep.method, ep.path);
    if ((baseCount.get(bid) ?? 0) > 1) {
      const scope = deriveScope(ep.path);
      result.set(ep, scope ? `${bid}_${scope}` : bid);
    } else {
      result.set(ep, bid);
    }
  }
  return result;
}

/** Build the input zod schema for an endpoint. */
function buildInputSchema(ep: EndpointDef, spec: OpenApiSpec): z.ZodObject<any> {
  const shape: Record<string, z.ZodTypeAny> = {};

  // Path params (always required)
  for (const [name, schema] of Object.entries(ep.pathParams)) {
    let field = schemaToZod(schema, spec);
    if (schema?.description) field = field.describe(schema.description);
    shape[name] = field;
  }

  // Query params (optional unless required)
  for (const [name, def] of Object.entries(ep.queryParams)) {
    let field = schemaToZod(def.schema, spec);
    if (def.schema?.description) field = field.describe(def.schema.description);
    // The portal accepts numbers for numeric query params (page, pageSize) even
    // though the spec types them as string — accept both and stringify on send.
    if (def.schema?.type === 'string') {
      const desc = def.schema?.description;
      field = z.union([z.string(), z.number()]);
      if (desc) field = field.describe(desc);
    }
    if (!def.required) field = field.optional();
    shape[name] = field;
  }

  // Request body — flatten top-level object fields into the input
  if (ep.bodySchema) {
    const bodyZod = schemaToZod(ep.bodySchema, spec);
    if (bodyZod instanceof z.ZodObject) {
      for (const [name, field] of Object.entries(bodyZod.shape)) {
        // body fields don't clobber path/query params
        if (!(name in shape)) shape[name] = field;
      }
    } else {
      // non-object body (rare) — accept a single `body` field
      shape.body = ep.bodySchema?.description
        ? bodyZod.describe(ep.bodySchema.description).optional()
        : bodyZod.optional();
    }
  }

  // Organization context override
  if (!('orgId' in shape)) {
    shape.orgId = z
      .string()
      .optional()
      .describe(
        'Organization id for tenant isolation (x-org-id). Defaults to the Platform org when unset.'
      );
  }

  return z.object(shape);
}

function buildDescription(ep: EndpointDef): string {
  const parts = [`${ep.method} ${ep.path}`];
  if (ep.summary) parts.push(ep.summary);
  if (ep.description) {
    // keep descriptions compact for the model — first paragraph only
    const first = ep.description.split('\n\n')[0].trim();
    if (first && first !== ep.summary) parts.push(first.slice(0, 500));
  }
  return parts.join(' — ');
}

/** Generate one Mastra tool per endpoint. */
export function generateTools(spec: OpenApiSpec, client: PortalClient, excludePrefixes: string[]): Record<string, any> {
  const endpoints = extractEndpoints(spec, excludePrefixes);
  const ids = assignToolIds(endpoints);
  const tools: Record<string, any> = {};
  for (const ep of endpoints) {
    const id = ids.get(ep)!;
    if (tools[id]) throw new Error(`Duplicate tool id: ${id}`);

    const inputSchema = buildInputSchema(ep, spec);

    tools[id] = createTool({
      id,
      description: buildDescription(ep),
      inputSchema,
      execute: async (input: any) => {
        const pathParams: Record<string, string> = {};
        const query: Record<string, unknown> = {};
        const bodyFields: Record<string, unknown> = {};

        for (const name of Object.keys(ep.pathParams)) {
          if (input[name] !== undefined) pathParams[name] = input[name];
        }
        for (const name of Object.keys(ep.queryParams)) {
          if (input[name] !== undefined) query[name] = input[name];
        }
        // everything else that isn't a path/query param / orgId is body data
        const known = new Set([...Object.keys(ep.pathParams), ...Object.keys(ep.queryParams), 'orgId']);
        for (const [k, v] of Object.entries(input)) {
          if (!known.has(k) && v !== undefined) bodyFields[k] = v;
        }

        const hasBody = ep.bodySchema !== undefined;
        const res = await client.request(ep.method, ep.path, {
          pathParams,
          query: query as any,
          body: hasBody ? (input.body !== undefined ? input.body : bodyFields) : undefined,
          orgId: input.orgId,
        });

        if (!res.ok) {
          return {
            success: false,
            status: res.status,
            error: typeof res.data === 'string' ? res.data : JSON.stringify(res.data),
          };
        }
        return { success: true, status: res.status, data: res.data };
      },
    });
  }
  return tools;
}

/** Convenience: load spec + generate all portal tools with the given (shared) client. */
export function buildPortalTools(config: PortalMcpConfig, client: PortalClient): Record<string, any> {
  const spec = loadSpec();
  return generateTools(spec, client, config.excludePathPrefixes);
}
