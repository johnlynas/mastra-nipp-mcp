/**
 * Loads and caches the NIPP portal OpenAPI spec.
 */
import { readFileSync } from 'node:fs';
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

export function loadSpec(): OpenApiSpec {
  if (cached) return cached;
  const here = path.dirname(fileURLToPath(import.meta.url));
  // openapi/openapi.json sits at project root; src/mastra is two levels up
  const specPath = path.resolve(here, '../../openapi/openapi.json');
  const raw = readFileSync(specPath, 'utf-8');
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
