/**
 * Generates Mastra tools from the NIPP portal OpenAPI spec.
 *
 * Each (method, path) operation becomes one MCP tool:
 *   - id:      path segments (params dropped) + action suffix  → unique by construction
 *   - name:    same as id (MCP tool names)
 *   - input:   zod object from path params + query params + request body schema
 *   - execute: forwards the call to the portal via PortalClient with the session cookie
 *
 * The portal's admin surface is grouped by domain in its service layer
 * (organization, user, role, team, work-order, contractor, invoice, quote,
 * resource, unit, permission, job-scheduler, calendar) — the tool ids mirror
 * that grouping via their path prefix.
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

/** Derive a stable, unique tool id from method + path. */
export function deriveToolId(method: string, path: string): string {
  const segs = path
    .replace(/^\/api\//, '')
    .split('/')
    .filter((s) => s && !s.startsWith('{'));
  const last = path.split('/').filter(Boolean).pop() ?? '';
  const prev = path.split('/').filter(Boolean).slice(-2)[0] ?? '';
  const lastIsParam = last.startsWith('{');
  const prevIsParam = prev.startsWith('{');

  let action: string;
  if (method === 'GET') action = lastIsParam ? 'get' : 'list';
  else if (method === 'DELETE') action = 'delete';
  else if (method === 'PATCH') action = prevIsParam && !lastIsParam ? last.replace(/-/g, '_') : 'update';
  else if (method === 'POST') action = prevIsParam && !lastIsParam ? last.replace(/-/g, '_') : 'create';
  else action = method.toLowerCase();

  return [...segs, action].join('_');
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
  const tools: Record<string, any> = {};
  for (const ep of extractEndpoints(spec, excludePrefixes)) {
    const id = deriveToolId(ep.method, ep.path);
    if (tools[id]) continue; // defensive — ids are unique by construction

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

/** Convenience: load spec + generate all portal tools. */
export function buildPortalTools(config: PortalMcpConfig): Record<string, any> {
  const spec = loadSpec();
  const client = new PortalClient(config);
  return generateTools(spec, client, config.excludePathPrefixes);
}
