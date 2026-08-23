import { gzipSync, gunzipSync } from 'node:zlib';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { SOURCE_KEYS, type SourceManifest } from './compile.js';
import { buildCatalogArtifacts, sha256, writeAtomically } from './generate.js';

interface UpdateOptions {
  readonly repositoryRoot: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly nextManifest?: CompleteManifest;
}

interface CompleteManifest extends SourceManifest {
  readonly licenses?: Readonly<Record<string, {
    readonly file: string;
    readonly url: string;
    readonly sha256: string;
  }>>;
}

const download = async (fetcher: typeof globalThis.fetch, url: string): Promise<Buffer> => {
  const response = await fetcher(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`catalog update download failed for ${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
};

export const updateCatalogSources = async (options: UpdateOptions): Promise<void> => {
  const repositoryRoot = resolve(options.repositoryRoot);
  const fetcher = options.fetch ?? globalThis.fetch;
  const catalogRoot = join(repositoryRoot, 'scripts/pdf-symbol-catalog');
  const manifestPath = join(catalogRoot, 'source-manifest.json');
  const rawManifest = await readFile(manifestPath, 'utf8');
  const currentManifest = JSON.parse(rawManifest) as CompleteManifest;
  const manifest = options.nextManifest ?? currentManifest;
  if (currentManifest.schemaVersion !== 1 || manifest.schemaVersion !== 1) {
    throw new Error(
      `unsupported source manifest schema ${String(currentManifest.schemaVersion !== 1
        ? currentManifest.schemaVersion
        : manifest.schemaVersion)}`,
    );
  }

  // Compile the checked-in source snapshot before staging any downloads. The
  // ignored audit is only a convenience artifact and must never be the source
  // of truth for a maintainer update's semantic delta.
  const priorArtifacts = await buildCatalogArtifacts({ repositoryRoot });

  const stagingRoot = await mkdtemp(join(tmpdir(), 'placekeeper-catalog-update-'));
  try {
    await mkdir(join(stagingRoot, 'scripts/pdf-symbol-catalog/sources'), { recursive: true });
    await cp(
      join(catalogRoot, 'overrides.json'),
      join(stagingRoot, 'scripts/pdf-symbol-catalog/overrides.json'),
    );
    await mkdir(join(stagingRoot, 'scripts/pdf-symbol-catalog/generated'), { recursive: true });
    await writeFile(
      join(stagingRoot, 'scripts/pdf-symbol-catalog/generated/catalog.audit.json'),
      priorArtifacts.audit,
      'utf8',
    );
    try {
      await cp(
        join(repositoryRoot, 'scripts/pdf-symbol-catalog/generated/update-report.json'),
        join(stagingRoot, 'scripts/pdf-symbol-catalog/generated/update-report.json'),
      );
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }

    const stagedManifest = structuredClone(manifest) as CompleteManifest;
    for (const key of SOURCE_KEYS) {
      const entry = stagedManifest.sources[key];
      if (entry.url === undefined || entry.file === undefined) {
        throw new Error(`source manifest entry ${key} requires url and file`);
      }
      const source = await download(fetcher, entry.url);
      const actual = sha256(source);
      if (actual !== entry.sha256) {
        throw new Error(`${key} checksum mismatch: expected ${entry.sha256}, received ${actual}`);
      }

      const currentPath = join(catalogRoot, entry.file);
      let compressed: Buffer;
      try {
        const current = await readFile(currentPath);
        compressed = sha256(gunzipSync(current)) === actual
          ? current
          : gzipSync(source, { level: 9 });
      } catch {
        compressed = gzipSync(source, { level: 9 });
      }
      (stagedManifest.sources[key] as { compressedSha256?: string }).compressedSha256 = sha256(compressed);
      const target = join(stagingRoot, 'scripts/pdf-symbol-catalog', entry.file);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, compressed);
    }

    for (const license of Object.values(stagedManifest.licenses ?? {})) {
      const existing = await readFile(join(catalogRoot, license.file));
      if (sha256(existing) !== license.sha256) {
        throw new Error(`license checksum mismatch for ${license.file}`);
      }
      const target = join(stagingRoot, 'scripts/pdf-symbol-catalog', license.file);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, existing);
    }

    const stagedManifestBytes = Buffer.from(`${JSON.stringify(stagedManifest, null, 2)}\n`, 'utf8');
    await writeFile(
      join(stagingRoot, 'scripts/pdf-symbol-catalog/source-manifest.json'),
      stagedManifestBytes,
    );
    const artifacts = await buildCatalogArtifacts({ repositoryRoot: stagingRoot });

    // Publication begins only after every download, checksum, schema, compiler, and artifact check passes.
    const publications: { path: string; value: Buffer }[] = [];
    for (const key of SOURCE_KEYS) {
      const entry = stagedManifest.sources[key];
      if (entry.file === undefined) throw new Error(`source manifest entry ${key} requires file`);
      publications.push({
        path: join(catalogRoot, entry.file),
        value: await readFile(join(stagingRoot, 'scripts/pdf-symbol-catalog', entry.file)),
      });
    }
    publications.push(
      { path: manifestPath, value: stagedManifestBytes },
      {
        path: join(repositoryRoot, 'scripts/pdf-symbol-catalog/generated/catalog.audit.json'),
        value: Buffer.from(artifacts.audit, 'utf8'),
      },
      {
        path: join(repositoryRoot, 'apps/web/src/pdf/pdf-symbol-catalog.generated.ts'),
        value: Buffer.from(artifacts.runtime, 'utf8'),
      },
      {
        path: join(repositoryRoot, 'scripts/pdf-symbol-catalog/generated/update-report.json'),
        value: Buffer.from(artifacts.report, 'utf8'),
      },
    );
    const originals = await Promise.all(publications.map(async ({ path }) => {
      try {
        return await readFile(path);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
        throw error;
      }
    }));
    let published = 0;
    try {
      for (const publication of publications) {
        await writeAtomically(publication.path, publication.value);
        published += 1;
      }
    } catch (error) {
      for (let index = published - 1; index >= 0; index -= 1) {
        const publication = publications[index];
        if (publication === undefined) continue;
        const original = originals[index];
        if (original === null || original === undefined) {
          await rm(publication.path, { force: true });
        } else {
          await writeAtomically(publication.path, original);
        }
      }
      throw error;
    }
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
};

const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const manifestFlagIndex = process.argv.indexOf('--manifest');
  let nextManifest: CompleteManifest | undefined;
  if (manifestFlagIndex !== -1) {
    const nextManifestPath = process.argv[manifestFlagIndex + 1];
    if (nextManifestPath === undefined) {
      throw new Error('--manifest requires a path to the next source manifest');
    }
    nextManifest = JSON.parse(
      await readFile(resolve(nextManifestPath), 'utf8'),
    ) as CompleteManifest;
  }
  await updateCatalogSources(nextManifest === undefined
    ? { repositoryRoot }
    : { repositoryRoot, nextManifest });
  process.stdout.write('Updated pinned mathematical symbol sources and generated artifacts.\n');
}
