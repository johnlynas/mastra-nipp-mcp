/**
 * Audit: verify every generated tool forwards all required params per the OpenAPI spec.
 *
 * 1. For each endpoint, fill a synthetic input covering ALL path/query/body fields
 *    (required + optional) and run the real tool execute() against a stub client.
 * 2. Assert the recorded HTTP request contains every param in the right place:
 *    - path template fully substituted (no leftover {…})
 *    - every query param present with the exact value
 *    - body carries every non-path/query field
 * 3. Also verify the zod input schema marks required fields as required.
 */
import { loadSpec } from '../src/mastra/spec.js';
import { extractEndpoints, generateTools, assignToolIds } from '../src/mastra/tools/generate.js';

interface Recorded {
  method: string;
  path: string;
  opts: any;
}

const recorded: Recorded[] = [];
const stubClient: any = {
  request: async (method: string, path: string, opts: any) => {
    recorded.push({ method, path, opts });
    return { status: 200, ok: true, data: {} };
  },
};

const spec = loadSpec();
const endpoints = extractEndpoints(spec, ['/api/auth', '/api/csp-report', '/api/health']);
const ids = assignToolIds(endpoints);
const tools = generateTools(spec, stubClient, ['/api/auth', '/api/csp-report', '/api/health']);

console.log(`tools generated: ${Object.keys(tools).length} / endpoints: ${endpoints.length}`);

function fillValue(schema: any): unknown {
  if (!schema || typeof schema !== 'object') return 'x';
  if (schema.$ref) {
    const parts = schema.$ref.replace(/^#\//, '').split('/');
    let node: any = spec;
    for (const p of parts) node = node?.[p];
    return fillValue(node);
  }
  switch (schema.type) {
    case 'string':
      if (schema.enum) return schema.enum[0];
      if (schema.format === 'email') return 'test@example.com';
      return 'test-value';
    case 'integer': return 1;
    case 'number': return 1.5;
    case 'boolean': return true;
    case 'array': return [fillValue(schema.items)];
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries<any>(schema.properties ?? {})) out[k] = fillValue(v);
      return out;
    }
    default:
      if (schema.anyOf || schema.oneOf) {
        const variants = (schema.anyOf ?? schema.oneOf).map((s: any) => fillValue(s));
        return variants.find((v: unknown) => v !== null) ?? null;
      }
      return {};
  }
}

let failures = 0;
for (const ep of endpoints) {
  const id = ids.get(ep)!;
  const tool: any = tools[id];
  if (!tool) { console.log(`FAIL ${id}: no tool`); failures++; continue; }

  // Build a synthetic input with every field the spec declares.
  const input: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(ep.pathParams)) input[name] = fillValue(schema);
  for (const [name, def] of Object.entries(ep.queryParams)) input[name] = fillValue(def.schema);
  if (ep.bodySchema) {
    const bodyZod: any = tool.inputSchema; // not needed here
    const props: Record<string, any> = {};
    let s: any = ep.bodySchema;
    while (s?.$ref) {
      const parts = s.$ref.replace(/^#\//, '').split('/');
      let node: any = spec;
      for (const p of parts) node = node?.[p];
      s = node;
    }
    if (s?.properties) Object.assign(props, s.properties);
    for (const [k, v] of Object.entries(props)) if (!(k in input)) input[k] = fillValue(v);
  }

  recorded.length = 0;
  let err: string | null = null;
  try {
    await tool.execute(input, {});
  } catch (e: any) {
    err = String(e?.message ?? e);
  }
  if (err || recorded.length !== 1) {
    console.log(`FAIL ${id}: execute error=${err} recorded=${recorded.length}`);
    failures++;
    continue;
  }
  const rec = recorded[0];
  const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  // 1. path substitution complete?
  if (/\{[^}]+\}/.test(rec.opts.pathParams ? JSON.stringify(rec.path) : '') || /\{[^}]+\}/.test(rec.path)) {
    // check the URL that would be built: substitute like client does
    let url = rec.path;
    for (const [n, v] of Object.entries(rec.opts.pathParams ?? {})) url = url.replace(`{${n}}`, String(v));
    if (/\{[^}]+\}/.test(url)) {
      console.log(`FAIL ${id}: unsubstituted path param in ${url}`);
      failures++;
      continue;
    }
  }
  // every declared path param present in opts.pathParams
  for (const name of Object.keys(ep.pathParams)) {
    if (rec.opts.pathParams?.[name] === undefined) {
      console.log(`FAIL ${id}: path param '${name}' not forwarded`); failures++;
    }
  }
  // every query param present with exact value
  for (const [name, v] of Object.entries(input)) {
    if (name in ep.queryParams && !eq(rec.opts.query?.[name], v)) {
      console.log(`FAIL ${id}: query '${name}' expected=${JSON.stringify(v)} got=${JSON.stringify(rec.opts.query?.[name])}`);
      failures++;
    }
  }
  // body: every body field that is not path/query/orgId must be in opts.body
  if (ep.bodySchema) {
    const known = new Set([...Object.keys(ep.pathParams), ...Object.keys(ep.queryParams), 'orgId']);
    for (const [k, v] of Object.entries(input)) {
      if (!known.has(k) && !eq(rec.opts.body?.[k], v)) {
        console.log(`FAIL ${id}: body field '${k}' expected=${JSON.stringify(v)} got=${JSON.stringify(rec.opts.body?.[k])}`);
        failures++;
      }
    }
  }

  // 2. required-ness in the zod input schema
  const shape = tool.inputSchema.shape;
  for (const name of Object.keys(ep.pathParams)) {
    if (shape[name]?.isOptional()) { console.log(`FAIL ${id}: path param '${name}' is optional in schema`); failures++; }
  }
  for (const [name, def] of Object.entries(ep.queryParams)) {
    if (def.required && shape[name]?.isOptional()) { console.log(`FAIL ${id}: required query '${name}' is optional in schema`); failures++; }
  }
  if (ep.bodySchema) {
    let s: any = ep.bodySchema;
    while (s?.$ref) {
      const parts = s.$ref.replace(/^#\//, '').split('/');
      let node: any = spec;
      for (const p of parts) node = node?.[p];
      s = node;
    }
    const req: string[] = Array.isArray(s?.required) ? s.required : [];
    for (const name of req) {
      if (!(name in shape)) continue; // clobbered by path/query? shouldn't happen
      if (shape[name]?.isOptional()) { console.log(`FAIL ${id}: required body field '${name}' is optional in schema`); failures++; }
    }
  }
}

console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} FAILURES`);
