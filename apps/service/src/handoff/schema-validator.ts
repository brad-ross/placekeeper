import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { DispositionV1 } from "../../../../packages/core/src/disposition.js";
import type { HandoffV1 } from "../../../../packages/core/src/handoff.js";
import dispositionSchema from "../../../../schemas/disposition-v1.schema.json" with { type: "json" };
import handoffSchema from "../../../../schemas/handoff-v1.schema.json" with { type: "json" };

type SchemaName = "handoff" | "disposition";

const validators = new Map<SchemaName, Promise<ValidateFunction>>();

async function compile(name: SchemaName): Promise<ValidateFunction> {
  const schema = name === "handoff" ? handoffSchema : dispositionSchema;
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

export async function validateSchema(
  name: SchemaName,
  value: unknown,
): Promise<{ readonly valid: true } | { readonly valid: false; readonly errors: string }> {
  let pending = validators.get(name);
  if (pending === undefined) {
    pending = compile(name);
    validators.set(name, pending);
  }
  const validate = await pending;
  return validate(value)
    ? { valid: true }
    : { valid: false, errors: ajvErrors(validate) };
}

function uniqueIds(items: readonly { readonly id: string }[]): boolean {
  return new Set(items.map(({ id }) => id)).size === items.length;
}

export async function validateHandoffDocument(
  value: unknown,
): Promise<{ readonly valid: true; readonly value: HandoffV1 } | { readonly valid: false; readonly errors: string }> {
  const shape = await validateSchema("handoff", value);
  if (!shape.valid) return shape;
  const handoff = value as HandoffV1;
  if (!uniqueIds(handoff.items)) {
    return { valid: false, errors: "/items must contain unique stable IDs" };
  }
  return { valid: true, value: handoff };
}

export async function validateDispositionDocument(
  value: unknown,
): Promise<{ readonly valid: true; readonly value: DispositionV1 } | { readonly valid: false; readonly errors: string }> {
  const shape = await validateSchema("disposition", value);
  if (!shape.valid) return shape;
  const disposition = value as DispositionV1;
  if (!uniqueIds(disposition.items)) {
    return { valid: false, errors: "/items must contain unique stable IDs" };
  }
  return { valid: true, value: disposition };
}

function ajvErrors(validate: ValidateFunction): string {
  return (validate.errors ?? [])
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
    .join("; ");
}
