/**
 * Final audit: for every endpoint, compare the JSON Schema exposed to MCP clients
 * against the OpenAPI spec's declared parameters.
 */
import { z } from 'zod';
import { loadSpec } from '../src/mastra/spec.js';
import { extractEndpoints, generateTools, assignToolIds } from '../src/mastra/tools/generate.js';

const spec = loadSpec();
const endpoints = extractEndpoints(spec, ['/api/auth', '/api/csp-report', '/api/health']);
const ids = assignToolIds(endpoints);
const tools: any = generateTools(spec, { request: async () => ({ status: 200, ok: true, data: {} }) }, ['/api/auth', '/api/csp-report', '/api/health']);

let failures = 0;
for (const ep of endpoints) {
  const id = ids.get(ep)!;
  const tool: any = tools[id];
  const js: any = z.toJSONSchema(tool.inputSchema, { io: 'input' });
  const props: Record<string, any> = js.properties ?? {};
  const required: string[] = js.required ?? [];

  for (const name of Object.keys(ep.pathParams)) {
    if (!(name in props)) { console.log(`FAIL ${id}: path param '${name}' missing from exposed schema`); failures++; }
    else if (!required.includes(name)) { console.log(`FAIL ${id}: path param '${name}' not marked required`); failures++; }
  }
  for (const [name, def] of Object.entries(ep.queryParams)) {
    if (!(name in props)) { console.log(`FAIL ${id}: query param '${name}' missing from exposed schema`); failures++; }
    else if (def.required && !required.includes(name)) { console.log(`FAIL ${id}: required query '${name}' not marked required`); failures++; }
  }
  if (ep.bodySchema) {
    let s: any = ep.bodySchema;
    while (s?.$ref) {
      const parts = s.$ref.replace(/^#\//, '').split('/');
      let node: any = spec;
      for (const p of parts) node = node?.[p];
      s = node;
    }
    const known = new Set([...Object.keys(ep.pathParams), ...Object.keys(ep.queryParams)]);
    for (const [name, v] of Object.entries<any>(s?.properties ?? {})) {
      if (known.has(name)) continue;
      if (!(name in props)) { console.log(`FAIL ${id}: body field '${name}' missing from exposed schema`); failures++; }
    }
  }
}
console.log(failures === 0 ? `ALL ${endpoints.length} ENDPOINTS: every spec-declared param present in the client-facing JSON Schema` : `${failures} FAILURES`);
