import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compileSymbolCatalog,
  SOURCE_KEYS,
  type CatalogEquivalenceFamily,
  type CatalogOverrides,
  type CatalogRecord,
  type SourceKey,
  type SourceManifest,
} from './compile.js';

const artifactRelativePaths = {
  audit: 'scripts/pdf-symbol-catalog/generated/catalog.audit.json',
  runtime: 'apps/web/src/pdf/pdf-symbol-catalog.generated.ts',
  report: 'scripts/pdf-symbol-catalog/generated/update-report.json',
} as const;

const committedArtifactKeys = ['runtime', 'report'] as const;

export interface CatalogArtifactSet {
  readonly audit: string;
  readonly runtime: string;
  readonly report: string;
}

export interface CatalogArtifactOptions {
  readonly repositoryRoot: string;
}

interface ChangeSummary {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly {
    readonly codePoint: string;
    readonly beforeSha256: string;
    readonly afterSha256: string;
  }[];
}

interface SuppressedNaturalName {
  readonly alias: string;
  readonly codePoints: readonly string[];
  readonly retainedCodePoint?: string;
}

interface RuntimeNameProjection {
  readonly namesByCodePoint: ReadonlyMap<number, readonly string[]>;
  readonly suppressedNaturalNames: readonly SuppressedNaturalName[];
}

interface ArraySummary<T> {
  readonly count: number;
  readonly sha256: string;
  readonly sample: readonly T[];
}

export type SuggestionRank = 0 | 1 | 2 | 3 | 4;

export interface SuggestionRankInput {
  readonly category: string;
  readonly provenance: {
    readonly w3c: {
      readonly type: string | null;
      readonly mathClass: string | null;
    } | null;
  };
}

export interface SuggestionRankCounts {
  readonly identifierLike: number;
  readonly numberLike: number;
  readonly operatorRelation: number;
  readonly delimiterDiacritic: number;
  readonly punctuationFormat: number;
}

const REPORT_SAMPLE_LIMIT = 5;

const IDENTIFIER_MATH_CLASSES = new Set(['A']);
const DELIMITER_MATH_CLASSES = new Set(['O', 'C', 'F', 'D', 'G']);
const PUNCTUATION_MATH_CLASSES = new Set(['P']);
const OPERATOR_MATH_CLASSES = new Set(['R', 'B', 'L', 'N', 'U', 'V', 'X']);
const DELIMITER_TYPES = new Set(['opening', 'closing', 'diacritic']);
const OPERATOR_TYPES = new Set(['relation', 'binaryop', 'large']);

export const classifySuggestionRank = (record: SuggestionRankInput): SuggestionRank => {
  const { category } = record;
  const type = record.provenance.w3c?.type ?? null;
  const mathClass = record.provenance.w3c?.mathClass ?? null;

  if (category.startsWith('C')) return 4;
  if (category.startsWith('N')) return 1;
  if (category.startsWith('L')
    || type === 'alphabetic'
    || (mathClass !== null && IDENTIFIER_MATH_CLASSES.has(mathClass))) return 0;
  if (DELIMITER_TYPES.has(type ?? '')
    || (mathClass !== null && DELIMITER_MATH_CLASSES.has(mathClass))
    || category.startsWith('M')
    || ['Sk', 'Ps', 'Pe', 'Pi', 'Pf'].includes(category)) return 3;
  if (type === 'punctuation'
    || (mathClass !== null && PUNCTUATION_MATH_CLASSES.has(mathClass))) return 4;
  if (OPERATOR_TYPES.has(type ?? '')
    || (mathClass !== null && OPERATOR_MATH_CLASSES.has(mathClass))
    || category.startsWith('S')) return 2;
  return 4;
};

const countSuggestionRanks = (records: readonly CatalogRecord[]): SuggestionRankCounts => {
  const counts = [0, 0, 0, 0, 0];
  for (const record of records) {
    const rank = classifySuggestionRank(record);
    counts[rank] = (counts[rank] ?? 0) + 1;
  }
  return {
    identifierLike: counts[0] ?? 0,
    numberLike: counts[1] ?? 0,
    operatorRelation: counts[2] ?? 0,
    delimiterDiacritic: counts[3] ?? 0,
    punctuationFormat: counts[4] ?? 0,
  };
};

const byteCompare = (left: string, right: string): number =>
  Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));

const uniqueSorted = (values: Iterable<string>): string[] =>
  [...new Set(values)].sort(byteCompare);

export const sha256 = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const summarizeArray = <T>(values: readonly T[]): ArraySummary<T> => ({
  count: values.length,
  sha256: sha256(json(values)),
  sample: values.slice(0, REPORT_SAMPLE_LIMIT),
});

const optionalFile = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
};

const codePointId = (codePoint: number): string =>
  `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;

const preferredCommand = (record: CatalogRecord): string | null => {
  const compatibilityOnly = new Set(record.provenance.overrides.flatMap((override) => (
    override.namespace === 'command'
      && override.action === 'allow'
      && override.expectedUpstreamCodePoints?.length === 0
      ? [override.alias]
      : []
  )));
  return record.commands.find(({ field, token }) => (
    field === 'override' && !compatibilityOnly.has(token)
  ))?.token
  ?? record.commands.find(({ field }) => field === 'latex')?.token
  ?? record.commands.find(({ field }) => field === 'varlatex')?.token
  ?? null;
};

const normalizedNaturalName = (value: string): string =>
  value.normalize('NFC').trim().toLowerCase();

const projectRuntimeNames = (records: readonly CatalogRecord[]): RuntimeNameProjection => {
  const rawNamesByCodePoint = new Map(records.map((record) => [
    record.codePoint,
    uniqueSorted([record.name, ...record.descriptions, ...record.nameAliases]),
  ]));
  const ownersByName = new Map<string, Set<number>>();
  for (const [codePoint, names] of rawNamesByCodePoint) {
    for (const name of names) {
      const normalized = normalizedNaturalName(name);
      const owners = ownersByName.get(normalized) ?? new Set<number>();
      owners.add(codePoint);
      ownersByName.set(normalized, owners);
    }
  }

  const auditedTargets = new Map<string, number>();
  for (const record of records) {
    for (const override of record.provenance.overrides) {
      if (override.namespace !== 'name'
        || override.action !== 'allow'
        || override.codePoints.length !== 1) continue;
      const [target] = override.codePoints;
      if (target !== undefined) {
        auditedTargets.set(normalizedNaturalName(override.alias), Number.parseInt(target, 16));
      }
    }
  }
  const officialTargets = new Map(records.map((record) => [
    normalizedNaturalName(record.name),
    record.codePoint,
  ]));

  const suppressedNaturalNames: SuppressedNaturalName[] = [];
  for (const [alias, owners] of [...ownersByName].sort(([left], [right]) => byteCompare(left, right))) {
    if (owners.size < 2) continue;
    const codePoints = [...owners].sort((left, right) => left - right);
    const retained = auditedTargets.get(alias) ?? officialTargets.get(alias);
    suppressedNaturalNames.push({
      alias,
      codePoints: codePoints.map(codePointId),
      ...(retained !== undefined && owners.has(retained)
        ? { retainedCodePoint: codePointId(retained) }
        : {}),
    });
  }

  const namesByCodePoint = new Map<number, readonly string[]>();
  for (const [codePoint, names] of rawNamesByCodePoint) {
    namesByCodePoint.set(codePoint, names.filter((name) => {
      const normalized = normalizedNaturalName(name);
      const owners = ownersByName.get(normalized);
      const retained = auditedTargets.get(normalized) ?? officialTargets.get(normalized);
      return owners?.size === 1 || retained === codePoint;
    }));
  }
  return { namesByCodePoint, suppressedNaturalNames };
};

const renderRuntime = (
  records: readonly CatalogRecord[],
  namesByCodePoint: ReadonlyMap<number, readonly string[]>,
  equivalenceFamilies: readonly CatalogEquivalenceFamily[],
): string => {
  const semanticFamiliesByCodePoint = new Map<number, readonly number[]>();
  for (const family of equivalenceFamilies) {
    for (const codePoint of family.queryCodePoints) {
      semanticFamiliesByCodePoint.set(codePoint, family.memberCodePoints);
    }
  }
  const tuples = records.map((record) => [
    record.codePoint,
    record.glyph,
    record.name.toLowerCase(),
    preferredCommand(record),
    uniqueSorted(record.commands.map(({ token }) => token)),
    uniqueSorted(record.entities),
    namesByCodePoint.get(record.codePoint) ?? [],
    semanticFamiliesByCodePoint.get(record.codePoint) ?? [],
    classifySuggestionRank(record),
  ] as const);
  return `// Generated by pnpm catalog:generate. Do not edit.\n\n`
    + `export type GeneratedPdfSymbolCatalogTuple = readonly [\n`
    + `  codePoint: number,\n`
    + `  glyph: string,\n`
    + `  displayName: string,\n`
    + `  preferredCommand: string | null,\n`
    + `  commands: readonly string[],\n`
    + `  entities: readonly string[],\n`
    + `  names: readonly string[],\n`
    + `  semanticFamilyCodePoints: readonly number[],\n`
    + `  suggestionRank: 0 | 1 | 2 | 3 | 4,\n`
    + `];\n\n`
    + `export const GENERATED_PDF_SYMBOL_CATALOG = ${JSON.stringify(tuples)} as const satisfies readonly GeneratedPdfSymbolCatalogTuple[];\n`;
};

const parsePriorRecords = (audit: string | null): readonly CatalogRecord[] => {
  if (audit === null) return [];
  try {
    const parsed = JSON.parse(audit) as { records?: unknown };
    return Array.isArray(parsed.records) ? parsed.records as CatalogRecord[] : [];
  } catch {
    return [];
  }
};

const compareRecords = (
  before: readonly CatalogRecord[],
  after: readonly CatalogRecord[],
): ChangeSummary => {
  const oldByCodePoint = new Map(before.map((record) => [record.codePoint, record]));
  const newByCodePoint = new Map(after.map((record) => [record.codePoint, record]));
  const added = [...newByCodePoint.keys()].filter((value) => !oldByCodePoint.has(value));
  const removed = [...oldByCodePoint.keys()].filter((value) => !newByCodePoint.has(value));
  const changed = [...newByCodePoint.keys()].flatMap((codePoint) => {
    const oldRecord = oldByCodePoint.get(codePoint);
    const newRecord = newByCodePoint.get(codePoint);
    if (!oldRecord || !newRecord) return [];
    const beforeValue = JSON.stringify(oldRecord);
    const afterValue = JSON.stringify(newRecord);
    return beforeValue === afterValue ? [] : [{
      codePoint: codePointId(codePoint),
      beforeSha256: sha256(beforeValue),
      afterSha256: sha256(afterValue),
    }];
  });
  return {
    added: added.sort((left, right) => left - right).map(codePointId),
    removed: removed.sort((left, right) => left - right).map(codePointId),
    changed,
  };
};

const preservedChanges = (
  priorReport: string | null,
  catalogSha256: string,
  fallback: ChangeSummary,
): ChangeSummary => {
  if (priorReport === null) return fallback;
  try {
    const parsed = JSON.parse(priorReport) as {
      catalogSha256?: unknown;
      changes?: ChangeSummary;
    };
    if (parsed.catalogSha256 === catalogSha256
      && Array.isArray(parsed.changes?.added)
      && Array.isArray(parsed.changes.removed)
      && Array.isArray(parsed.changes.changed)) {
      return parsed.changes;
    }
  } catch {
    // A malformed report is replaced by the deterministic current comparison.
  }
  return fallback;
};

const readCompilerInputs = async (repositoryRoot: string) => {
  const catalogRoot = join(repositoryRoot, 'scripts/pdf-symbol-catalog');
  const manifest = JSON.parse(
    await readFile(join(catalogRoot, 'source-manifest.json'), 'utf8'),
  ) as SourceManifest;
  const overrides = JSON.parse(
    await readFile(join(catalogRoot, 'overrides.json'), 'utf8'),
  ) as CatalogOverrides;
  const sources = {} as Record<SourceKey, string>;
  for (const key of SOURCE_KEYS) {
    const entry = manifest.sources[key];
    if (entry.file === undefined || entry.compressedSha256 === undefined) {
      throw new Error(`source manifest entry ${key} requires file and compressedSha256`);
    }
    const compressed = await readFile(join(catalogRoot, entry.file));
    const actualCompressed = sha256(compressed);
    if (actualCompressed !== entry.compressedSha256) {
      throw new Error(
        `${key} compressed checksum mismatch: expected ${entry.compressedSha256}, received ${actualCompressed}`,
      );
    }
    sources[key] = gunzipSync(compressed).toString('utf8');
  }
  return { manifest, overrides, sources };
};

export const buildCatalogArtifacts = async (
  options: CatalogArtifactOptions,
): Promise<CatalogArtifactSet> => {
  const repositoryRoot = resolve(options.repositoryRoot);
  const input = await readCompilerInputs(repositoryRoot);
  const compiled = compileSymbolCatalog(input);
  const runtimeNames = projectRuntimeNames(compiled.records);
  const suggestionRankCounts = countSuggestionRanks(compiled.records);
  const audit = json({
    schemaVersion: 1,
    unicodeVersion: input.manifest.unicodeVersion,
    w3cCommit: input.manifest.w3cCommit,
    records: compiled.records,
    equivalenceFamilies: compiled.equivalenceFamilies,
    report: compiled.report,
    runtimeProjection: {
      suppressedNaturalNames: runtimeNames.suppressedNaturalNames,
      suggestionRankCounts,
    },
  });
  const runtime = renderRuntime(
    compiled.records,
    runtimeNames.namesByCodePoint,
    compiled.equivalenceFamilies,
  );
  const priorAudit = await optionalFile(join(repositoryRoot, artifactRelativePaths.audit));
  const priorReport = await optionalFile(join(repositoryRoot, artifactRelativePaths.report));
  const catalogSha256 = sha256(audit);
  const changes = preservedChanges(
    priorReport,
    catalogSha256,
    compareRecords(parsePriorRecords(priorAudit), compiled.records),
  );

  const categoryCounts = Object.fromEntries(
    uniqueSorted(compiled.records.map(({ category }) => category)).map((category) => [
      category,
      compiled.records.filter((record) => record.category === category).length,
    ]),
  );
  const commands = uniqueSorted(compiled.records.flatMap((record) =>
    record.commands.map(({ token }) => token)));
  const entities = uniqueSorted(compiled.records.flatMap(({ entities: values }) => values));
  const names = uniqueSorted(
    [...runtimeNames.namesByCodePoint.values()].flat().map(normalizedNaturalName),
  );
  const reportBase = {
    schemaVersion: 1,
    unicodeVersion: input.manifest.unicodeVersion,
    w3cCommit: input.manifest.w3cCommit,
    catalogSha256,
    sourceHashes: compiled.report.sourceHashes,
    counts: {
      records: compiled.records.length,
      category: categoryCounts,
      suggestionRank: suggestionRankCounts,
      admission: compiled.report.admissionCounts,
      provenance: {
        unicodeMath: compiled.records.filter(({ provenance }) => provenance.unicode.mathSource !== null).length,
        w3c: compiled.records.filter(({ provenance }) => provenance.w3c !== null).length,
        overriddenRecords: compiled.records.filter(({ provenance }) => provenance.overrides.length > 0).length,
      },
    },
    changes,
    exclusions: {
      multiScalar: summarizeArray(compiled.report.excludedMultiScalar),
      unassignedW3c: summarizeArray(compiled.report.excludedUnassignedW3c.map(codePointId)),
    },
    rejectedTex: summarizeArray(compiled.report.rejectedTex),
    equivalence: {
      families: compiled.equivalenceFamilies.length,
      edges: compiled.report.equivalenceEdges.length,
      expandingMembers: compiled.equivalenceFamilies.reduce(
        (count, family) => count + family.queryCodePoints.length,
        0,
      ),
      styledMembers: compiled.report.equivalenceEdges.filter(({ kind }) => kind === 'font').length,
    },
    aliasDecisions: summarizeArray(compiled.report.auditedAliasGroups),
    aliasCollisions: {
      unresolved: summarizeArray([]),
      suppressedNaturalNames: summarizeArray(runtimeNames.suppressedNaturalNames),
    },
    overrideCount: compiled.report.auditedAliasGroups.length,
    indexCardinalities: {
      glyph: compiled.records.length,
      command: commands.length,
      entity: entities.length,
      normalizedName: names.length,
    },
    artifactBytes: { audit: Buffer.byteLength(audit), runtime: Buffer.byteLength(runtime), report: 0 },
  };
  let report = json(reportBase);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const bytes = Buffer.byteLength(report);
    const next = json({
      ...reportBase,
      artifactBytes: { ...reportBase.artifactBytes, report: bytes },
    });
    if (next === report) break;
    report = next;
  }
  return { audit, runtime, report };
};

export const writeAtomically = async (
  path: string,
  contents: string | Uint8Array,
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const temporary = await mkdtemp(join(dirname(path), '.catalog-generate-'));
  const staged = join(temporary, 'artifact');
  try {
    await writeFile(staged, contents);
    await rename(staged, path);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
};

export const generateCatalogArtifacts = async (
  options: CatalogArtifactOptions,
): Promise<CatalogArtifactSet> => {
  const artifacts = await buildCatalogArtifacts(options);
  for (const key of ['audit', 'runtime', 'report'] as const) {
    await writeAtomically(
      join(resolve(options.repositoryRoot), artifactRelativePaths[key]),
      artifacts[key],
    );
  }
  return artifacts;
};

export const generateCatalogAudit = async (
  options: CatalogArtifactOptions,
): Promise<CatalogArtifactSet> => {
  const artifacts = await buildCatalogArtifacts(options);
  await writeAtomically(
    join(resolve(options.repositoryRoot), artifactRelativePaths.audit),
    artifacts.audit,
  );
  return artifacts;
};

export const checkCatalogArtifacts = async (
  options: CatalogArtifactOptions,
): Promise<CatalogArtifactSet> => {
  const expected = await buildCatalogArtifacts(options);
  const drift: string[] = [];
  for (const key of committedArtifactKeys) {
    const path = join(resolve(options.repositoryRoot), artifactRelativePaths[key]);
    const actual = await optionalFile(path);
    if (actual !== expected[key]) drift.push(relative(resolve(options.repositoryRoot), path));
  }
  if (drift.length > 0) {
    throw new Error(
      `catalog artifact drift in ${drift.join(', ')}; run pnpm catalog:generate and commit the runtime catalog and update report`,
    );
  }
  return expected;
};

const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const check = process.argv.includes('--check');
  const auditOnly = process.argv.includes('--audit-only');
  if (check && auditOnly) throw new Error('--check and --audit-only cannot be combined');
  const artifacts = await (check
    ? checkCatalogArtifacts
    : auditOnly
      ? generateCatalogAudit
      : generateCatalogArtifacts)({ repositoryRoot });
  if (check) {
    const { validateCatalogSourceBaseline } = await import('../../packaging/macos/validate-manifest.js');
    await validateCatalogSourceBaseline(repositoryRoot);
  }
  const report = JSON.parse(artifacts.report) as {
    counts: { records: number };
    artifactBytes: { audit: number; runtime: number; report: number };
  };
  const reportedBytes = check
    ? { runtime: report.artifactBytes.runtime, report: report.artifactBytes.report }
    : auditOnly
      ? { audit: report.artifactBytes.audit }
      : report.artifactBytes;
  process.stdout.write(
    `${check ? 'Checked committed runtime/report for' : auditOnly ? 'Generated full audit for' : 'Generated'} ${report.counts.records} mathematical symbol records ${JSON.stringify(reportedBytes)}\n`,
  );
}
