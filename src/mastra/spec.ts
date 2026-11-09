/**
 * Loads and caches the NIPP portal OpenAPI spec.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export interface OpenApiSpec {
  openapi: string;
  info: { title: string; version: string };
  servers?: Array<{ url: string }>;
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, any> };
}

let cached: OpenApiSpec | null = null;

/**
 * Find openapi/openapi.json by walking up from this module's directory.
 * Works both from the source tree (<root>/src/mastra) and from Mastra's
 * bundled output (<root>/.mastra/output/tools/*.mjs), regardless of cwd.
 */
function findSpecFile(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'openapi', 'openapi.json');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Last resort: cwd (dev server may run from the project root)
  const cwdCandidate = path.resolve(process.cwd(), 'openapi/openapi.json');
  if (existsSync(cwdCandidate)) return cwdCandidate;
  throw new Error(
    'Could not find openapi/openapi.json. Copy the portal spec to <project>/openapi/openapi.json ' +
      '(from nipp-0111: npm run docs:generate → docs/openapi/generated/openapi.json).'
  );
}

export function loadSpec(): OpenApiSpec {
  if (cached) return cached;
  const raw = readFileSync(findSpecFile(), 'utf-8');
  cached = JSON.parse(raw) as OpenApiSpec;
  return cached;
}

/** Resolve a $ref like "#/components/schemas/Foo" to the schema object. */
export function resolveRef(ref: string, spec: OpenApiSpec): any {
  const parts = ref.replace(/^#\//, '').split('/');
  let node: any = spec;
  for (const part of parts) {
    node = node?.[part];
  }
  return node;
}
