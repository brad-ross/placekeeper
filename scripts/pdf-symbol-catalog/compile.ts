import { createHash } from 'node:crypto';

import { XMLParser } from 'fast-xml-parser';

export const SOURCE_KEYS = [
  'derivedName',
  'derivedGeneralCategory',
  'derivedCoreProperties',
  'unicodeData',
  'w3cUnicode',
] as const;

export type SourceKey = (typeof SOURCE_KEYS)[number];

export interface ManifestSource {
  readonly version: string;
  readonly sha256: string;
  readonly file?: string;
  readonly url?: string;
  readonly license?: string;
  readonly compressedSha256?: string;
}

export interface SourceManifest {
  readonly schemaVersion: 1;
  readonly unicodeVersion: string;
  readonly w3cCommit: string;
  readonly sources: Readonly<Record<SourceKey, ManifestSource>>;
}

export type AliasNamespace = 'command' | 'entity' | 'name';

export interface AuditedAliasGroup {
  readonly namespace: AliasNamespace;
  readonly alias: string;
  readonly codePoints: readonly string[];
  readonly action: 'allow' | 'prefer' | 'drop' | 'redirect';
  readonly expectedUpstreamCodePoints?: readonly string[];
  readonly canonicalCodePoint?: string;
  readonly rationale: string;
  readonly upstream: string;
}

export interface CatalogOverrides {
  readonly schemaVersion: 1;
  readonly aliasGroups: readonly AuditedAliasGroup[];
}

export interface CatalogCompilerInput {
  readonly manifest: SourceManifest;
  readonly sources: Readonly<Record<SourceKey, string>>;
  readonly overrides: CatalogOverrides;
}

export type AdmissionReason =
  | 'unicode-math'
  | 'w3c-mode'
  | 'w3c-math-class'
  | 'w3c-application'
  | 'w3c-direct-tex';

export type TexField = 'latex' | 'varlatex' | 'mathlatex' | 'override';

export interface CatalogCommand {
  readonly token: string;
  readonly field: TexField;
  readonly set: string | null;
}

export interface W3cEntity {
  readonly id: string;
  readonly set: string | null;
  readonly descriptions: readonly string[];
}

export interface W3cDescription {
  readonly text: string;
  readonly unicodeVersion: string | null;
}

export interface W3cProvenance {
  readonly id: string;
  readonly dec: string;
  readonly mode: string | null;
  readonly type: string | null;
  readonly category: string | null;
  readonly mathClass: string | null;
  readonly applicationMarkers: readonly string[];
  readonly entities: readonly W3cEntity[];
  readonly descriptions: readonly W3cDescription[];
}

export interface CatalogRecord {
  readonly codePoint: number;
  readonly glyph: string;
  readonly name: string;
  readonly category: string;
  readonly admission: readonly AdmissionReason[];
  readonly commands: readonly CatalogCommand[];
  readonly entities: readonly string[];
  readonly descriptions: readonly string[];
  readonly nameAliases: readonly string[];
  readonly provenance: {
    readonly unicode: {
      readonly version: string;
      readonly nameSource: 'DerivedName.txt';
      readonly categorySource: 'DerivedGeneralCategory.txt';
      readonly mathSource: 'DerivedCoreProperties.txt' | null;
    };
    readonly w3c: W3cProvenance | null;
    readonly overrides: readonly AuditedAliasGroup[];
  };
}

export interface CatalogCompileReport {
  readonly sourceHashes: Readonly<Record<SourceKey, string>>;
  readonly excludedMultiScalar: readonly {
    readonly id: string;
    readonly scalars: readonly number[];
    readonly decimalMismatch?: true;
  }[];
  readonly rejectedTex: readonly {
    readonly codePoint: number;
    readonly field: Exclude<TexField, 'override'>;
    readonly value: string;
    readonly reason: 'not-a-direct-control-token';
  }[];
  readonly excludedUnassignedW3c: readonly number[];
  readonly crossSourceDisagreements: readonly {
    readonly codePoint: number;
    readonly field: 'category';
    readonly unicode: string;
    readonly w3c: string;
  }[];
  readonly auditedAliasGroups: readonly AuditedAliasGroup[];
  readonly equivalenceEdges: readonly CatalogEquivalenceEdge[];
  readonly recordCount: number;
  readonly admissionCounts: Readonly<Record<AdmissionReason, number>>;
}

export interface CatalogEquivalenceEdge {
  readonly sourceCodePoint: number;
  readonly targetCodePoint: number;
  readonly kind: 'canonical' | 'compatibility' | 'font';
}

export interface CatalogEquivalenceFamily {
  readonly rootCodePoint: number;
  readonly queryCodePoints: readonly number[];
  readonly memberCodePoints: readonly number[];
}

export interface CompiledSymbolCatalog {
  readonly records: readonly CatalogRecord[];
  readonly equivalenceFamilies: readonly CatalogEquivalenceFamily[];
  readonly report: CatalogCompileReport;
}

export class CatalogCompileError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'CatalogCompileError';
  }
}

interface ScalarRange<T> {
  readonly start: number;
  readonly end: number;
  readonly value: T;
}

interface ParsedW3cRecord {
  readonly codePoint: number;
  readonly provenance: W3cProvenance;
  readonly commands: readonly CatalogCommand[];
  readonly rejectedTex: CatalogCompileReport['rejectedTex'];
  readonly admission: readonly Exclude<AdmissionReason, 'unicode-math'>[];
}

interface ParsedW3c {
  readonly records: ReadonlyMap<number, ParsedW3cRecord>;
  readonly excludedMultiScalar: CatalogCompileReport['excludedMultiScalar'];
  readonly rejectedTex: CatalogCompileReport['rejectedTex'];
}

const ADMISSION_ORDER: readonly AdmissionReason[] = [
  'unicode-math',
  'w3c-mode',
  'w3c-math-class',
  'w3c-application',
  'w3c-direct-tex',
];

const APPLICATION_MARKERS = new Set([
  'ACS',
  'AIP',
  'AMS',
  'APS',
  'IEEE',
  'Springer',
  'operator-dictionary',
]);

const MATHEMATICAL_CLASSES = new Set([
  'B', 'C', 'D', 'F', 'G', 'L', 'O', 'P', 'R', 'U', 'V', 'X',
]);

const XML_ARRAY_PATHS = new Set([
  'unicode.characters.character',
  'unicode.characters.character.entity',
  'unicode.characters.character.entity.desc',
  'unicode.characters.character.description',
  'unicode.characters.character.latex',
  'unicode.characters.character.varlatex',
  'unicode.characters.character.mathlatex',
  'unicode.charlist.character',
  'unicode.charlist.character.entity',
  'unicode.charlist.character.entity.desc',
  'unicode.charlist.character.description',
  'unicode.charlist.character.latex',
  'unicode.charlist.character.varlatex',
  'unicode.charlist.character.mathlatex',
]);

const formatCodePoint = (codePoint: number): string =>
  `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;

const byteCompare = (left: string, right: string): number =>
  Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));

const uniqueSorted = (values: Iterable<string>): string[] =>
  [...new Set(values)].sort(byteCompare);

const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asArray = (value: unknown): readonly unknown[] => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
};

const requiredString = (value: unknown, context: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CatalogCompileError(`${context} must be a non-empty string`);
  }
  return value;
};

const optionalString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

const xmlText = (value: unknown, context: string): string => {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  if (isRecord(value)) {
    const text = value['#text'];
    if (typeof text === 'string' || typeof text === 'number') return String(text).trim();
    if (text === undefined) return '';
  }
  throw new CatalogCompileError(`${context} has an unsupported XML text shape`);
};

const assertScalar = (codePoint: number, context: string): void => {
  if (!Number.isInteger(codePoint)
    || codePoint < 0
    || codePoint > 0x10ffff
    || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
    const rendered = Number.isInteger(codePoint)
      ? codePoint.toString(16).toUpperCase()
      : String(codePoint);
    throw new CatalogCompileError(`invalid Unicode scalar ${rendered} in ${context}`);
  }
};

const parseHexCodePoint = (value: string, context: string): number => {
  if (!/^[0-9A-F]{4,6}$/u.test(value)) {
    throw new CatalogCompileError(`invalid Unicode scalar ${value} in ${context}`);
  }
  const codePoint = Number.parseInt(value, 16);
  if (codePoint > 0x10ffff) {
    throw new CatalogCompileError(`invalid Unicode scalar ${value} in ${context}`);
  }
  return codePoint;
};

const parseHexScalar = (value: string, context: string): number => {
  const codePoint = parseHexCodePoint(value, context);
  assertScalar(codePoint, context);
  return codePoint;
};

const parseRange = (
  value: string,
  context: string,
  allowSurrogates = false,
): readonly [number, number] => {
  const parts = value.trim().split('..');
  if (parts.length < 1 || parts.length > 2 || parts.some((part) => part === undefined)) {
    throw new CatalogCompileError(`invalid Unicode range ${value} in ${context}`);
  }
  const parser = allowSurrogates ? parseHexCodePoint : parseHexScalar;
  const start = parser(parts[0] ?? '', context);
  const end = parser(parts[1] ?? parts[0] ?? '', context);
  if (end < start) throw new CatalogCompileError(`descending Unicode range ${value} in ${context}`);
  return [start, end];
};

const dataLines = (source: string): readonly { readonly line: number; readonly value: string }[] =>
  source.split(/\r?\n/u).flatMap((raw, index) => {
    const value = raw.replace(/#.*/u, '').trim();
    return value.length === 0 ? [] : [{ line: index + 1, value }];
  });

const assertNonOverlapping = <T>(ranges: readonly ScalarRange<T>[], source: string): void => {
  const sorted = [...ranges].sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (previous && current && current.start <= previous.end) {
      const duplicate = Math.max(current.start, previous.start);
      throw new CatalogCompileError(`duplicate ${source} record for ${formatCodePoint(duplicate)}`);
    }
  }
};

const parseNameRanges = (source: string): readonly ScalarRange<string>[] => {
  const ranges = dataLines(source).map(({ line, value }) => {
    const fields = value.split(';').map((field) => field.trim());
    if (fields.length !== 2 || !fields[0] || !fields[1]) {
      throw new CatalogCompileError(`malformed DerivedName record at line ${line}`);
    }
    const [start, end] = parseRange(fields[0], `DerivedName line ${line}`);
    return { start, end, value: fields[1] };
  });
  assertNonOverlapping(ranges, 'DerivedName');
  return ranges.sort((left, right) => left.start - right.start);
};

const parseCategoryRanges = (source: string): readonly ScalarRange<string>[] => {
  const ranges = dataLines(source).map(({ line, value }) => {
    const fields = value.split(';').map((field) => field.trim());
    if (fields.length !== 2 || !fields[0] || !fields[1] || !/^[A-Z][a-z]$/u.test(fields[1])) {
      throw new CatalogCompileError(`malformed DerivedGeneralCategory record at line ${line}`);
    }
    const [start, end] = parseRange(
      fields[0],
      `DerivedGeneralCategory line ${line}`,
      true,
    );
    return { start, end, value: fields[1] };
  });
  assertNonOverlapping(ranges, 'DerivedGeneralCategory');
  return ranges.sort((left, right) => left.start - right.start);
};

const parseMathScalars = (source: string): ReadonlySet<number> => {
  const math = new Set<number>();
  for (const { line, value } of dataLines(source)) {
    const fields = value.split(';').map((field) => field.trim());
    if (fields.length < 2 || !fields[0] || !fields[1]) {
      throw new CatalogCompileError(`malformed DerivedCoreProperties record at line ${line}`);
    }
    if (fields[1] !== 'Math') continue;
    if (fields.length !== 2) {
      throw new CatalogCompileError(`malformed Math property record at line ${line}`);
    }
    const [start, end] = parseRange(fields[0], `DerivedCoreProperties line ${line}`);
    for (let codePoint = start; codePoint <= end; codePoint += 1) {
      if (math.has(codePoint)) {
        throw new CatalogCompileError(
          `duplicate DerivedCoreProperties Math record for ${formatCodePoint(codePoint)}`,
        );
      }
      math.add(codePoint);
    }
  }
  return math;
};

interface UnicodeDecomposition {
  readonly sourceCodePoint: number;
  readonly targetCodePoint: number;
  readonly tag: string | null;
}

const EXPECTED_COMPATIBILITY_MAPPINGS = new Map<number, number>([
  [0x00b5, 0x03bc],
  [0x03d0, 0x03b2],
  [0x03d1, 0x03b8],
  [0x03d2, 0x03a5],
  [0x03d5, 0x03c6],
  [0x03d6, 0x03c0],
  [0x03f0, 0x03ba],
  [0x03f1, 0x03c1],
  [0x03f4, 0x0398],
  [0x03f5, 0x03b5],
]);

const GREEK_EQUIVALENCE_TARGETS = new Set<number>([
  ...Array.from({ length: 0x03a1 - 0x0391 + 1 }, (_, index) => 0x0391 + index),
  ...Array.from({ length: 0x03a9 - 0x03a3 + 1 }, (_, index) => 0x03a3 + index),
  ...Array.from({ length: 0x03c9 - 0x03b1 + 1 }, (_, index) => 0x03b1 + index),
  ...EXPECTED_COMPATIBILITY_MAPPINGS.keys(),
]);

const UNICODE_DECOMPOSITION_TAGS = new Set([
  'font', 'noBreak', 'initial', 'medial', 'final', 'isolated', 'circle', 'super', 'sub',
  'vertical', 'wide', 'narrow', 'small', 'square', 'fraction', 'compat',
]);

const parseUnicodeData = (source: string): readonly UnicodeDecomposition[] => {
  const decompositions: UnicodeDecomposition[] = [];
  const seen = new Set<number>();
  const lines = source.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const value = lines[index];
    if (value === undefined || value.length === 0) continue;
    const fields = value.split(';');
    if (fields.length !== 15) {
      throw new CatalogCompileError(
        `UnicodeData line ${index + 1} must contain exactly 15 fields, received ${fields.length}`,
      );
    }
    const codePointText = fields[0] ?? '';
    if (!/^[0-9A-F]{4,6}$/u.test(codePointText)) {
      throw new CatalogCompileError(`UnicodeData line ${index + 1} has malformed code point ${codePointText}`);
    }
    const codePoint = parseHexCodePoint(codePointText, `UnicodeData line ${index + 1}`);
    if (seen.has(codePoint)) {
      throw new CatalogCompileError(`duplicate UnicodeData record for ${formatCodePoint(codePoint)}`);
    }
    seen.add(codePoint);
    if ((fields[1] ?? '').length === 0) {
      throw new CatalogCompileError(`UnicodeData line ${index + 1} has an empty character name`);
    }

    const decomposition = fields[5] ?? '';
    if (decomposition.length === 0) continue;
    assertScalar(codePoint, `UnicodeData line ${index + 1} decomposition source`);
    const parts = decomposition.split(' ');
    if (parts.some((part) => part.length === 0)) {
      throw new CatalogCompileError(`UnicodeData line ${index + 1} has malformed decomposition spacing`);
    }
    let tag: string | null = null;
    let scalarParts = parts;
    const first = parts[0] ?? '';
    if (first.startsWith('<')) {
      if (!/^<[A-Za-z]+>$/u.test(first)
        || !UNICODE_DECOMPOSITION_TAGS.has(first.slice(1, -1))) {
        throw new CatalogCompileError(`UnicodeData line ${index + 1} has malformed decomposition tag ${first}`);
      }
      tag = first.slice(1, -1);
      scalarParts = parts.slice(1);
    }
    if (scalarParts.length === 0) {
      throw new CatalogCompileError(`UnicodeData line ${index + 1} has an empty decomposition mapping`);
    }
    const scalars = scalarParts.map((part) => {
      if (!/^[0-9A-F]{4,6}$/u.test(part)) {
        throw new CatalogCompileError(`UnicodeData line ${index + 1} has malformed decomposition scalar ${part}`);
      }
      return parseHexScalar(part, `UnicodeData line ${index + 1} decomposition`);
    });
    if (scalars.length !== 1) continue;
    const targetCodePoint = scalars[0];
    if (targetCodePoint === undefined) continue;
    const expectedCompatibilityTarget = EXPECTED_COMPATIBILITY_MAPPINGS.get(codePoint);
    if (expectedCompatibilityTarget !== undefined
      && (tag !== 'compat' || targetCodePoint !== expectedCompatibilityTarget)) {
      throw new CatalogCompileError(
        `unexpected compatibility mapping for ${formatCodePoint(codePoint)}: expected ${formatCodePoint(expectedCompatibilityTarget)}, received ${formatCodePoint(targetCodePoint)}`,
      );
    }
    decompositions.push({ sourceCodePoint: codePoint, targetCodePoint, tag });
  }
  return decompositions;
};

const compileEquivalenceFamilies = (
  decompositions: readonly UnicodeDecomposition[],
  admitted: ReadonlySet<number>,
): {
  readonly edges: readonly CatalogEquivalenceEdge[];
  readonly families: readonly CatalogEquivalenceFamily[];
} => {
  const edges: CatalogEquivalenceEdge[] = [];
  for (const decomposition of decompositions) {
    const { sourceCodePoint, targetCodePoint, tag } = decomposition;
    if (!admitted.has(sourceCodePoint) || !admitted.has(targetCodePoint)) continue;
    let kind: CatalogEquivalenceEdge['kind'] | null = null;
    if (tag === null) kind = 'canonical';
    else if (tag === 'compat'
      && EXPECTED_COMPATIBILITY_MAPPINGS.get(sourceCodePoint) === targetCodePoint) {
      kind = 'compatibility';
    } else if (tag === 'font'
      && sourceCodePoint >= 0x1d400
      && sourceCodePoint <= 0x1d7ff
      && GREEK_EQUIVALENCE_TARGETS.has(targetCodePoint)) {
      kind = 'font';
    }
    if (kind === null) continue;
    if (sourceCodePoint === targetCodePoint) {
      throw new CatalogCompileError(
        `unexpected self-referential UnicodeData mapping for ${formatCodePoint(sourceCodePoint)}`,
      );
    }
    edges.push({ sourceCodePoint, targetCodePoint, kind });
  }
  edges.sort((left, right) => left.sourceCodePoint - right.sourceCodePoint
    || left.targetCodePoint - right.targetCodePoint
    || byteCompare(left.kind, right.kind));
  const edgeKeys = new Set<string>();
  for (const edge of edges) {
    const key = `${edge.sourceCodePoint}\0${edge.targetCodePoint}\0${edge.kind}`;
    if (edgeKeys.has(key)) {
      throw new CatalogCompileError(
        `duplicate UnicodeData equivalence edge for ${formatCodePoint(edge.sourceCodePoint)}`,
      );
    }
    edgeKeys.add(key);
  }

  const parent = new Map<number, number>();
  const find = (value: number): number => {
    const current = parent.get(value) ?? value;
    if (current === value) {
      parent.set(value, value);
      return value;
    }
    const root = find(current);
    parent.set(value, root);
    return root;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    parent.set(Math.max(leftRoot, rightRoot), Math.min(leftRoot, rightRoot));
  };
  const queryMembers = new Set<number>();
  for (const edge of edges) {
    union(edge.sourceCodePoint, edge.targetCodePoint);
    queryMembers.add(edge.targetCodePoint);
    if (edge.kind !== 'font') queryMembers.add(edge.sourceCodePoint);
  }
  const membersByRoot = new Map<number, number[]>();
  for (const codePoint of parent.keys()) {
    const root = find(codePoint);
    const members = membersByRoot.get(root) ?? [];
    members.push(codePoint);
    membersByRoot.set(root, members);
  }
  const families = [...membersByRoot.values()].map((members): CatalogEquivalenceFamily => {
    const memberCodePoints = [...members].sort((left, right) => left - right);
    const sourceCodePoints = new Set(edges.flatMap((edge) => (
      memberCodePoints.includes(edge.sourceCodePoint)
        && memberCodePoints.includes(edge.targetCodePoint)
        ? [edge.sourceCodePoint]
        : []
    )));
    const semanticRoots = memberCodePoints.filter((codePoint) => !sourceCodePoints.has(codePoint));
    return {
      rootCodePoint: semanticRoots[0] ?? memberCodePoints[0] ?? 0,
      queryCodePoints: memberCodePoints.filter((codePoint) => queryMembers.has(codePoint)),
      memberCodePoints,
    };
  }).filter(({ memberCodePoints }) => memberCodePoints.length > 1)
    .sort((left, right) => left.rootCodePoint - right.rootCodePoint);
  return { edges, families };
};

const findRange = <T>(ranges: readonly ScalarRange<T>[], codePoint: number): ScalarRange<T> | null => {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const range = ranges[middle];
    if (!range) return null;
    if (codePoint < range.start) high = middle - 1;
    else if (codePoint > range.end) low = middle + 1;
    else return range;
  }
  return null;
};

const officialNameFor = (ranges: readonly ScalarRange<string>[], codePoint: number): string | null => {
  const range = findRange(ranges, codePoint);
  if (!range) return null;
  return range.value.replaceAll(
    '*',
    codePoint.toString(16).toUpperCase().padStart(4, '0'),
  );
};

const directTexToken = (value: string): boolean =>
  /^\\(?:[A-Za-z]+|[^\p{L}\p{N}\s])$/u.test(value);

const parseW3cId = (id: string): readonly number[] => {
  if (!/^U[0-9A-F]{5,6}(?:-[0-9A-F]{5,6})*$/u.test(id)) {
    throw new CatalogCompileError(`malformed W3C character ID ${id}`);
  }
  return id.slice(1).split('-').map((part) => parseHexScalar(part, `W3C character ${id}`));
};

const parseW3c = (source: string, expectedUnicodeMajor: string): ParsedW3c => {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/iu.test(source)) {
    throw new CatalogCompileError('DTD and entity declarations are forbidden in W3C XML');
  }

  let parsed: unknown;
  try {
    parsed = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '',
      parseAttributeValue: false,
      trimValues: false,
      processEntities: false,
      isArray: (_tagName, jPath) => XML_ARRAY_PATHS.has(
        typeof jPath === 'string' ? jPath : jPath.toString(),
      ),
    }).parse(source, true);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CatalogCompileError(`invalid W3C XML: ${detail}`);
  }

  if (!isRecord(parsed) || !isRecord(parsed.unicode)) {
    throw new CatalogCompileError('W3C XML schema mismatch: missing unicode root');
  }
  const root = parsed.unicode;
  if (String(root.unicode) !== expectedUnicodeMajor) {
    throw new CatalogCompileError(
      `Unicode version mismatch: W3C XML declares ${String(root.unicode)}, expected ${expectedUnicodeMajor}`,
    );
  }
  const collection = isRecord(root.charlist)
    ? root.charlist
    : isRecord(root.characters)
      ? root.characters
      : null;
  if (!collection) throw new CatalogCompileError('W3C XML schema mismatch: missing charlist');

  const characters = asArray(collection.character);
  if (characters.length === 0) {
    throw new CatalogCompileError('W3C XML schema mismatch: charlist has no character records');
  }
  const records = new Map<number, ParsedW3cRecord>();
  const excludedMultiScalar: {
    id: string;
    scalars: readonly number[];
    decimalMismatch?: true;
  }[] = [];
  const allRejectedTex: CatalogCompileReport['rejectedTex'][number][] = [];

  for (const [index, rawCharacter] of characters.entries()) {
    if (!isRecord(rawCharacter)) {
      throw new CatalogCompileError(`W3C XML schema mismatch: character ${index + 1} is not an object`);
    }
    const id = requiredString(rawCharacter.id, `W3C character ${index + 1} id`);
    const scalars = parseW3cId(id);
    const dec = requiredString(rawCharacter.dec, `W3C character ${id} dec`);
    const decimalScalars = dec.split(/[-\s]+/u).map((part) => {
      if (!/^\d+$/u.test(part)) {
        throw new CatalogCompileError(`W3C decimal value ${dec} is malformed for ${id}`);
      }
      return Number.parseInt(part, 10);
    });
    const decimalMismatch = decimalScalars.length !== scalars.length
      || decimalScalars.some((value, scalarIndex) => value !== scalars[scalarIndex]);
    if (scalars.length > 1) {
      excludedMultiScalar.push({ id, scalars, ...(decimalMismatch ? { decimalMismatch: true } : {}) });
      continue;
    }
    if (decimalMismatch) {
      throw new CatalogCompileError(`W3C decimal value ${dec} does not match ${id}`);
    }
    const codePoint = scalars[0];
    if (codePoint === undefined) throw new CatalogCompileError(`W3C character ${id} has no scalar`);
    if (records.has(codePoint)) {
      throw new CatalogCompileError(`duplicate W3C record for ${formatCodePoint(codePoint)}`);
    }

    const unicodeData = isRecord(rawCharacter.unicodedata) ? rawCharacter.unicodedata : null;
    const w3cCategory = unicodeData ? optionalString(unicodeData.category) : null;
    const mathClass = unicodeData ? optionalString(unicodeData.mathclass) : null;
    const mode = optionalString(rawCharacter.mode);
    const type = optionalString(rawCharacter.type);
    const applicationMarkers = Object.keys(rawCharacter)
      .filter((key) => APPLICATION_MARKERS.has(key))
      .sort(byteCompare);

    const commands: CatalogCommand[] = [];
    const rejectedTex: CatalogCompileReport['rejectedTex'][number][] = [];
    for (const field of ['latex', 'varlatex', 'mathlatex'] as const) {
      for (const rawCommand of asArray(rawCharacter[field])) {
        const token = xmlText(rawCommand, `${id} ${field}`);
        if (!directTexToken(token)) {
          rejectedTex.push({
            codePoint,
            field,
            value: token,
            reason: 'not-a-direct-control-token',
          });
          continue;
        }
        const set = isRecord(rawCommand) ? optionalString(rawCommand.set) : null;
        commands.push({ token, field, set });
      }
    }

    const entities = asArray(rawCharacter.entity).flatMap((rawEntity, entityIndex): W3cEntity[] => {
      if (!isRecord(rawEntity)) {
        throw new CatalogCompileError(`W3C entity ${entityIndex + 1} for ${id} is not an object`);
      }
      const entityId = optionalString(rawEntity.id);
      if (entityId === null) return [];
      if (!/^[A-Za-z_:][A-Za-z0-9_.:-]*$/u.test(entityId)) {
        throw new CatalogCompileError(`malformed W3C entity ID ${entityId} for ${id}`);
      }
      return [{
        id: entityId,
        set: optionalString(rawEntity.set),
        descriptions: uniqueSorted(
          asArray(rawEntity.desc)
            .map((description) => xmlText(description, `${id} entity description`))
            .filter((description) => description.length > 0),
        ),
      }];
    }).sort((left, right) => byteCompare(left.id, right.id)
      || byteCompare(left.set ?? '', right.set ?? ''));

    const descriptions = asArray(rawCharacter.description)
      .map((rawDescription): W3cDescription => ({
        text: xmlText(rawDescription, `${id} description`),
        unicodeVersion: isRecord(rawDescription) ? optionalString(rawDescription.unicode) : null,
      }))
      .filter(({ text }) => text.length > 0)
      .sort((left, right) => byteCompare(left.text, right.text)
        || byteCompare(left.unicodeVersion ?? '', right.unicodeVersion ?? ''));

    const admission = new Set<Exclude<AdmissionReason, 'unicode-math'>>();
    if (MATHEMATICAL_CLASSES.has(mathClass ?? '')) admission.add('w3c-math-class');
    if (applicationMarkers.length > 0) admission.add('w3c-application');
    if (commands.length > 0) admission.add('w3c-direct-tex');
    // W3C uses `mixed` for many ordinary prose letters. It corroborates an
    // independent mathematical signal but cannot admit a scalar by itself.
    if (mode === 'math' || (mode === 'mixed' && admission.size > 0)) {
      admission.add('w3c-mode');
    }

    records.set(codePoint, {
      codePoint,
      provenance: {
        id,
        dec,
        mode,
        type,
        category: w3cCategory,
        mathClass,
        applicationMarkers,
        entities,
        descriptions,
      },
      commands: [...commands].sort((left, right) => byteCompare(left.token, right.token)
        || byteCompare(left.field, right.field)
        || byteCompare(left.set ?? '', right.set ?? '')),
      rejectedTex,
      admission: ADMISSION_ORDER.filter(
        (reason): reason is Exclude<AdmissionReason, 'unicode-math'> =>
          reason !== 'unicode-math' && admission.has(reason),
      ),
    });
    allRejectedTex.push(...rejectedTex);
  }

  excludedMultiScalar.sort((left, right) => byteCompare(left.id, right.id));
  allRejectedTex.sort((left, right) => left.codePoint - right.codePoint
    || byteCompare(left.field, right.field)
    || byteCompare(left.value, right.value));
  return { records, excludedMultiScalar, rejectedTex: allRejectedTex };
};

const normalizedName = (value: string): string => value.normalize('NFC').toLowerCase();

const parseOverrideCodePoint = (value: string): number => {
  if (!/^[0-9A-F]{4,6}$/u.test(value)) {
    throw new CatalogCompileError(`override code point ${value} must be uppercase hexadecimal`);
  }
  return parseHexScalar(value, 'catalog overrides');
};

const validateManifest = (input: CatalogCompilerInput): Readonly<Record<SourceKey, string>> => {
  if (input.manifest.schemaVersion !== 1) {
    throw new CatalogCompileError(`unsupported source manifest schema ${String(input.manifest.schemaVersion)}`);
  }
  if (!/^\d+\.\d+\.\d+$/u.test(input.manifest.unicodeVersion)) {
    throw new CatalogCompileError(`invalid Unicode version ${input.manifest.unicodeVersion}`);
  }
  if (!/^[0-9a-f]{40}$/u.test(input.manifest.w3cCommit)) {
    throw new CatalogCompileError(`invalid W3C commit ${input.manifest.w3cCommit}`);
  }

  const hashes = {} as Record<SourceKey, string>;
  for (const key of SOURCE_KEYS) {
    const entry = input.manifest.sources[key];
    const content = input.sources[key];
    if (!entry || typeof content !== 'string') {
      throw new CatalogCompileError(`source manifest schema mismatch: missing ${key}`);
    }
    if (entry.version !== (key === 'w3cUnicode'
      ? input.manifest.w3cCommit
      : input.manifest.unicodeVersion)) {
      throw new CatalogCompileError(`${key} manifest version mismatch`);
    }
    if (!/^[0-9a-f]{64}$/u.test(entry.sha256)) {
      throw new CatalogCompileError(`${key} manifest SHA-256 is malformed`);
    }
    const actual = sha256(content);
    if (actual !== entry.sha256) {
      throw new CatalogCompileError(
        `${key} checksum mismatch: expected ${entry.sha256}, received ${actual}`,
      );
    }
    hashes[key] = actual;
  }

  for (const key of ['derivedName', 'derivedGeneralCategory', 'derivedCoreProperties'] as const) {
    const expectedHeader = key === 'derivedName'
      ? `# DerivedName-${input.manifest.unicodeVersion}.txt`
      : key === 'derivedGeneralCategory'
        ? `# DerivedGeneralCategory-${input.manifest.unicodeVersion}.txt`
        : `# DerivedCoreProperties-${input.manifest.unicodeVersion}.txt`;
    if (!input.sources[key].includes(expectedHeader)) {
      throw new CatalogCompileError(
        `Unicode version mismatch in ${key}: expected ${input.manifest.unicodeVersion}`,
      );
    }
  }
  return hashes;
};

const validateOverrides = (
  overrides: CatalogOverrides,
  records: ReadonlyMap<number, CatalogRecord>,
): readonly {
  readonly group: AuditedAliasGroup;
  readonly codePoints: readonly number[];
  readonly action: 'allow' | 'prefer' | 'drop' | 'redirect';
  readonly canonicalCodePoint: number | null;
  readonly expectedUpstreamCodePoints: readonly number[] | null;
}[] => {
  if (overrides.schemaVersion !== 1) {
    throw new CatalogCompileError(`unsupported overrides schema ${String(overrides.schemaVersion)}`);
  }
  if (!Array.isArray(overrides.aliasGroups)) {
    throw new CatalogCompileError('overrides schema mismatch: aliasGroups must be an array');
  }
  const parsed: {
    group: AuditedAliasGroup;
    codePoints: readonly number[];
    action: 'allow' | 'prefer' | 'drop' | 'redirect';
    canonicalCodePoint: number | null;
    expectedUpstreamCodePoints: readonly number[] | null;
  }[] = [];
  const keys = new Set<string>();
  for (const group of overrides.aliasGroups) {
    if (!['command', 'entity', 'name'].includes(group.namespace)) {
      if (group.namespace === ('literal' as AliasNamespace)) {
        throw new CatalogCompileError('literal aliases are forbidden because they can redirect scalars');
      }
      throw new CatalogCompileError(`unsupported alias namespace ${String(group.namespace)}`);
    }
    if (group.alias.trim() !== group.alias || group.alias.length === 0) {
      throw new CatalogCompileError('override aliases must be non-empty and already trimmed');
    }
    if (group.rationale.trim().length === 0 || group.upstream.trim().length === 0) {
      throw new CatalogCompileError(`override ${group.alias} requires rationale and upstream documentation`);
    }
    if (group.namespace === 'command' && !directTexToken(group.alias)) {
      throw new CatalogCompileError(`override command ${group.alias} is not a direct TeX token`);
    }
    if (group.namespace === 'entity' && !/^[A-Za-z_:][A-Za-z0-9_.:-]*$/u.test(group.alias)) {
      throw new CatalogCompileError(`override entity ${group.alias} is malformed`);
    }
    if (group.namespace === 'name') {
      if (Array.from(group.alias).length === 1 && (group.alias.codePointAt(0) ?? 128) < 128) {
        throw new CatalogCompileError(`ASCII literal aliases are forbidden: ${group.alias}`);
      }
    }
    if (!Array.isArray(group.codePoints)) {
      throw new CatalogCompileError(`override ${group.alias} codePoints must be an array`);
    }
    const uniqueCodePoints = uniqueSorted(group.codePoints);
    if (uniqueCodePoints.length !== group.codePoints.length) {
      throw new CatalogCompileError(`override ${group.alias} contains a duplicate code point`);
    }
    const codePoints = uniqueCodePoints.map(parseOverrideCodePoint);
    if (codePoints.length < 1) {
      throw new CatalogCompileError(`audited alias group ${group.alias} must name at least one scalar`);
    }
    for (const codePoint of codePoints) {
      if (!records.has(codePoint)) {
        throw new CatalogCompileError(`stale override ${group.alias}: ${formatCodePoint(codePoint)} is not admitted`);
      }
    }
    const action = group.action;
    if (!['allow', 'prefer', 'drop', 'redirect'].includes(action)) {
      throw new CatalogCompileError(`override ${group.alias} has unsupported action ${String(action)}`);
    }
    const canonicalCodePoint = group.canonicalCodePoint === undefined
      ? null
      : parseOverrideCodePoint(group.canonicalCodePoint);
    if (action === 'prefer' || action === 'redirect') {
      if (canonicalCodePoint === null || !codePoints.includes(canonicalCodePoint)) {
        throw new CatalogCompileError(
          `${action} override ${group.alias} requires a canonicalCodePoint from its codePoints`,
        );
      }
    } else if (canonicalCodePoint !== null) {
      throw new CatalogCompileError(
        `override ${group.alias} may specify canonicalCodePoint only for action prefer`,
      );
    }
    let expectedUpstreamCodePoints: readonly number[] | null = null;
    if (action === 'allow' || action === 'redirect') {
      if (!Array.isArray(group.expectedUpstreamCodePoints)) {
        throw new CatalogCompileError(
          `${action} override ${group.alias} requires expectedUpstreamCodePoints`,
        );
      }
      const uniqueExpected = uniqueSorted(group.expectedUpstreamCodePoints);
      if (uniqueExpected.length !== group.expectedUpstreamCodePoints.length) {
        throw new CatalogCompileError(
          `${action} override ${group.alias} contains a duplicate expected upstream code point`,
        );
      }
      expectedUpstreamCodePoints = uniqueExpected.map(parseOverrideCodePoint)
        .sort((left, right) => left - right);
      if (expectedUpstreamCodePoints.some((codePoint) => !codePoints.includes(codePoint))) {
        throw new CatalogCompileError(
          `${action} override ${group.alias} expectedUpstreamCodePoints must be a subset of codePoints`,
        );
      }
    } else if (group.expectedUpstreamCodePoints !== undefined) {
      throw new CatalogCompileError(
        `override ${group.alias} may specify expectedUpstreamCodePoints only for action allow`,
      );
    }
    if (action === 'redirect') {
      if (group.namespace !== 'command') {
        throw new CatalogCompileError(`redirect override ${group.alias} is supported only for commands`);
      }
      if (expectedUpstreamCodePoints?.length === 0
        || (canonicalCodePoint !== null && expectedUpstreamCodePoints?.includes(canonicalCodePoint))) {
        throw new CatalogCompileError(
          `redirect override ${group.alias} requires non-target expectedUpstreamCodePoints`,
        );
      }
    }
    const aliasKey = group.namespace === 'name' ? normalizedName(group.alias) : group.alias;
    const key = `${group.namespace}\0${aliasKey}`;
    if (keys.has(key)) throw new CatalogCompileError(`duplicate audited alias group ${group.alias}`);
    keys.add(key);
    parsed.push({
      group,
      codePoints: [...codePoints].sort((left, right) => left - right),
      action,
      canonicalCodePoint,
      expectedUpstreamCodePoints,
    });
  }
  return parsed.sort((left, right) => byteCompare(left.group.namespace, right.group.namespace)
    || byteCompare(left.group.alias, right.group.alias));
};

const validateAliasCollisions = (
  records: readonly CatalogRecord[],
  audited: readonly {
    readonly group: AuditedAliasGroup;
    readonly codePoints: readonly number[];
    readonly action: 'allow' | 'prefer' | 'drop' | 'redirect';
  }[],
): void => {
  const allowed = new Map<string, readonly number[]>();
  for (const { group, codePoints, action } of audited) {
    if (action !== 'allow') continue;
    const alias = group.namespace === 'name' ? normalizedName(group.alias) : group.alias;
    allowed.set(`${group.namespace}\0${alias}`, codePoints);
  }

  const indexes = new Map<string, Set<number>>();
  const add = (namespace: AliasNamespace, alias: string, codePoint: number): void => {
    const normalized = namespace === 'name' ? normalizedName(alias) : alias;
    const key = `${namespace}\0${normalized}`;
    const values = indexes.get(key) ?? new Set<number>();
    values.add(codePoint);
    indexes.set(key, values);
  };
  for (const record of records) {
    add('name', record.name, record.codePoint);
    for (const alias of record.nameAliases) add('name', alias, record.codePoint);
    for (const command of record.commands) add('command', command.token, record.codePoint);
    for (const entity of record.entities) add('entity', entity, record.codePoint);
  }

  const undocumented: string[] = [];
  for (const [key, values] of [...indexes].sort(([left], [right]) => byteCompare(left, right))) {
    if (values.size < 2) continue;
    const [namespace = '', alias = ''] = key.split('\0');
    const actual = [...values].sort((left, right) => left - right);
    const expected = allowed.get(key);
    if (!expected || expected.length !== actual.length
      || expected.some((value, index) => value !== actual[index])) {
      const codePoints = actual.map(formatCodePoint).join(', ');
      undocumented.push(`${namespace} alias collision for ${alias}: ${codePoints}`);
    }
  }
  if (undocumented.length > 0) {
    throw new CatalogCompileError(`undocumented ${undocumented.join('; ')}`);
  }
};

export const compileSymbolCatalog = (input: CatalogCompilerInput): CompiledSymbolCatalog => {
  const sourceHashes = validateManifest(input);
  const nameRanges = parseNameRanges(input.sources.derivedName);
  const categoryRanges = parseCategoryRanges(input.sources.derivedGeneralCategory);
  const mathScalars = parseMathScalars(input.sources.derivedCoreProperties);
  const unicodeDecompositions = parseUnicodeData(input.sources.unicodeData);
  const w3c = parseW3c(
    input.sources.w3cUnicode,
    input.manifest.unicodeVersion.split('.')[0] ?? input.manifest.unicodeVersion,
  );

  const candidates = new Set<number>(mathScalars);
  for (const [codePoint, record] of w3c.records) {
    if (record.admission.length > 0) candidates.add(codePoint);
  }

  const excludedUnassignedW3c: number[] = [];
  const crossSourceDisagreements: CatalogCompileReport['crossSourceDisagreements'][number][] = [];
  const recordsByCodePoint = new Map<number, CatalogRecord>();
  for (const codePoint of [...candidates].sort((left, right) => left - right)) {
    assertScalar(codePoint, 'catalog candidate');
    const name = officialNameFor(nameRanges, codePoint);
    const category = findRange(categoryRanges, codePoint)?.value ?? null;
    if (name === null || category === null || ['Cn', 'Co', 'Cs'].includes(category)) {
      if (w3c.records.has(codePoint)) excludedUnassignedW3c.push(codePoint);
      if (mathScalars.has(codePoint)) {
        throw new CatalogCompileError(
          `Unicode Math scalar ${formatCodePoint(codePoint)} is not an assigned named scalar`,
        );
      }
      continue;
    }
    if (!mathScalars.has(codePoint) && category.startsWith('Z')) continue;
    const w3cRecord = w3c.records.get(codePoint) ?? null;
    const w3cCategory = w3cRecord?.provenance.category ?? null;
    if (w3cCategory !== null && w3cCategory !== category) {
      crossSourceDisagreements.push({
        codePoint,
        field: 'category',
        unicode: category,
        w3c: w3cCategory,
      });
    }
    const admission = ADMISSION_ORDER.filter((reason) =>
      reason === 'unicode-math' ? mathScalars.has(codePoint) : w3cRecord?.admission.includes(reason));
    const entities = uniqueSorted(w3cRecord?.provenance.entities.map(({ id }) => id) ?? []);
    const descriptions = uniqueSorted([
      ...(w3cRecord?.provenance.descriptions.map(({ text }) => text) ?? []),
      ...(w3cRecord?.provenance.entities.flatMap(({ descriptions: values }) => values) ?? []),
    ]);
    recordsByCodePoint.set(codePoint, {
      codePoint,
      glyph: String.fromCodePoint(codePoint),
      name,
      category,
      admission,
      commands: w3cRecord?.commands ?? [],
      entities,
      descriptions,
      nameAliases: [],
      provenance: {
        unicode: {
          version: input.manifest.unicodeVersion,
          nameSource: 'DerivedName.txt',
          categorySource: 'DerivedGeneralCategory.txt',
          mathSource: mathScalars.has(codePoint) ? 'DerivedCoreProperties.txt' : null,
        },
        w3c: w3cRecord?.provenance ?? null,
        overrides: [],
      },
    });
  }

  const equivalence = compileEquivalenceFamilies(
    unicodeDecompositions,
    new Set(recordsByCodePoint.keys()),
  );
  const audited = validateOverrides(input.overrides, recordsByCodePoint);
  for (const {
    group,
    codePoints,
    action,
    canonicalCodePoint,
    expectedUpstreamCodePoints,
  } of audited) {
    const baseMatches = codePoints.filter((codePoint) => {
      const record = recordsByCodePoint.get(codePoint);
      if (!record) return false;
      if (group.namespace === 'command') {
        return record.commands.some(({ token }) => token === group.alias);
      }
      if (group.namespace === 'entity') return record.entities.includes(group.alias);
      const normalizedAlias = normalizedName(group.alias);
      return normalizedName(record.name) === normalizedAlias
        || record.nameAliases.some((alias) => normalizedName(alias) === normalizedAlias);
    });
    if ((action === 'allow' || action === 'redirect') && (expectedUpstreamCodePoints === null
      || baseMatches.length !== expectedUpstreamCodePoints.length
      || baseMatches.some((value, index) => value !== expectedUpstreamCodePoints[index]))) {
      throw new CatalogCompileError(
        `stale ${action} override ${group.alias}: upstream mappings no longer match expectedUpstreamCodePoints`,
      );
    }
    if (action !== 'allow' && action !== 'redirect' && (baseMatches.length !== codePoints.length
      || baseMatches.some((value, index) => value !== codePoints[index]))) {
      throw new CatalogCompileError(
        `stale ${action} override ${group.alias}: upstream collision no longer matches audited codePoints`,
      );
    }
    for (const codePoint of codePoints) {
      const record = recordsByCodePoint.get(codePoint);
      if (!record) throw new CatalogCompileError(`stale override for ${formatCodePoint(codePoint)}`);
      const keep = action === 'allow'
        || ((action === 'prefer' || action === 'redirect') && codePoint === canonicalCodePoint);
      let commands = [...record.commands];
      let entities = [...record.entities];
      let nameAliases = [...record.nameAliases];
      if (group.namespace === 'command') {
        if (!keep) commands = commands.filter(({ token }) => token !== group.alias);
        else if (action === 'allow' || action === 'redirect') {
          commands.push({ token: group.alias, field: 'override', set: null });
        }
      } else if (group.namespace === 'entity') {
        entities = keep
          ? uniqueSorted([...entities, group.alias])
          : entities.filter((id) => id !== group.alias);
      } else {
        nameAliases = keep
          ? uniqueSorted([...nameAliases, group.alias])
          : nameAliases.filter((alias) => normalizedName(alias) !== normalizedName(group.alias));
      }
      recordsByCodePoint.set(codePoint, {
        ...record,
        commands: [...new Map(commands.map((command) => [
          `${command.token}\0${command.field}\0${command.set ?? ''}`,
          command,
        ])).values()].sort((left, right) => byteCompare(left.token, right.token)
          || byteCompare(left.field, right.field)
          || byteCompare(left.set ?? '', right.set ?? '')),
        entities,
        nameAliases,
        provenance: {
          ...record.provenance,
          overrides: [...record.provenance.overrides, group],
        },
      });
    }
  }

  const records = [...recordsByCodePoint.values()].sort(
    (left, right) => left.codePoint - right.codePoint,
  );
  validateAliasCollisions(records, audited);

  const admissionCounts = Object.fromEntries(
    ADMISSION_ORDER.map((reason) => [
      reason,
      records.filter(({ admission }) => admission.includes(reason)).length,
    ]),
  ) as Record<AdmissionReason, number>;

  return {
    records,
    equivalenceFamilies: equivalence.families,
    report: {
      sourceHashes,
      excludedMultiScalar: w3c.excludedMultiScalar,
      rejectedTex: w3c.rejectedTex,
      excludedUnassignedW3c: excludedUnassignedW3c.sort((left, right) => left - right),
      crossSourceDisagreements,
      auditedAliasGroups: audited.map(({ group }) => group),
      equivalenceEdges: equivalence.edges,
      recordCount: records.length,
      admissionCounts,
    },
  };
};
