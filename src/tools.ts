import { analyzeSchema, flattenSchema, nestArguments } from "./repair/flatten.js";
import type { JSONSchema, ToolSpec } from "./types.js";

/**
 * Per-call context a tool `fn` can optionally consume. Today the only
 * field is `signal`, plumbed through so long-running tools (MCP calls,
 * HTTP requests) can abort when the user presses Esc. Omitted fields
 * stay optional — tools written against the pre-0.4.9 signature keep
 * working; they just ignore cancellation, which is fine for fast
 * local work where "await finishes" happens before the next tick anyway.
 */
export interface ToolCallContext {
  signal?: AbortSignal;
}

export interface ToolDefinition<A = any, R = any> {
  name: string;
  description?: string;
  parameters?: JSONSchema;
  fn: (args: A, ctx?: ToolCallContext) => R | Promise<R>;
}

interface InternalTool extends ToolDefinition {
  /**
   * Pillar 3 — flatten metadata. Set when the registered schema is deep
   * (>2 levels) or wide (>10 leaf params), conditions on which DeepSeek
   * V3/R1 are known to drop arguments. We advertise the flattened schema
   * to the model, then re-nest the model's args before calling fn.
   */
  flatSchema?: JSONSchema;
}

export interface ToolRegistryOptions {
  /**
   * Auto-flatten schemas that exceed depth/width thresholds before sending
   * them to the model. Re-nests arguments transparently on dispatch.
   * Default: true. Pass false to opt out.
   */
  autoFlatten?: boolean;
}

export class ToolRegistry {
  private readonly _tools = new Map<string, InternalTool>();
  private readonly _autoFlatten: boolean;

  constructor(opts: ToolRegistryOptions = {}) {
    this._autoFlatten = opts.autoFlatten !== false;
  }

  register<A, R>(def: ToolDefinition<A, R>): this {
    if (!def.name) throw new Error("tool requires a name");
    const internal: InternalTool = { ...(def as ToolDefinition) };
    if (this._autoFlatten && def.parameters) {
      const decision = analyzeSchema(def.parameters);
      if (decision.shouldFlatten) {
        internal.flatSchema = flattenSchema(def.parameters);
      }
    }
    this._tools.set(def.name, internal);
    return this;
  }

  has(name: string): boolean {
    return this._tools.has(name);
  }

  get(name: string): ToolDefinition | undefined {
    return this._tools.get(name);
  }

  get size(): number {
    return this._tools.size;
  }

  /** True if a registered tool's schema was flattened for the model. */
  wasFlattened(name: string): boolean {
    return Boolean(this._tools.get(name)?.flatSchema);
  }

  specs(): ToolSpec[] {
    return [...this._tools.values()].map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description ?? "",
        parameters: t.flatSchema ?? t.parameters ?? { type: "object", properties: {} },
      },
    }));
  }

  async dispatch(
    name: string,
    argumentsRaw: string | Record<string, unknown>,
    opts: { signal?: AbortSignal } = {},
  ): Promise<string> {
    const tool = this._tools.get(name);
    if (!tool) {
      return JSON.stringify({ error: `unknown tool: ${name}` });
    }
    let args: Record<string, unknown>;
    try {
      args =
        typeof argumentsRaw === "string"
          ? argumentsRaw.trim()
            ? (JSON.parse(argumentsRaw) ?? {})
            : {}
          : (argumentsRaw ?? {});
    } catch (err) {
      return JSON.stringify({
        error: `invalid tool arguments JSON: ${(err as Error).message}`,
      });
    }

    // Re-nest dot-notation args back to the original shape, but only when
    // (a) we flattened this tool's schema, AND
    // (b) the incoming args actually use dot keys.
    // The second condition handles the case where a model ignores the flat
    // spec and emits nested args anyway — we shouldn't double-process them.
    if (tool.flatSchema && args && typeof args === "object" && hasDotKey(args)) {
      args = nestArguments(args);
    }

    try {
      const result = await tool.fn(args, { signal: opts.signal });
      return typeof result === "string" ? result : JSON.stringify(result);
    } catch (err) {
      return JSON.stringify({
        error: `${(err as Error).name}: ${(err as Error).message}`,
      });
    }
  }
}

function hasDotKey(obj: Record<string, unknown>): boolean {
  for (const k of Object.keys(obj)) {
    if (k.includes(".")) return true;
  }
  return false;
}
