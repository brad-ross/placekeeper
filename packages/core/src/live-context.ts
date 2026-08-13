import { createHash } from "node:crypto";

import { documentOrderedItems } from "./annotation-projection.js";
import {
  projectStructuredReviewItem,
  type SourceHint,
  type StructuredReviewItem,
} from "./structured-review-item.js";
import type { PdfRect } from "./pdf-writer.js";
import type { JsonValue, ReviewItem, ReviewSourceIdentity } from "./review-model.js";
import { assertReviewItem } from "./review-reducer.js";
import type { SaveFailureReason } from "./save-status.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HANDLE_PATTERN = /^[A-Za-z0-9._~-]{16,512}$/u;

export class InvalidLiveContextContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidLiveContextContractError";
  }
}

export interface LiveObservationIdentity {
  readonly placekeeperSessionId: string;
  readonly documentGeneration: number;
  readonly source: ReviewSourceIdentity;
  readonly reviewRevision: number;
  readonly stateDigest: string;
}

export type LiveContextUnavailableReason =
  | "unbound"
  | "pending"
  | "unavailable"
  | "stale_generation"
  | "expired"
  | "unauthorized";

export type LiveContextBindingStatus =
  | { readonly status: "unbound" }
  | {
      readonly status: "pending";
      readonly placekeeperSessionId: string;
      readonly documentGeneration: number;
      readonly expiresAt: string;
    }
  | {
      readonly status: "current";
      readonly identity: LiveObservationIdentity;
      readonly leaseExpiresAt: string;
    }
  | {
      readonly status: "refreshing";
      readonly placekeeperSessionId: string;
      readonly documentGeneration: number;
      readonly lastVerified?: LiveObservationIdentity;
    }
  | {
      readonly status: "unavailable";
      readonly reason: LiveContextUnavailableReason;
      readonly lastVerified?: LiveObservationIdentity;
    };

export interface ReviewSnapshot {
  readonly cursor: string;
  readonly revision: number;
  readonly semanticDigest: string;
  readonly items: readonly StructuredReviewItem[];
}

interface ReviewChangeBase {
  readonly cursor: string;
  readonly revision: number;
  readonly semanticDigest: string;
  readonly itemCount: number;
}

export type ReviewItemChanges =
  | (ReviewChangeBase & {
      readonly mode: "full";
      readonly reason: "initial" | "unknown-cursor";
      readonly items: readonly StructuredReviewItem[];
    })
  | (ReviewChangeBase & {
      readonly mode: "unchanged";
      readonly baseCursor: string;
    })
  | (ReviewChangeBase & {
      readonly mode: "delta";
      readonly baseCursor: string;
      readonly added: readonly StructuredReviewItem[];
      readonly edited: readonly StructuredReviewItem[];
      readonly removed: readonly string[];
    });

export interface ExistingPdfAnnotation {
  readonly id: string;
  readonly origin: "source-pdf";
  readonly readOnly: true;
  readonly pageIndex: number;
  readonly subtype: string;
  readonly contents?: string;
  readonly author?: string;
  readonly rect?: PdfRect;
  readonly flags?: readonly string[];
  readonly appearanceModes?: readonly string[];
  readonly supportedAppearance?: boolean;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
}

export interface ExistingPdfAnnotationInventory {
  readonly semanticDigest: string;
  readonly count: number;
  readonly items: readonly ExistingPdfAnnotation[];
  readonly warnings: readonly string[];
}

export const PDF_EVIDENCE_KINDS = [
  "document",
  "page-text",
  "page-layout",
  "page-render",
  "raw-annotations",
] as const;

export type PdfEvidenceKind = (typeof PDF_EVIDENCE_KINDS)[number];

export interface PdfEvidenceHandle {
  readonly schemaVersion: 1;
  readonly value: string;
  readonly documentGeneration: number;
  readonly observationDigest: string;
  readonly expiresAt: string;
  readonly maxBytes: number;
}

export interface PdfEvidenceDescriptor {
  readonly id: string;
  readonly kind: PdfEvidenceKind;
  readonly mediaType: string;
  readonly pages?: { readonly start: number; readonly end: number };
}

export interface PdfEvidenceCatalog {
  readonly handle: PdfEvidenceHandle;
  readonly descriptors: readonly PdfEvidenceDescriptor[];
}

/** Prompt-safe save health deliberately omits destination paths and capabilities. */
export interface LiveSaveStatus {
  readonly destination:
    | { readonly phase: "none"; readonly generation: 0 }
    | { readonly phase: "establishing"; readonly generation: number }
    | {
        readonly phase: "active";
        readonly generation: number;
        readonly kind: "original" | "copy";
      };
  readonly sync: {
    readonly phase: "clean" | "saving" | "not-saved";
    readonly desiredRevision: number;
    readonly savedRevision: number;
    readonly failure?: SaveFailureReason;
  };
}

export interface AtomicLiveContextObservationV1 {
  readonly schemaVersion: 1;
  readonly status: "current";
  readonly observedAt: string;
  readonly identity: LiveObservationIdentity;
  readonly saveStatus: LiveSaveStatus;
  readonly reviewItems: ReviewItemChanges;
  readonly existingPdfAnnotations: ExistingPdfAnnotationInventory;
  readonly evidence: PdfEvidenceCatalog;
}

export interface UnavailableLiveContextObservationV1 {
  readonly schemaVersion: 1;
  readonly status: "unavailable";
  readonly checkedAt: string;
  readonly reason: LiveContextUnavailableReason;
  readonly lastVerified?: LiveObservationIdentity;
}

export type LiveContextRefreshResult =
  | AtomicLiveContextObservationV1
  | UnavailableLiveContextObservationV1;

export interface SourceFingerprint {
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface LiveExecutionBaselineV1 {
  readonly schemaVersion: 1;
  readonly executionId: string;
  readonly capturedAt: string;
  readonly identity: LiveObservationIdentity;
  readonly items: readonly StructuredReviewItem[];
  readonly sourceFingerprints: readonly SourceFingerprint[];
  readonly baselineDigest: string;
}

export type ReconciliationClassification =
  | "equivalent"
  | "independent"
  | "conflict"
  | "ambiguous"
  | "removed";

export type ReconciliationOutcomeV1 =
  | {
      readonly baselineItemId: string;
      readonly classification: "equivalent";
      readonly action: "deduplicate";
      readonly authority: "manual";
      readonly explanation: string;
    }
  | {
      readonly baselineItemId: string;
      readonly classification: "independent";
      readonly action: "apply";
      readonly authority: "codex";
      readonly explanation: string;
    }
  | {
      readonly baselineItemId: string;
      readonly classification: "conflict" | "ambiguous";
      readonly action: "adapt" | "skip";
      readonly authority: "manual";
      readonly explanation: string;
    }
  | {
      readonly baselineItemId: string;
      readonly classification: "removed";
      readonly action: "skip";
      readonly authority: "manual";
      readonly explanation: string;
    };

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new InvalidLiveContextContractError("Canonical content contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object" || value === undefined) {
    throw new InvalidLiveContextContractError("Canonical content must be JSON serializable");
  }
  const record = value as Record<string, unknown>;
  const fields = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${fields.join(",")}}`;
}

export function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

const sha256 = canonicalSha256;

function assertNonEmpty(value: string, name: string): void {
  if (value.length === 0) throw new InvalidLiveContextContractError(`${name} must not be empty`);
}

function assertIsoDate(value: string, name: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new InvalidLiveContextContractError(`${name} must be a valid timestamp`);
  }
}

function assertSha256(value: string, name: string): void {
  if (!SHA256_PATTERN.test(value)) {
    throw new InvalidLiveContextContractError(`${name} must be a lowercase SHA-256 digest`);
  }
}

function assertGeneration(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvalidLiveContextContractError("documentGeneration must be a non-negative safe integer");
  }
}

function assertIdentity(identity: LiveObservationIdentity): void {
  assertNonEmpty(identity.placekeeperSessionId, "placekeeperSessionId");
  assertGeneration(identity.documentGeneration);
  if (!Number.isSafeInteger(identity.reviewRevision) || identity.reviewRevision < 0) {
    throw new InvalidLiveContextContractError("reviewRevision must be a non-negative safe integer");
  }
  assertNonEmpty(identity.source.fileId, "source.fileId");
  assertSha256(identity.source.digest, "source.digest");
  if (!Number.isSafeInteger(identity.source.byteLength) || identity.source.byteLength < 0) {
    throw new InvalidLiveContextContractError("source.byteLength must be a non-negative safe integer");
  }
  assertSha256(identity.stateDigest, "stateDigest");
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new InvalidLiveContextContractError(`${label} must contain unique values`);
  }
}

function structuredItemDigest(item: StructuredReviewItem): string {
  return sha256(item);
}

function structuredItemCoordinate(item: StructuredReviewItem, field: "x" | "y"): number {
  const value = item.coordinates.rect[field];
  return typeof value === "number" && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function orderStructuredItems(items: readonly StructuredReviewItem[]): StructuredReviewItem[] {
  return items.toSorted((left, right) =>
    left.pageIndex - right.pageIndex ||
    structuredItemCoordinate(left, "y") - structuredItemCoordinate(right, "y") ||
    structuredItemCoordinate(left, "x") - structuredItemCoordinate(right, "x") ||
    left.id.localeCompare(right.id));
}

export function reviewSemanticDigest(items: readonly ReviewItem[]): string {
  assertUnique(items.map(({ id }) => id), "Review Item IDs");
  const canonical = items.map((item) => {
    assertReviewItem(item);
    return {
      id: item.id,
      kind: item.kind,
      pageIndex: item.pageIndex,
      payload: item.payload,
    };
  }).toSorted((left, right) => left.id.localeCompare(right.id));
  return sha256(canonical);
}

export function createReviewSnapshot(input: {
  readonly cursor: string;
  readonly revision: number;
  readonly items: readonly ReviewItem[];
  readonly sourceHints?: ReadonlyMap<string, SourceHint>;
}): ReviewSnapshot {
  assertNonEmpty(input.cursor, "cursor");
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) {
    throw new InvalidLiveContextContractError("revision must be a non-negative safe integer");
  }
  assertUnique(input.items.map(({ id }) => id), "Review Item IDs");
  const ordered = documentOrderedItems(input.items);
  const items = ordered.map((item) => {
    assertReviewItem(item);
    return projectStructuredReviewItem(item, input.sourceHints?.get(item.id));
  });
  return {
    cursor: input.cursor,
    revision: input.revision,
    semanticDigest: reviewSemanticDigest(input.items),
    items,
  };
}

export function diffReviewSnapshots(input: {
  readonly current: ReviewSnapshot;
  readonly previous?: ReviewSnapshot;
  readonly cursorStatus?: "known" | "unknown";
}): ReviewItemChanges {
  const common = {
    cursor: input.current.cursor,
    revision: input.current.revision,
    semanticDigest: input.current.semanticDigest,
    itemCount: input.current.items.length,
  };
  if (input.previous === undefined || input.cursorStatus === "unknown") {
    return {
      mode: "full",
      reason: input.previous === undefined ? "initial" : "unknown-cursor",
      ...common,
      items: input.current.items,
    };
  }

  const previousById = new Map(input.previous.items.map((item) => [item.id, item]));
  const currentById = new Map(input.current.items.map((item) => [item.id, item]));
  const added = input.current.items.filter(({ id }) => !previousById.has(id));
  const edited = input.current.items.filter((item) => {
    const previous = previousById.get(item.id);
    return previous !== undefined && structuredItemDigest(previous) !== structuredItemDigest(item);
  });
  const removed = input.previous.items
    .filter(({ id }) => !currentById.has(id))
    .map(({ id }) => id)
    .toSorted();

  if (added.length === 0 && edited.length === 0 && removed.length === 0) {
    return { mode: "unchanged", baseCursor: input.previous.cursor, ...common };
  }
  return {
    mode: "delta",
    baseCursor: input.previous.cursor,
    ...common,
    added,
    edited,
    removed,
  };
}

function descriptorSelector(descriptor: PdfEvidenceDescriptor): string {
  return `${descriptor.kind}:${descriptor.pages?.start ?? "all"}:${descriptor.pages?.end ?? "all"}`;
}

export function createPdfEvidenceCatalog(input: PdfEvidenceCatalog): PdfEvidenceCatalog {
  const { handle } = input;
  if (handle.schemaVersion !== 1 || !HANDLE_PATTERN.test(handle.value)) {
    throw new InvalidLiveContextContractError("Evidence handle is malformed");
  }
  assertGeneration(handle.documentGeneration);
  assertSha256(handle.observationDigest, "Evidence observationDigest");
  assertIsoDate(handle.expiresAt, "Evidence expiresAt");
  if (!Number.isSafeInteger(handle.maxBytes) || handle.maxBytes <= 0) {
    throw new InvalidLiveContextContractError("Evidence maxBytes must be a positive safe integer");
  }

  assertUnique(input.descriptors.map(({ id }) => id), "Evidence descriptor IDs");
  const selectors = new Set<string>();
  for (const descriptor of input.descriptors) {
    assertNonEmpty(descriptor.id, "Evidence descriptor id");
    assertNonEmpty(descriptor.mediaType, "Evidence mediaType");
    if (!(PDF_EVIDENCE_KINDS as readonly string[]).includes(descriptor.kind)) {
      throw new InvalidLiveContextContractError("Evidence kind is not supported");
    }
    if (descriptor.pages !== undefined && (
      !Number.isSafeInteger(descriptor.pages.start) || descriptor.pages.start < 0 ||
      !Number.isSafeInteger(descriptor.pages.end) || descriptor.pages.end < descriptor.pages.start
    )) {
      throw new InvalidLiveContextContractError("Evidence page range is malformed");
    }
    if (
      descriptor.kind !== "raw-annotations" &&
      descriptor.kind !== "document" &&
      descriptor.pages === undefined
    ) {
      throw new InvalidLiveContextContractError("Page evidence requires a page range");
    }
    if (descriptor.kind === "document" && descriptor.pages !== undefined) {
      throw new InvalidLiveContextContractError("Document evidence cannot select pages");
    }
    const selector = descriptorSelector(descriptor);
    if (selectors.has(selector)) {
      throw new InvalidLiveContextContractError("Evidence contains a duplicate semantic descriptor");
    }
    selectors.add(selector);
  }
  return {
    handle: { ...handle },
    descriptors: input.descriptors.map((descriptor) => ({
      ...descriptor,
      ...(descriptor.pages === undefined ? {} : { pages: { ...descriptor.pages } }),
    })),
  };
}

function orderExistingAnnotations(items: readonly ExistingPdfAnnotation[]): ExistingPdfAnnotation[] {
  return items.toSorted((left, right) =>
    left.pageIndex - right.pageIndex ||
    (left.rect?.y ?? Number.MAX_SAFE_INTEGER) - (right.rect?.y ?? Number.MAX_SAFE_INTEGER) ||
    (left.rect?.x ?? Number.MAX_SAFE_INTEGER) - (right.rect?.x ?? Number.MAX_SAFE_INTEGER) ||
    left.id.localeCompare(right.id));
}

export function existingPdfAnnotationsSemanticDigest(
  items: readonly ExistingPdfAnnotation[],
): string {
  const ordered = items.toSorted((left, right) =>
    left.pageIndex - right.pageIndex || left.id.localeCompare(right.id));
  return sha256(ordered);
}

function createExistingInventory(input: {
  readonly items: readonly ExistingPdfAnnotation[];
  readonly warnings: readonly string[];
}): ExistingPdfAnnotationInventory {
  assertUnique(
    input.items.map(({ id, pageIndex }) => `${pageIndex}:${id}`),
    "Existing PDF Annotation page identities",
  );
  for (const item of input.items) {
    assertNonEmpty(item.id, "Existing annotation id");
    if (item.origin !== "source-pdf" || item.readOnly !== true) {
      throw new InvalidLiveContextContractError("Existing PDF Annotations must remain source-PDF read-only records");
    }
    if (!Number.isSafeInteger(item.pageIndex) || item.pageIndex < 0) {
      throw new InvalidLiveContextContractError("Existing annotation pageIndex must be non-negative");
    }
    assertNonEmpty(item.subtype, "Existing annotation subtype");
  }
  const items = orderExistingAnnotations(input.items);
  return {
    semanticDigest: existingPdfAnnotationsSemanticDigest(items),
    count: items.length,
    items,
    warnings: [...input.warnings],
  };
}

export function createAtomicLiveContextObservation(input: {
  readonly observedAt: string;
  readonly identity: LiveObservationIdentity;
  readonly saveStatus: LiveSaveStatus;
  readonly reviewItems: ReviewItemChanges;
  readonly existingPdfAnnotations: {
    readonly items: readonly ExistingPdfAnnotation[];
    readonly warnings: readonly string[];
  };
  readonly evidence: PdfEvidenceCatalog;
}): AtomicLiveContextObservationV1 {
  assertIsoDate(input.observedAt, "observedAt");
  assertIdentity(input.identity);
  if (
    input.identity.reviewRevision !== input.reviewItems.revision ||
    input.identity.stateDigest !== input.reviewItems.semanticDigest
  ) {
    throw new InvalidLiveContextContractError("Observation identity must match its Review Item snapshot");
  }
  if (
    input.evidence.handle.documentGeneration !== input.identity.documentGeneration ||
    input.evidence.handle.observationDigest !== input.identity.stateDigest
  ) {
    throw new InvalidLiveContextContractError("Evidence handle must match the atomic observation");
  }
  return {
    schemaVersion: 1,
    status: "current",
    observedAt: input.observedAt,
    identity: { ...input.identity, source: { ...input.identity.source } },
    saveStatus: input.saveStatus,
    reviewItems: input.reviewItems,
    existingPdfAnnotations: createExistingInventory(input.existingPdfAnnotations),
    evidence: createPdfEvidenceCatalog(input.evidence),
  };
}

export function createUnavailableLiveContextObservation(input: {
  readonly checkedAt: string;
  readonly reason: LiveContextUnavailableReason;
  readonly lastVerified?: LiveObservationIdentity;
}): UnavailableLiveContextObservationV1 {
  assertIsoDate(input.checkedAt, "checkedAt");
  if (input.lastVerified !== undefined) assertIdentity(input.lastVerified);
  return {
    schemaVersion: 1,
    status: "unavailable",
    checkedAt: input.checkedAt,
    reason: input.reason,
    ...(input.lastVerified === undefined
      ? {}
      : { lastVerified: { ...input.lastVerified, source: { ...input.lastVerified.source } } }),
  };
}

export function createExecutionBaseline(input: {
  readonly executionId: string;
  readonly capturedAt: string;
  readonly identity: LiveObservationIdentity;
  readonly items: readonly StructuredReviewItem[];
  readonly sourceFingerprints: readonly SourceFingerprint[];
}): LiveExecutionBaselineV1 {
  assertNonEmpty(input.executionId, "executionId");
  assertIsoDate(input.capturedAt, "capturedAt");
  assertIdentity(input.identity);
  assertUnique(input.items.map(({ id }) => id), "Baseline Review Item IDs");
  assertUnique(input.sourceFingerprints.map(({ path }) => path), "Source fingerprint paths");
  const sourceFingerprints = input.sourceFingerprints.map((fingerprint) => {
    assertNonEmpty(fingerprint.path, "Source fingerprint path");
    if (fingerprint.path.startsWith("/") || fingerprint.path.split("/").includes("..")) {
      throw new InvalidLiveContextContractError("Source fingerprint paths must be contained relative paths");
    }
    assertSha256(fingerprint.sha256, "Source fingerprint sha256");
    if (!Number.isSafeInteger(fingerprint.byteLength) || fingerprint.byteLength < 0) {
      throw new InvalidLiveContextContractError("Source fingerprint byteLength must be non-negative");
    }
    return { ...fingerprint };
  }).toSorted((left, right) => left.path.localeCompare(right.path));
  const items = orderStructuredItems(input.items);
  const body = {
    executionId: input.executionId,
    capturedAt: input.capturedAt,
    identity: input.identity,
    items,
    sourceFingerprints,
  };
  return { schemaVersion: 1, ...body, baselineDigest: sha256(body) };
}

export function createReconciliationOutcome(input: {
  readonly baselineItemId: string;
  readonly classification: ReconciliationClassification;
  readonly action: "deduplicate" | "apply" | "adapt" | "skip";
  readonly authority: "manual" | "codex";
  readonly explanation: string;
}): ReconciliationOutcomeV1 {
  if (!UUID_PATTERN.test(input.baselineItemId)) {
    throw new InvalidLiveContextContractError("Reconciliation baselineItemId must be a UUID");
  }
  assertNonEmpty(input.explanation.trim(), "Reconciliation explanation");
  const valid =
    (input.classification === "equivalent" && input.action === "deduplicate" && input.authority === "manual") ||
    (input.classification === "independent" && input.action === "apply" && input.authority === "codex") ||
    ((input.classification === "conflict" || input.classification === "ambiguous") &&
      (input.action === "adapt" || input.action === "skip") && input.authority === "manual") ||
    (input.classification === "removed" && input.action === "skip" && input.authority === "manual");
  if (!valid) {
    throw new InvalidLiveContextContractError("Reconciliation must preserve manual work and use the matching conservative action");
  }
  return {
    baselineItemId: input.baselineItemId,
    classification: input.classification,
    action: input.action,
    authority: input.authority,
    explanation: input.explanation,
  } as ReconciliationOutcomeV1;
}
