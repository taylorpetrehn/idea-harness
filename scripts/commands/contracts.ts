/**
 * scripts/commands/contracts.ts
 *
 * `harness contracts` — emit JSON Schema for every verb's data shape
 * and event types so agents can validate envelope payloads without
 * guessing.
 *
 * Output payload (in the `data` field of the envelope):
 *   {
 *     schema_version: "harness/v1",
 *     verbs: [
 *       { verb, description, data, events? }   // each shape as JSON Schema
 *     ]
 *   }
 */

import { z } from "zod";
import { Output } from "../lib/output";
import {
  SCHEMA_VERSION,
  listVerbContracts,
  registerVerb,
  SuccessEnvelope,
  ErrorEnvelope,
  HarnessEvent,
} from "../lib/contracts";

// Eager-import every verb module at load time so registerVerb() side
// effects populate the registry before `harness contracts` walks it.
// The CLI itself uses lazy imports for fast startup, but contracts is
// the one verb that needs every other module's registration to have
// run.
import "./capture";
import "./brainstorm";
import "./ideas";
import "./review";
import "./ship";
import "./build";
import "./cleanup";
import "./inspect";
import "./doctor";
import "./completions";
import "./serve";

export interface ContractsArgs {
  /** When true, include the envelope and event base schemas alongside verbs. */
  includeMeta?: boolean;
}

const ContractsDataSchema = z.object({
  schema_version: z.string(),
  meta: z
    .object({
      success_envelope: z.unknown(),
      error_envelope: z.unknown(),
      event: z.unknown(),
    })
    .optional(),
  verbs: z.array(
    z.object({
      verb: z.string(),
      description: z.string(),
      data: z.unknown(),
      events: z.record(z.unknown()).optional(),
    })
  ),
});

registerVerb({
  verb: "contracts",
  description: "Emit JSON Schema for every verb's envelope and event shapes.",
  data: ContractsDataSchema,
});

/**
 * Convert a Zod schema to a plain JSON-Schema-ish object. We don't
 * pull a full converter dep — we serialize a minimal description that
 * captures the shape (type, properties, required, enum). It's not RFC
 * Draft-2020 perfect, but it's machine-readable and good enough for
 * agents to validate against.
 */
function describe(schema: z.ZodTypeAny): unknown {
  const def: any = (schema as any)._def;
  const t: string = def?.typeName ?? "ZodUnknown";

  switch (t) {
    case "ZodString":
      return { type: "string" };
    case "ZodNumber":
      return { type: "number" };
    case "ZodBoolean":
      return { type: "boolean" };
    case "ZodLiteral":
      return { const: def.value };
    case "ZodEnum":
      return { type: "string", enum: def.values };
    case "ZodNativeEnum":
      return { type: "string", enum: Object.values(def.values) };
    case "ZodArray":
      return { type: "array", items: describe(def.type) };
    case "ZodObject": {
      const shape = def.shape() as Record<string, z.ZodTypeAny>;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [k, v] of Object.entries(shape)) {
        properties[k] = describe(v);
        const inner: any = (v as any)._def;
        const isOptional = inner?.typeName === "ZodOptional" || inner?.typeName === "ZodDefault";
        if (!isOptional) required.push(k);
      }
      return { type: "object", properties, required };
    }
    case "ZodOptional":
      return describe(def.innerType);
    case "ZodDefault":
      return describe(def.innerType);
    case "ZodUnion":
    case "ZodDiscriminatedUnion":
      return { anyOf: (def.options as z.ZodTypeAny[]).map(describe) };
    case "ZodRecord":
      return { type: "object", additionalProperties: describe(def.valueType) };
    case "ZodUnknown":
    case "ZodAny":
      return {};
    default:
      return { "x-zod-type": t };
  }
}

export async function run(args: ContractsArgs, out: Output): Promise<void> {
  const verbs = listVerbContracts().map((c) => ({
    verb: c.verb,
    description: c.description,
    data: describe(c.data),
    ...(c.events
      ? {
          events: Object.fromEntries(
            Object.entries(c.events).map(([k, v]) => [k, describe(v)])
          ),
        }
      : {}),
  }));

  const data: any = {
    schema_version: SCHEMA_VERSION,
    verbs,
  };

  if (args.includeMeta) {
    data.meta = {
      success_envelope: describe(SuccessEnvelope),
      error_envelope: describe(ErrorEnvelope),
      event: describe(HarnessEvent),
    };
  }

  out.result(data, `Found ${verbs.length} verb contract(s).`);
}
