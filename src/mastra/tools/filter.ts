/**
 * Per-caller tools/list filtering (phase 2 task 3).
 *
 * Non-admin callers don't see `_admin`-scoped tools in `tools/list` — context
 * savings for the LLM and a smaller prompt-injection surface. The call-time
 * scope gate (generate.ts) remains the authoritative security boundary: a
 * client can always call a tool it wasn't shown, and gets 403.
 *
 * Scope knowledge lives in `toolScopeRegistry`, populated by generateTools()
 * as each endpoint becomes a tool. Tools not in the registry (utility tools
 * like portal_health) are always shown.
 */
import type { McpCaller } from '../auth.js';

/** Minimal tool shape — anything with an id; generated Mastra tools qualify. */
export interface ToolDef {
  id?: string;
  [key: string]: unknown;
}

/** tool id → scope class, filled by generateTools() at generation time. */
export const toolScopeRegistry = new Map<string, 'admin' | 'dash' | 'tenant' | 'single'>();

/** Register a generated tool's scope (called from generateTools). */
export function registerToolScope(toolId: string, scope: 'admin' | 'dash' | 'tenant' | 'single'): void {
  toolScopeRegistry.set(toolId, scope);
}

/** Test seam. */
export function __resetToolScopeRegistryForTests(): void {
  toolScopeRegistry.clear();
}

/**
 * Drop admin-scoped tools for verified non-admin callers.
 * - `caller` null/undefined (legacy token-less request) → unfiltered, so
 *   existing non-agent clients keep the full surface until phase 3.
 * - platform admin → unfiltered.
 * - verified non-admin → `_admin` tools removed; `_dash` kept (the portal's
 *   requirePermission is the authority for those).
 */
export function filterToolsForCaller(
  all: Record<string, ToolDef>,
  caller: McpCaller | null | undefined,
): Record<string, ToolDef> {
  if (!caller || caller.isPlatformAdmin) return all;
  const out: Record<string, ToolDef> = {};
  for (const [id, tool] of Object.entries(all)) {
    if (toolScopeRegistry.get(id) === 'admin') continue;
    out[id] = tool;
  }
  return out;
}
