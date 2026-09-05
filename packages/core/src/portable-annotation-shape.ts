const MAX_DEPTH = 12;
const MAX_ARRAY_ENTRIES = 256;
const MAX_OBJECT_ENTRIES = 128;
const MAX_NODES = 4_096;
const MAX_STRING_LENGTH = 16 * 1024;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Bound the shape accepted from or persisted into portable annotation metadata.
 * Writers and readers share this predicate so acknowledged metadata can always
 * pass the importer's defensive shape validation.
 */
export function hasSafePortableAnnotationShape(
  value: unknown,
  depth = 0,
  budget = { nodes: 0 },
): boolean {
  budget.nodes += 1;
  if (depth > MAX_DEPTH || budget.nodes > MAX_NODES) return false;
  if (typeof value === "string") return value.length <= MAX_STRING_LENGTH;
  if (value === null || typeof value === "boolean" || isFiniteNumber(value)) return true;
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ENTRIES) return false;
    return value.every((entry) =>
      hasSafePortableAnnotationShape(entry, depth + 1, budget));
  }
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (
    keys.length > MAX_OBJECT_ENTRIES ||
    keys.some((key) => FORBIDDEN_KEYS.has(key))
  ) return false;
  return keys.every((key) =>
    hasSafePortableAnnotationShape(value[key], depth + 1, budget));
}
