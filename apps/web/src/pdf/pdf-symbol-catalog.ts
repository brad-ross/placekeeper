import { GENERATED_PDF_SYMBOL_CATALOG } from './pdf-symbol-catalog.generated.js';
import { isSingleUnicodeScalarQuery } from './pdf-search-model.js';

export type PdfSymbolRecordId = number;

export interface PdfSymbolSuggestion {
  readonly recordId: PdfSymbolRecordId;
  readonly codePoint: number;
  readonly glyph: string;
  readonly name: string;
  readonly preferredCommand: string | null;
  readonly commands: readonly string[];
  readonly entities: readonly string[];
  readonly names: readonly string[];
}

interface PdfSymbolRecord extends PdfSymbolSuggestion {
  readonly semanticFamilyCodePoints: readonly number[];
}

const RECORDS: readonly PdfSymbolRecord[] = GENERATED_PDF_SYMBOL_CATALOG.map(([
  codePoint,
  glyph,
  name,
  preferredCommand,
  commands,
  entities,
  names,
  semanticFamilyCodePoints,
], recordId) => ({
  recordId,
  codePoint,
  glyph,
  name,
  preferredCommand,
  commands,
  entities,
  names,
  semanticFamilyCodePoints,
}));

const GLYPH_INDEX = new Map<string, PdfSymbolRecordId>();
const CODE_POINT_INDEX = new Map<number, PdfSymbolRecordId>();
const COMMAND_INDEX = new Map<string, PdfSymbolRecordId[]>();
const ENTITY_INDEX = new Map<string, PdfSymbolRecordId[]>();
const NAME_INDEX = new Map<string, PdfSymbolRecordId[]>();

function addIndexEntry(
  index: Map<string, PdfSymbolRecordId[]>,
  key: string,
  recordId: PdfSymbolRecordId,
): void {
  const existing = index.get(key);
  if (existing) {
    if (existing.at(-1) !== recordId) existing.push(recordId);
  } else {
    index.set(key, [recordId]);
  }
}

function normalizedNaturalName(value: string): string {
  return value.normalize('NFC').trim().toLowerCase();
}

for (const record of RECORDS) {
  GLYPH_INDEX.set(record.glyph, record.recordId);
  CODE_POINT_INDEX.set(record.codePoint, record.recordId);
  for (const command of record.commands) addIndexEntry(COMMAND_INDEX, command, record.recordId);
  for (const entity of record.entities) addIndexEntry(ENTITY_INDEX, entity, record.recordId);
  for (const name of [record.name, ...record.names]) {
    const normalized = normalizedNaturalName(name);
    if (normalized.length > 0) addIndexEntry(NAME_INDEX, normalized, record.recordId);
  }
}

function sortedDetectedRecords(
  detectedRecordIds: ReadonlySet<PdfSymbolRecordId>,
): PdfSymbolSuggestion[] {
  return [...detectedRecordIds]
    .sort((left, right) => left - right)
    .flatMap((recordId) => {
      const record = RECORDS[recordId];
      return record ? [record] : [];
    });
}

function aliasCandidateIds(query: string): readonly PdfSymbolRecordId[] {
  const exactQuery = query.trim();
  if (exactQuery.length === 0 || isSingleUnicodeScalarQuery(exactQuery)) return [];
  if (exactQuery.startsWith('\\')) return COMMAND_INDEX.get(exactQuery) ?? [];

  // Exact, case-sensitive entity IDs take precedence over case-folded natural names.
  const entityCandidates = ENTITY_INDEX.get(exactQuery);
  if (entityCandidates) return entityCandidates;
  const naturalNameCandidates = NAME_INDEX.get(normalizedNaturalName(exactQuery)) ?? [];
  // Generated descriptions are retained for search, but an unaudited collision
  // cannot authorize semantic fan-out. Audited groups use command/entity data.
  return naturalNameCandidates.length === 1 ? naturalNameCandidates : [];
}

/** Incrementally adds generated record IDs found in newly reliable extracted text. */
export function addDetectedSymbolRecordIds(
  text: string,
  result: Set<PdfSymbolRecordId>,
): boolean {
  let changed = false;
  for (const character of text) {
    const recordId = GLYPH_INDEX.get(character);
    if (recordId !== undefined && !result.has(recordId)) {
      result.add(recordId);
      changed = true;
    }
  }
  return changed;
}

export function detectedSymbolSuggestions(
  detectedRecordIds: ReadonlySet<PdfSymbolRecordId>,
): PdfSymbolSuggestion[] {
  return sortedDetectedRecords(detectedRecordIds);
}

export function resolveDetectedSymbolQueries(
  query: string,
  detectedRecordIds: ReadonlySet<PdfSymbolRecordId>,
): PdfSymbolSuggestion[] {
  const expandedRecordIds = new Set<PdfSymbolRecordId>();
  for (const recordId of aliasCandidateIds(query)) {
    const record = RECORDS[recordId];
    if (!record) continue;
    if (record.semanticFamilyCodePoints.length === 0) {
      expandedRecordIds.add(recordId);
      continue;
    }
    for (const codePoint of record.semanticFamilyCodePoints) {
      const familyRecordId = CODE_POINT_INDEX.get(codePoint);
      if (familyRecordId !== undefined) expandedRecordIds.add(familyRecordId);
    }
  }
  return [...expandedRecordIds]
    .sort((left, right) => left - right)
    .filter((recordId) => detectedRecordIds.has(recordId))
    .flatMap((recordId) => {
      const record = RECORDS[recordId];
      return record ? [record] : [];
    });
}

export function isSymbolAliasQuery(query: string): boolean {
  return aliasCandidateIds(query).length > 0;
}
