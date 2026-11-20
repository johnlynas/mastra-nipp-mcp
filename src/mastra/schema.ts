/**
 * Convert OpenAPI JSON Schema objects to Zod schemas.
 * Handles $ref, object, array, primitives, enum, nullable, default.
 */
import { z } from 'zod';
import type { OpenApiSpec } from './spec.js';
import { resolveRef } from './spec.js';

const MAX_DEPTH = 12;

export function schemaToZod(schema: any, spec: OpenApiSpec, depth = 0): z.ZodTypeAny {
  if (!schema || typeof schema !== 'object') {
    return z.unknown();
  }

  // $ref → resolve and recurse
  if (schema.$ref) {
    const resolved = resolveRef(schema.$ref, spec);
    if (!resolved) return z.unknown();
    return schemaToZod(resolved, spec, depth + 1);
  }

  if (depth > MAX_DEPTH) return z.unknown();

  // nullable wrapper
  let base: z.ZodTypeAny;

  switch (schema.type) {
    case 'object':
      base = objectToZod(schema, spec, depth);
      break;
    case 'array':
      base = arrayToZod(schema, spec, depth);
      break;
    case 'string':
      base = stringToZod(schema);
      break;
    case 'integer':
    case 'number':
      base = numberToZod(schema);
      break;
    case 'boolean':
      base = z.boolean();
      break;
    default:
      // no type — could be allOf/oneOf/anyOf or just unknown
      if (schema.allOf) {
        const merged = schema.allOf.map((s: any) => schemaToZod(s, spec, depth + 1));
        base = merged.length === 1 ? merged[0] : z.record(z.string(), z.unknown());
      } else if (schema.oneOf || schema.anyOf) {
        const variants = (schema.oneOf ?? schema.anyOf).map((s: any) => schemaToZod(s, spec, depth + 1));
        base = z.union(variants);
      } else {
        base = z.record(z.string(), z.unknown());
      }
  }

  // nullable
  if (schema.nullable) {
    base = base.nullable();
  }

  return base;
}

function objectToZod(schema: any, spec: OpenApiSpec, depth: number): z.ZodTypeAny {
  const props = schema.properties ?? {};
  const required: string[] = Array.isArray(schema.required) ? schema.required : [];

  if (Object.keys(props).length === 0 && !schema.additionalProperties) {
    // empty object — accept anything
    return z.record(z.string(), z.unknown());
  }

  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, val] of Object.entries<any>(props)) {
    let field = schemaToZod(val, spec, depth + 1);
    // attach description
    if (val?.description) {
      field = field.describe(val.description);
    }
    if (!required.includes(key)) {
      field = field.optional();
      // A documented default only makes sense on optional fields — applying
      // .default() to a required field would make the input optional in zod,
      // silently violating the spec (e.g. DashboardCreateRoleBody.isDefault).
      if (val?.default !== undefined) {
        field = field.default(val.default);
      }
    }
    shape[key] = field;
  }

  let obj = z.object(shape);
  // allow extra fields the spec didn't enumerate
  return obj.passthrough();
}

function arrayToZod(schema: any, spec: OpenApiSpec, depth: number): z.ZodTypeAny {
  const itemSchema = schema.items ? schemaToZod(schema.items, spec, depth + 1) : z.unknown();
  return z.array(itemSchema);
}

function stringToZod(schema: any): z.ZodTypeAny {
  let s: z.ZodString | z.ZodEnum<any>;
  if (schema.enum) {
    s = z.enum(schema.enum as [string, ...string[]]);
  } else if (schema.format === 'email') {
    s = z.string().email();
  } else {
    s = z.string();
  }
  if (s instanceof z.ZodString) {
    if (schema.minLength) s = s.min(schema.minLength);
    if (schema.maxLength) s = s.max(schema.maxLength);
  }
  return s;
}

function numberToZod(schema: any): z.ZodTypeAny {
  let n: z.ZodNumber = schema.type === 'integer' ? z.number().int() : z.number();
  if (schema.minimum !== undefined) n = n.min(schema.minimum);
  if (schema.maximum !== undefined) n = n.max(schema.maximum);
  return n;
}
