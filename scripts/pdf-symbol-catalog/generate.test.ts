import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import type { CatalogRecord, SourceManifest } from './compile.js';
import {
  buildCatalogArtifacts,
  checkCatalogArtifacts,
  classifySuggestionRank,
  generateCatalogAudit,
  generateCatalogArtifacts,
  sha256,
  type CatalogArtifactSet,
} from './generate.js';
import { updateCatalogSources } from './update.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const temporaryRoots: string[] = [];

const temporaryRepository = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'placekeeper-catalog-test-'));
  temporaryRoots.push(root);
  await cp(join(repositoryRoot, 'scripts/pdf-symbol-catalog'), join(root, 'scripts/pdf-symbol-catalog'), {
    recursive: true,
  });
  return root;
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('PDF symbol catalog artifact generation', () => {
  it('classifies suggestion rank by standards-derived precedence', () => {
    const classify = (
      category: string,
      type: string | null = null,
      mathClass: string | null = null,
    ) => classifySuggestionRank({ category, provenance: { w3c: { type, mathClass } } });

    expect(classify('Cf', 'binaryop', 'B')).toBe(4);
    expect(classify('Nd', 'alphabetic', 'A')).toBe(1);
    expect(classifySuggestionRank({ category: 'Ll', provenance: { w3c: null } })).toBe(0);
    expect(classify('Po', 'alphabetic')).toBe(0);
    expect(classify('Po', null, 'A')).toBe(0);
    for (const type of ['opening', 'closing', 'diacritic']) {
      expect(classify('Po', type)).toBe(3);
    }
    for (const mathClass of ['O', 'C', 'F', 'D', 'G']) {
      expect(classify('Po', null, mathClass)).toBe(3);
    }
    for (const category of ['Mn', 'Mc', 'Me', 'Sk', 'Ps', 'Pe', 'Pi', 'Pf']) {
      expect(classify(category)).toBe(3);
    }
    expect(classify('Po', 'punctuation', 'B')).toBe(4);
    expect(classify('Po', null, 'P')).toBe(4);
    for (const type of ['relation', 'binaryop', 'large']) {
      expect(classify('Po', type)).toBe(2);
    }
    for (const mathClass of ['R', 'B', 'L', 'N', 'U', 'V', 'X']) {
      expect(classify('Po', null, mathClass)).toBe(2);
    }
    for (const category of ['Sm', 'Sc', 'So']) expect(classify(category)).toBe(2);
    expect(classify('Po')).toBe(4);
  });

  it('compiles the complete pinned corpus with no unresolved collisions', async () => {
    const artifacts = await buildCatalogArtifacts({ repositoryRoot });
    const audit = JSON.parse(artifacts.audit) as {
      records: CatalogRecord[];
      equivalenceFamilies: {
        rootCodePoint: number;
        queryCodePoints: number[];
        memberCodePoints: number[];
      }[];
      report: { recordCount: number; sourceHashes: Record<string, string> };
      runtimeProjection: {
        suggestionRankCounts: Record<string, number>;
        suppressedNaturalNames: {
          alias: string;
          codePoints: string[];
          retainedCodePoint?: string;
        }[];
      };
    };
    const report = JSON.parse(artifacts.report) as {
      aliasCollisions: {
        unresolved: { count: number; sample: unknown[] };
        suppressedNaturalNames: { count: number; sample: unknown[] };
      };
      indexCardinalities: Record<string, number>;
      counts: { records: number; suggestionRank: Record<string, number> };
    };

    expect(audit.records.length).toBeGreaterThan(1_000);
    expect(audit.report.recordCount).toBe(audit.records.length);
    expect(audit.report.sourceHashes.unicodeData)
      .toBe('2e1efc1dcb59c575eedf5ccae60f95229f706ee6d031835247d843c11d96470c');
    expect(audit.equivalenceFamilies).toContainEqual(expect.objectContaining({
      queryCodePoints: expect.arrayContaining([0x03b5, 0x03f5]),
      memberCodePoints: expect.arrayContaining([0x03b5, 0x03f5, 0x1d6dc]),
    }));
    for (const [base, variant] of [
      [0x03b2, 0x03d0], [0x03b5, 0x03f5], [0x03b8, 0x03d1],
      [0x03ba, 0x03f0], [0x03c1, 0x03f1], [0x03c6, 0x03d5],
      [0x03c0, 0x03d6], [0x0398, 0x03f4], [0x03a5, 0x03d2],
      [0x00b5, 0x03bc],
    ] as const) {
      const family = audit.equivalenceFamilies.find(({ memberCodePoints }) => (
        memberCodePoints.includes(base)
      ));
      expect(family?.queryCodePoints, `${base.toString(16)}/${variant.toString(16)}`)
        .toEqual(expect.arrayContaining([base, variant]));
    }
    const finalSigmaFamily = audit.equivalenceFamilies.find(({ memberCodePoints }) => (
      memberCodePoints.includes(0x03c2)
    ));
    expect(finalSigmaFamily?.memberCodePoints).not.toContain(0x03c3);
    expect(audit.equivalenceFamilies.find(({ memberCodePoints }) => (
      memberCodePoints.includes(0x1d6c2)
    ))?.queryCodePoints).not.toContain(0x1d6c2);
    for (const [left, right] of [
      [0x002d, 0x2212], [0x007c, 0x2223], [0x2223, 0x23d0],
      [0x2205, 0x2300], [0x007e, 0x02dc], [0x02dc, 0x223c],
      [0x00d7, 0x2217],
    ] as const) {
      expect(audit.equivalenceFamilies.some(({ memberCodePoints }) => (
        memberCodePoints.includes(left) && memberCodePoints.includes(right)
      )), `${left.toString(16)}/${right.toString(16)}`).toBe(false);
    }
    for (const distinctGroup of [
      [0x007c, 0x2223, 0x23d0],
      [0x007e, 0x02dc, 0x223c],
      [0x002a, 0x00d7, 0x2217, 0x22c5],
    ] as const) {
      expect(audit.equivalenceFamilies.every(({ memberCodePoints }) => (
        distinctGroup.filter((codePoint) => memberCodePoints.includes(codePoint)).length <= 1
      ))).toBe(true);
    }
    expect(audit.records.find(({ codePoint }) => codePoint === 0x025b)?.commands)
      .not.toContainEqual(expect.objectContaining({ token: '\\varepsilon' }));
    expect(audit.records.find(({ codePoint }) => codePoint === 0x03f5)?.commands)
      .toContainEqual(expect.objectContaining({ token: '\\varepsilon' }));
    expect(report.aliasCollisions.unresolved).toMatchObject({ count: 0, sample: [] });
    expect(report.aliasCollisions.suppressedNaturalNames.count)
      .toBe(audit.runtimeProjection.suppressedNaturalNames.length);
    expect(audit.runtimeProjection.suppressedNaturalNames).toContainEqual({
      alias: 'legacy uppercase name',
      codePoints: expect.arrayContaining(['U+0022', 'U+2122']),
    });
    expect(audit.runtimeProjection.suppressedNaturalNames).toContainEqual({
      alias: 'ac current',
      codePoints: ['U+223F', 'U+23E6'],
      retainedCodePoint: 'U+23E6',
    });
    expect(artifacts.runtime).not.toContain('legacy uppercase name');
    expect(report.indexCardinalities.glyph).toBe(audit.records.length);
    expect(audit.records.some(({ codePoint }) => codePoint === 0x0020)).toBe(false);
    expect(audit.records.some(({ codePoint }) => codePoint === 0x00e9)).toBe(false);
    expect(audit.records.some(({ codePoint }) => codePoint === 0x002f)).toBe(true);
    expect(artifacts.runtime).toContain('semanticFamilyCodePoints: readonly number[]');
    expect(artifacts.runtime).toContain('suggestionRank: 0 | 1 | 2 | 3 | 4');
    expect(Object.values(audit.runtimeProjection.suggestionRankCounts)
      .reduce((sum, count) => sum + count, 0)).toBe(audit.records.length);
    expect(report.counts.suggestionRank).toEqual(audit.runtimeProjection.suggestionRankCounts);

    const expectedRanks = new Map([
      [0x1d7d8, 1], // 𝟘: Unicode number wins over W3C alphabetic metadata.
      [0x2118, 0], // ℘: W3C alphabetic metadata makes it identifier-like.
      [0x002f, 2], // /: W3C binary operator wins over Unicode punctuation.
      [0x2061, 4], // ⁡: Unicode format control wins over W3C binary operator.
      [0x2202, 2], // ∂: operator/relation tier.
      [0x2207, 2], // ∇: operator/relation tier.
      [0x0028, 3], // (: delimiter tier.
      [0x02dc, 3], // ˜: diacritic tier.
      [0x002c, 4], // ,: punctuation tier.
    ]);
    const recordsByCodePoint = new Map(audit.records.map((record) => [record.codePoint, record]));
    for (const [codePoint, rank] of expectedRanks) {
      const record = recordsByCodePoint.get(codePoint);
      expect(record, `missing ${codePoint.toString(16)}`).toBeDefined();
      expect(classifySuggestionRank(record!)).toBe(rank);
    }

    const runtimeTuples = JSON.parse(
      artifacts.runtime.match(/ = (\[.*\]) as const satisfies/su)?.[1] ?? '[]',
    ) as unknown[][];
    expect(runtimeTuples).toHaveLength(audit.records.length);
    expect(runtimeTuples.every((tuple) => tuple.length === 9)).toBe(true);
    expect(runtimeTuples.map(([codePoint]) => codePoint)).toEqual(
      [...audit.records.map(({ codePoint }) => codePoint)].sort((left, right) => left - right),
    );
    for (const tuple of runtimeTuples) {
      const [codePoint, , , , , , , , rank] = tuple as [number, ...unknown[]];
      const record = recordsByCodePoint.get(codePoint);
      expect(classifySuggestionRank(record!)).toBe(rank);
    }
  });

  it('keeps the committed report concise while retaining exhaustive audit evidence', async () => {
    const artifacts = await buildCatalogArtifacts({ repositoryRoot });
    const audit = JSON.parse(artifacts.audit) as {
      report: {
        excludedMultiScalar: unknown[];
        excludedUnassignedW3c: unknown[];
        rejectedTex: unknown[];
        auditedAliasGroups: unknown[];
      };
      runtimeProjection: {
        suppressedNaturalNames: unknown[];
        suggestionRankCounts: Record<string, number>;
      };
    };
    const report = JSON.parse(artifacts.report) as {
      exclusions: {
        multiScalar: { count: number; sha256: string; sample: unknown[] };
        unassignedW3c: { count: number; sha256: string; sample: unknown[] };
      };
      rejectedTex: { count: number; sha256: string; sample: unknown[] };
      aliasDecisions: { count: number; sha256: string; sample: unknown[] };
      aliasCollisions: {
        suppressedNaturalNames: { count: number; sha256: string; sample: unknown[] };
      };
      counts: { records: number; suggestionRank: Record<string, number> };
    };

    expect(Buffer.byteLength(artifacts.report)).toBeLessThan(25_000);
    expect(report.counts.suggestionRank).toEqual(
      audit.runtimeProjection.suggestionRankCounts,
    );
    expect(Object.values(report.counts.suggestionRank)
      .reduce((sum, count) => sum + count, 0)).toBe(report.counts.records);
    const unassignedW3c = audit.report.excludedUnassignedW3c.map((value) => (
      `U+${String((value as number).toString(16)).toUpperCase().padStart(4, '0')}`
    ));
    for (const [summary, exhaustive] of [
      [report.exclusions.multiScalar, audit.report.excludedMultiScalar],
      [report.exclusions.unassignedW3c, unassignedW3c],
      [report.rejectedTex, audit.report.rejectedTex],
      [report.aliasDecisions, audit.report.auditedAliasGroups],
      [report.aliasCollisions.suppressedNaturalNames,
        audit.runtimeProjection.suppressedNaturalNames],
    ] as const) {
      expect(summary.count).toBe(exhaustive.length);
      expect(summary.sha256).toBe(sha256(`${JSON.stringify(exhaustive, null, 2)}\n`));
      expect(summary.sample).toEqual(exhaustive.slice(0, 5));
      expect(summary.sample.length).toBeLessThanOrEqual(5);
    }
  });

  it('emits byte-identical UTF-8 LF artifacts across locale and timezone settings', async () => {
    const original = { lang: process.env.LANG, timezone: process.env.TZ };
    process.env.LANG = 'tr_TR.UTF-8';
    process.env.TZ = 'Pacific/Kiritimati';
    const first = await buildCatalogArtifacts({ repositoryRoot });
    process.env.LANG = 'C';
    process.env.TZ = 'America/New_York';
    const second = await buildCatalogArtifacts({ repositoryRoot });
    process.env.LANG = original.lang;
    process.env.TZ = original.timezone;

    expect(second).toEqual(first);
    for (const value of Object.values(first) as string[]) {
      expect(value.endsWith('\n')).toBe(true);
      expect(value).not.toContain('\r\n');
    }
  });

  it('writes a local audit while checking only the committed runtime and report', async () => {
    const root = await temporaryRepository();
    const written = await generateCatalogArtifacts({ repositoryRoot: root });
    await expect(checkCatalogArtifacts({ repositoryRoot: root })).resolves.toEqual(written);

    const auditPath = join(root, 'scripts/pdf-symbol-catalog/generated/catalog.audit.json');
    expect(await readFile(auditPath, 'utf8')).toBe(written.audit);
    await writeFile(auditPath, '{"stale":true}\n', 'utf8');
    await expect(checkCatalogArtifacts({ repositoryRoot: root })).resolves.toEqual(written);
    await rm(auditPath);
    await expect(checkCatalogArtifacts({ repositoryRoot: root })).resolves.toEqual(written);

    const runtimePath = join(root, 'apps/web/src/pdf/pdf-symbol-catalog.generated.ts');
    const expected = await readFile(runtimePath, 'utf8');
    await writeFile(runtimePath, `${expected}// drift\n`, 'utf8');
    await expect(checkCatalogArtifacts({ repositoryRoot: root }))
      .rejects.toThrow(/catalog artifact drift.*pdf-symbol-catalog\.generated\.ts.*catalog:generate/isu);
    expect(await readFile(runtimePath, 'utf8')).toBe(`${expected}// drift\n`);

    await writeFile(runtimePath, expected, 'utf8');
    const reportPath = join(root, 'scripts/pdf-symbol-catalog/generated/update-report.json');
    const report = await readFile(reportPath, 'utf8');
    await writeFile(reportPath, `${report} `, 'utf8');
    await expect(checkCatalogArtifacts({ repositoryRoot: root }))
      .rejects.toThrow(/catalog artifact drift.*update-report\.json.*catalog:generate/isu);
  }, 15_000);

  it('can generate only the downloadable full audit for CI', async () => {
    const root = await temporaryRepository();
    await rm(join(root, 'scripts/pdf-symbol-catalog/generated'), { recursive: true, force: true });
    const artifacts = await generateCatalogAudit({ repositoryRoot: root });

    expect(await readFile(
      join(root, 'scripts/pdf-symbol-catalog/generated/catalog.audit.json'),
      'utf8',
    )).toBe(artifacts.audit);
    await expect(readFile(
      join(root, 'apps/web/src/pdf/pdf-symbol-catalog.generated.ts'),
      'utf8',
    )).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(
      join(root, 'scripts/pdf-symbol-catalog/generated/update-report.json'),
      'utf8',
    )).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps runtime output independent of source, network, and audit modules', async () => {
    const artifacts = await buildCatalogArtifacts({ repositoryRoot });
    expect(artifacts.runtime).not.toMatch(/(?:source-manifest|catalog\.audit|node:|fetch\s*\(|https?:\/\/)/u);
    expect(artifacts.runtime).toContain('GENERATED_PDF_SYMBOL_CATALOG');
  });

  it('leaves every repository byte unchanged when an update download fails', async () => {
    const root = await temporaryRepository();
    await generateCatalogArtifacts({ repositoryRoot: root });
    const before = await snapshot(root);

    await expect(updateCatalogSources({
      repositoryRoot: root,
      fetch: async () => new Response('upstream failure', { status: 503 }),
    })).rejects.toThrow(/download failed.*503/i);
    expect(await snapshot(root)).toEqual(before);
  });

  it('stages, validates, and publishes a successful explicit update as one stable projection', async () => {
    const root = await temporaryRepository();
    await generateCatalogArtifacts({ repositoryRoot: root });
    const before = await snapshot(root);
    const manifest = JSON.parse(before.manifest) as {
      sources: Record<string, { url: string; file: string }>;
    };
    const downloaded = new Map<string, Buffer>();
    for (const entry of Object.values(manifest.sources)) {
      downloaded.set(
        entry.url,
        gunzipSync(await readFile(join(root, 'scripts/pdf-symbol-catalog', entry.file))),
      );
    }
    await writeFile(
      join(root, 'apps/web/src/pdf/pdf-symbol-catalog.generated.ts'),
      `${before.runtime}// stale generated projection\n`,
      'utf8',
    );
    await rm(join(root, 'scripts/pdf-symbol-catalog/generated/catalog.audit.json'));

    await updateCatalogSources({
      repositoryRoot: root,
      fetch: async (input) => {
        const source = downloaded.get(String(input));
        return source === undefined
          ? new Response('missing fixture', { status: 404 })
          : new Response(Uint8Array.from(source).buffer, { status: 200 });
      },
    });

    await expect(checkCatalogArtifacts({ repositoryRoot: root })).resolves.toBeDefined();
    expect(await snapshot(root)).toEqual(before);

    await updateCatalogSources({
      repositoryRoot: root,
      fetch: async (input) => {
        const source = downloaded.get(String(input));
        return source === undefined
          ? new Response('missing fixture', { status: 404 })
          : new Response(Uint8Array.from(source).buffer, { status: 200 });
      },
    });
    expect(await snapshot(root)).toEqual(before);
  });

  it.each(['absent', 'stale'] as const)(
    'reports precise source deltas when the ignored audit is %s',
    async (auditState) => {
      const root = await temporaryRepository();
      const before = await generateCatalogArtifacts({ repositoryRoot: root });
      const beforeAudit = JSON.parse(before.audit) as {
        records: { codePoint: number }[];
      };
      const manifestPath = join(root, 'scripts/pdf-symbol-catalog/source-manifest.json');
      const nextManifest = JSON.parse(await readFile(manifestPath, 'utf8')) as SourceManifest & {
        licenses?: Record<string, { file: string; url: string; sha256: string }>;
      };
      const downloaded = new Map<string, Buffer>();
      for (const entry of Object.values(nextManifest.sources)) {
        if (entry.url === undefined || entry.file === undefined) {
          throw new Error('incomplete catalog test source');
        }
        downloaded.set(
          entry.url,
          gunzipSync(await readFile(join(root, 'scripts/pdf-symbol-catalog', entry.file))),
        );
      }
      const derivedName = nextManifest.sources.derivedName as {
        readonly url: string;
        readonly file: string;
        sha256: string;
      };
      const oldDerivedName = downloaded.get(derivedName.url);
      if (oldDerivedName === undefined) throw new Error('missing derivedName test download');
      const newDerivedName = Buffer.from(
        oldDerivedName.toString('utf8').replace(
          '2212          ; MINUS SIGN',
          '2212          ; MINUS SIGN UPDATED',
        ),
        'utf8',
      );
      expect(newDerivedName).not.toEqual(oldDerivedName);
      derivedName.sha256 = sha256(newDerivedName);
      downloaded.set(derivedName.url, newDerivedName);

      const auditPath = join(root, 'scripts/pdf-symbol-catalog/generated/catalog.audit.json');
      if (auditState === 'absent') await rm(auditPath);
      else await writeFile(auditPath, '{"records":[{"codePoint":1}]}\n', 'utf8');

      await updateCatalogSources({
        repositoryRoot: root,
        nextManifest,
        fetch: async (input) => {
          const source = downloaded.get(String(input));
          return source === undefined
            ? new Response('missing fixture', { status: 404 })
            : new Response(Uint8Array.from(source).buffer, { status: 200 });
        },
      });

      const afterAuditSource = await readFile(auditPath, 'utf8');
      const afterAudit = JSON.parse(afterAuditSource) as {
        records: { codePoint: number }[];
      };
      const report = JSON.parse(await readFile(
        join(root, 'scripts/pdf-symbol-catalog/generated/update-report.json'),
        'utf8',
      )) as {
        changes: {
          added: string[];
          removed: string[];
          changed: { codePoint: string; beforeSha256: string; afterSha256: string }[];
        };
      };
      const beforeRecord = beforeAudit.records.find(({ codePoint }) => codePoint === 0x2212);
      const afterRecord = afterAudit.records.find(({ codePoint }) => codePoint === 0x2212);
      if (beforeRecord === undefined || afterRecord === undefined) {
        throw new Error('missing U+2212 regression record');
      }
      expect(report.changes).toEqual({
        added: [],
        removed: [],
        changed: [{
          codePoint: 'U+2212',
          beforeSha256: sha256(JSON.stringify(beforeRecord)),
          afterSha256: sha256(JSON.stringify(afterRecord)),
        }],
      });
      await expect(checkCatalogArtifacts({ repositoryRoot: root })).resolves.toBeDefined();
    },
    30_000,
  );
});

const snapshot = async (root: string): Promise<CatalogArtifactSet & { manifest: string }> => {
  const [audit, runtime, report, manifest] = await Promise.all([
    readFile(join(root, 'scripts/pdf-symbol-catalog/generated/catalog.audit.json'), 'utf8'),
    readFile(join(root, 'apps/web/src/pdf/pdf-symbol-catalog.generated.ts'), 'utf8'),
    readFile(join(root, 'scripts/pdf-symbol-catalog/generated/update-report.json'), 'utf8'),
    readFile(join(root, 'scripts/pdf-symbol-catalog/source-manifest.json'), 'utf8'),
  ]);
  return { audit, runtime, report, manifest };
};
