/**
 * scripts/commands/serve.ts
 *
 * `harness serve --mcp` — expose every harness verb as an MCP tool over
 * stdio. Tool input shapes are minimal Zod schemas declared inline; the
 * tool handler invokes the verb's run() with a buffered Output and
 * returns the captured envelope as the tool response. Same harness/v1
 * shape an agent gets from `harness <verb> --json`.
 *
 * The MCP SDK is in optionalDependencies so the harness still installs
 * cleanly on machines where the SDK isn't pulled. We lazy-import here
 * and surface ENV_MISSING if the package is absent.
 */

import { z } from "zod";
import { Output } from "../lib/output";
import { registerVerb, SuccessEnvelope, ErrorEnvelope, SCHEMA_VERSION } from "../lib/contracts";

export interface ServeArgs {
  mcp?: boolean;
}

const ServeData = z.object({
  transport: z.string(),
  tools: z.number(),
  status: z.string(),
});

registerVerb({
  verb: "serve",
  description: "Run as an MCP or HTTP server (currently --mcp over stdio).",
  data: ServeData,
});

// ── Buffered output capturer ────────────────────────────────────────
// Each MCP tool call needs its own Output that *doesn't* write to
// stdout/stderr (those are owned by the MCP transport itself).
// Instead, capture the final envelope and return it.

class BufferedOutput extends Output {
  private _envelope: SuccessEnvelope | ErrorEnvelope | null = null;
  private _events: Array<{ type: string; data: unknown }> = [];

  constructor(verb: string) {
    super({
      mode: "json",
      verb,
      stdout: () => {},
      stderr: () => {},
      color: false,
    });
  }

  override event(type: string, data: unknown = {}): void {
    this._events.push({ type, data });
  }
  override info(): void { /* swallow */ }
  override stdout(): void { /* swallow */ }

  override result(data: unknown, hint?: string): SuccessEnvelope {
    const env = super.result(data, hint);
    this._envelope = env;
    return env;
  }
  override error(
    code: any,
    message: string,
    opts: any = {}
  ): ErrorEnvelope {
    const env = super.error(code, message, opts);
    this._envelope = env;
    return env;
  }

  envelope(): SuccessEnvelope | ErrorEnvelope {
    if (this._envelope) return this._envelope;
    // Verb forgot to settle — synthesize an INTERNAL error so the MCP
    // client always gets a valid envelope.
    return {
      schema: SCHEMA_VERSION,
      verb: this.verb,
      ok: false,
      error: { code: "INTERNAL", message: "verb returned without producing a result" },
    };
  }
  events(): Array<{ type: string; data: unknown }> {
    return this._events;
  }
}

// ── Tool registry: { name, schema, run } per verb ───────────────────

interface ToolDef {
  name: string;
  description: string;
  inputShape: z.ZodRawShape;
  invoke: (args: any) => Promise<{ envelope: SuccessEnvelope | ErrorEnvelope; events: Array<{ type: string; data: unknown }> }>;
}

async function buildToolDefs(): Promise<ToolDef[]> {
  // Lazy import each verb module so unused ones don't pay startup cost.
  // Each tool wraps its verb's run() in a BufferedOutput.
  const wrap = async <A>(
    name: string,
    args: A,
    fn: (a: A, out: Output) => Promise<void>
  ) => {
    const out = new BufferedOutput(name);
    try {
      await fn(args, out);
    } catch (err) {
      if (!out.settled) {
        out.error("INTERNAL", (err as Error).message || String(err));
      }
    }
    return { envelope: out.envelope(), events: out.events() };
  };

  const tools: ToolDef[] = [
    {
      name: "harness_capture",
      description: "Capture a new idea from CLI text or an external source.",
      inputShape: {
        text: z.string().optional(),
        from: z.string().optional(),
        project: z.string().optional(),
      },
      invoke: async (a) => {
        const { run } = await import("./capture");
        return wrap("capture", { text: a.text ? [a.text] : [], from: a.from, project: a.project }, run);
      },
    },
    {
      name: "harness_brainstorm",
      description: "Run plan → harvest → brainstorm → schema → critic.",
      inputShape: { idea: z.string().optional(), dry: z.boolean().optional() },
      invoke: async (a) => {
        const { run } = await import("./brainstorm");
        return wrap("brainstorm", a, run);
      },
    },
    {
      name: "harness_ideas_list",
      description: "List ideas, optionally filtered by status or project.",
      inputShape: { status: z.string().optional(), project: z.string().optional() },
      invoke: async (a) => {
        const { runList } = await import("./ideas");
        return wrap("ideas.list", a, runList);
      },
    },
    {
      name: "harness_ideas_show",
      description: "Show one idea — full file or a single section.",
      inputShape: {
        slug: z.string(),
        section: z.enum(["frontmatter", "brainstorm", "notes", "raw"]).optional(),
      },
      invoke: async (a) => {
        const { runShow } = await import("./ideas");
        return wrap("ideas.show", a, runShow);
      },
    },
    {
      name: "harness_ideas_waiting",
      description: "Ideas waiting for review (brainstormed | needs-critic-review).",
      inputShape: {},
      invoke: async () => {
        const { runWaiting } = await import("./ideas");
        return wrap("ideas.waiting", {}, runWaiting);
      },
    },
    {
      name: "harness_review_next",
      description: "JSON envelope for the next idea Taylor should review.",
      inputShape: {},
      invoke: async () => {
        const { runNext } = await import("./review");
        return wrap("review.next", {}, runNext);
      },
    },
    {
      name: "harness_review_in_flight",
      description: "Bucket in-flight ideas (accepted | building | pr-open).",
      inputShape: {},
      invoke: async () => {
        const { runInFlight } = await import("./review");
        return wrap("review.in-flight", {}, runInFlight);
      },
    },
    {
      name: "harness_review_accept",
      description: "Mark an idea as accepted, optionally selecting a variant.",
      inputShape: {
        slug: z.string(),
        note: z.string().optional(),
        variant: z.string().optional(),
      },
      invoke: async (a) => {
        const { runAccept } = await import("./review");
        return wrap("review.accept", a, runAccept);
      },
    },
    {
      name: "harness_review_reject",
      description: "Mark an idea as rejected.",
      inputShape: { slug: z.string(), note: z.string().optional() },
      invoke: async (a) => {
        const { runReject } = await import("./review");
        return wrap("review.reject", a, runReject);
      },
    },
    {
      name: "harness_review_thought",
      description: "Mark needs-more-thought, increment loop counter.",
      inputShape: { slug: z.string(), note: z.string().optional() },
      invoke: async (a) => {
        const { runThought } = await import("./review");
        return wrap("review.thought", a, runThought);
      },
    },
    {
      name: "harness_ship",
      description: "Pick the next eligible idea and graduate or resume it.",
      inputShape: {
        slug: z.string().optional(),
        variant: z.string().optional(),
        yes: z.boolean().optional(),
        dry: z.boolean().optional(),
      },
      invoke: async (a) => {
        const { run } = await import("./ship");
        return wrap("ship", a, run);
      },
    },
    {
      name: "harness_build_status",
      description: "Read the most recent build state for an idea.",
      inputShape: { slug: z.string() },
      invoke: async (a) => {
        const { runStatus } = await import("./build");
        return wrap("build.status", a, runStatus);
      },
    },
    {
      name: "harness_inspect",
      description: "Show recent runs, idea counts, metrics, and project routing.",
      inputShape: { runs: z.number().optional(), metric: z.string().optional() },
      invoke: async (a) => {
        const { run } = await import("./inspect");
        return wrap("inspect", a, run);
      },
    },
    {
      name: "harness_doctor",
      description: "Environment health check.",
      inputShape: {},
      invoke: async () => {
        const { run } = await import("./doctor");
        return wrap("doctor", {}, run);
      },
    },
    {
      name: "harness_contracts",
      description: "Emit JSON Schema for every verb.",
      inputShape: { meta: z.boolean().optional() },
      invoke: async (a) => {
        const { run } = await import("./contracts");
        return wrap("contracts", { includeMeta: !!a.meta }, run);
      },
    },
  ];

  return tools;
}

// ── Server entry point ──────────────────────────────────────────────

export async function run(args: ServeArgs, out: Output): Promise<void> {
  if (!args.mcp) {
    out.error("BAD_INPUT", "Pass --mcp (HTTP transport not yet implemented).", {
      hint: "Phase 7 of proposals/next-gen-cli.md.",
    });
    return;
  }

  let McpServer: any;
  let StdioServerTransport: any;
  try {
    const mcpModule: any = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const stdioModule: any = await import("@modelcontextprotocol/sdk/server/stdio.js");
    McpServer = mcpModule.McpServer;
    StdioServerTransport = stdioModule.StdioServerTransport;
  } catch (err) {
    out.error("ENV_MISSING", "@modelcontextprotocol/sdk is not installed.", {
      hint: "It's in optionalDependencies; run `npm install @modelcontextprotocol/sdk` to enable MCP.",
    });
    return;
  }

  const server = new McpServer(
    { name: "harness", version: "2.0.0-alpha.1" },
    { capabilities: { tools: {} } }
  );

  const tools = await buildToolDefs();

  for (const t of tools) {
    server.registerTool(
      t.name,
      {
        description: t.description,
        inputSchema: t.inputShape,
      },
      async (rawArgs: any) => {
        const { envelope, events } = await t.invoke(rawArgs);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(envelope, null, 2),
            },
          ],
          // Forward captured events as `_meta` so an MCP client can
          // surface the lifecycle stream alongside the result.
          structuredContent: { envelope, events },
          isError: !envelope.ok,
        };
      }
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Long-running: the process stays alive until stdin closes. Don't
  // call out.result() here — that would dump JSON onto the stdio
  // stream the MCP transport owns. The caller sees the verb settle
  // when the transport disconnects.
  await new Promise<void>((resolve) => {
    process.stdin.on("end", () => resolve());
    process.stdin.on("close", () => resolve());
  });

  out.result(
    { transport: "stdio", tools: tools.length, status: "disconnected" },
    "Stdin closed; MCP server stopped."
  );
}
