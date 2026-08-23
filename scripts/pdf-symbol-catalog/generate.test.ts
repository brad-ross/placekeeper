import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildCatalogArtifacts,
  checkCatalogArtifacts,
  generateCatalogArtifacts,
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
  it('compiles the complete pinned corpus with no unresolved collisions', async () => {
    const artifacts = await buildCatalogArtifacts({ repositoryRoot });
    const audit = JSON.parse(artifacts.audit) as {
      records: { codePoint: number }[];
      report: { recordCount: number };
    };
    const report = JSON.parse(artifacts.report) as {
      aliasCollisions: { unresolved: unknown[] };
      indexCardinalities: Record<string, number>;
    };

    expect(audit.records.length).toBeGreaterThan(1_000);
    expect(audit.report.recordCount).toBe(audit.records.length);
    expect(report.aliasCollisions.unresolved).toEqual([]);
    expect(report.indexCardinalities.glyph).toBe(audit.records.length);
    expect(audit.records.some(({ codePoint }) => codePoint === 0x0020)).toBe(false);
    expect(audit.records.some(({ codePoint }) => codePoint === 0x00e9)).toBe(false);
    expect(audit.records.some(({ codePoint }) => codePoint === 0x002f)).toBe(true);
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

  it('writes validated artifacts and reports focused non-mutating drift', async () => {
    const root = await temporaryRepository();
    const written = await generateCatalogArtifacts({ repositoryRoot: root });
    await expect(checkCatalogArtifacts({ repositoryRoot: root })).resolves.toEqual(written);

    const runtimePath = join(root, 'apps/web/src/pdf/pdf-symbol-catalog.generated.ts');
    const expected = await readFile(runtimePath, 'utf8');
    await writeFile(runtimePath, `${expected}// drift\n`, 'utf8');
    await expect(checkCatalogArtifacts({ repositoryRoot: root }))
      .rejects.toThrow(/catalog artifact drift.*pdf-symbol-catalog\.generated\.ts.*catalog:generate/isu);
    expect(await readFile(runtimePath, 'utf8')).toBe(`${expected}// drift\n`);
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
  });
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
