import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopAssetNames } from '../packages/core/src/desktop-release.js';
import { releaseIdentity } from './package-source-release.js';
interface Artifact {
    target: string;
    name: string;
    sha256: string;
}
interface SourceArtifact {
    name: string;
    sha256: string;
}
export interface BuildProvenance {
    schemaVersion: number;
    version: string;
    commit: string;
    candidateRun: string;
    sources: SourceArtifact[];
    assets: Artifact[];
}
export function buildProvenance(version: string, commit: string, candidateRun: string, assets: Artifact[], sources: SourceArtifact[]): BuildProvenance {
    releaseIdentity(version, commit);
    if (!/^\d+$/u.test(candidateRun))
        throw Error('Candidate workflow run required');
    const expected = desktopAssetNames(version);
    if (assets.length !== 4 || Object.entries(expected).some(([target, name]) => assets.filter(asset => asset.target === target && asset.name === name && /^[a-f0-9]{64}$/u.test(asset.sha256)).length !== 1))
        throw Error('Exact four desktop assets required');
    if (sources.length !== 2 || [`placekeeper-source-v${version}.tar.gz`, 'install-placekeeper.sh'].some(name => sources.filter(source => source.name === name && /^[a-f0-9]{64}$/u.test(source.sha256)).length !== 1))
        throw Error('Exact source assets required');
    return { schemaVersion: 1, version, commit, candidateRun, sources, assets };
}
export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export function payloadNames(version: string): string[] {
    return [...Object.values(desktopAssetNames(version)), `placekeeper-source-v${version}.tar.gz`, 'install-placekeeper.sh'];
}
export function completeInventory(version: string): string[] {
    return [...payloadNames(version), 'SHA256SUMS', 'desktop-build-provenance.json'];
}
export function verifyReleaseFiles(files: Record<string, Buffer>, version: string): {
    assets: Artifact[];
    sources: {
        name: string;
        sha256: string;
    }[];
    checksums: string;
} {
    const names = payloadNames(version);
    if (Object.keys(files).length !== names.length || names.some(name => !files[name]?.length))
        throw Error('Incomplete or unexpected release payload inventory');
    const desktopAssets = desktopAssetNames(version);
    const desktopNames = Object.values(desktopAssets);
    const hashes = new Map(names.map(name => [name, sha256(files[name]!)]));
    const assets = Object.entries(desktopAssets).map(([target, name]) => ({ target, name, sha256: hashes.get(name)! }));
    const sources = names.filter(name => !desktopNames.includes(name)).map(name => ({ name, sha256: hashes.get(name)! }));
    const checksums = names.sort().map(name => `${hashes.get(name)!}  ${name}\n`).join('');
    return { assets, sources, checksums };
}
async function collect(directory: string): Promise<string[]> {
    const result: string[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink())
            throw Error('Release staging cannot contain symlinks');
        const path = join(directory, entry.name);
        if (entry.isDirectory())
            result.push(...await collect(path));
        else if (entry.isFile())
            result.push(path);
    }
    return result;
}
export async function assembleCandidate(input: string, output: string, version: string, commit: string, run: string) {
    releaseIdentity(version, commit);
    const paths = await collect(input);
    const files: Record<string, Buffer> = {};
    for (const name of payloadNames(version)) {
        const matching = paths.filter(path => path.endsWith(`/${name}`));
        if (matching.length !== 1)
            throw Error(`Missing or duplicate asset ${name}`);
        files[name] = await readFile(matching[0]!);
    }
    const descriptor = execFileSync('tar', ['-xOf', paths.find(path => path.endsWith(`/placekeeper-source-v${version}.tar.gz`))!, 'placekeeper-source/release-descriptor.txt'], { encoding: 'utf8' });
    if (descriptor !== releaseIdentity(version, commit).descriptor)
        throw Error('Source archive provenance mismatch');
    const result = verifyReleaseFiles(files, version);
    const records = await Promise.all(paths.filter(path => path.endsWith('/build-result.json')).map(async (path) => JSON.parse(await readFile(path, 'utf8'))));
    if (records.length !== 4)
        throw Error('All four successful native build results required');
    for (const asset of result.assets) {
        const matches = records.filter(record => record.target === asset.target);
        if (matches.length !== 1
            || matches[0].status !== 'passed'
            || matches[0].version !== version
            || matches[0].commit !== commit
            || matches[0].candidateRun !== run
            || matches[0].name !== asset.name
            || matches[0].sha256 !== asset.sha256)
            throw Error(`Native build provenance mismatch: ${asset.target}`);
    }
    await mkdir(output, { recursive: true });
    for (const [name, data] of Object.entries(files))
        await writeFile(join(output, name), data, { flag: 'wx' });
    await writeFile(join(output, 'SHA256SUMS'), result.checksums, { flag: 'wx' });
    const provenance = buildProvenance(version, commit, run, result.assets, result.sources);
    await writeFile(join(output, 'desktop-build-provenance.json'), JSON.stringify(provenance, null, 2) + '\n', { flag: 'wx' });
    return provenance;
}
const repository = 'brad-ross/placekeeper';
function gh(args: string[]): string {
    return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}
interface Release {
    id: number;
    draft: boolean;
    prerelease: boolean;
    tag_name: string;
    target_commitish: string;
    assets: {
        id: number;
        name: string;
        size: number;
    }[];
}
function existingTag(tag: string): {
    sha: string;
    type: string;
} | undefined {
    try {
        return JSON.parse(gh(['api', `repos/${repository}/git/ref/tags/${tag}`])).object;
    }
    catch (error) {
        if (/HTTP 404/u.test(String((error as {
            stderr?: unknown;
        }).stderr)))
            return undefined;
        throw error;
    }
}
function release(tag: string): Release {
    const { databaseId } = JSON.parse(gh(['release', 'view', tag, '--repo', repository, '--json', 'databaseId']));
    return JSON.parse(gh(['api', `repos/${repository}/releases/${databaseId}`]));
}
export async function validateStagedDirectory(directory: string, provenance: BuildProvenance) {
    const names = await readdir(directory);
    if (names.length !== completeInventory(provenance.version).length || completeInventory(provenance.version).some(name => !names.includes(name)))
        throw Error('Draft inventory must contain exactly the complete release set');
    const files: Record<string, Buffer> = {};
    for (const name of payloadNames(provenance.version))
        files[name] = await readFile(join(directory, name));
    const result = verifyReleaseFiles(files, provenance.version);
    const descriptor = execFileSync('tar', ['-xOf', join(directory, `placekeeper-source-v${provenance.version}.tar.gz`), 'placekeeper-source/release-descriptor.txt'], { encoding: 'utf8' });
    if (descriptor !== releaseIdentity(provenance.version, provenance.commit).descriptor)
        throw Error('Source provenance changed');
    if (await readFile(join(directory, 'SHA256SUMS'), 'utf8') !== result.checksums)
        throw Error('Checksum inventory changed');
    const expected = buildProvenance(provenance.version, provenance.commit, provenance.candidateRun, result.assets, result.sources);
    assertCandidateBinding(provenance, expected);
    return result;
}

/** Build a correction without changing the original release tag or its other payloads. */
export async function prepareMacInstallerCorrection(original: string, candidate: string, output: string) {
    const originalProvenance = JSON.parse(await readFile(join(original, 'desktop-build-provenance.json'), 'utf8')) as BuildProvenance;
    const correctedProvenance = JSON.parse(await readFile(join(candidate, 'desktop-build-provenance.json'), 'utf8')) as BuildProvenance;
    if (originalProvenance.version !== correctedProvenance.version ||
        originalProvenance.commit === correctedProvenance.commit)
        throw Error('The correction must come from a new build of the same release version');
    await validateStagedDirectory(original, originalProvenance);
    await validateStagedDirectory(candidate, correctedProvenance);
    const corrected = correctedProvenance.assets.filter(asset => asset.target.startsWith('darwin-'));
    const payloads = [...originalProvenance.sources, ...originalProvenance.assets.filter(asset => !asset.target.startsWith('darwin-')), ...corrected];
    const checksums = payloads.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
        .map(asset => `${asset.sha256}  ${asset.name}\n`).join('');
    await mkdir(output, { recursive: true });
    for (const asset of corrected)
        await writeFile(join(output, asset.name), await readFile(join(candidate, asset.name)), { flag: 'wx' });
    await writeFile(join(output, 'SHA256SUMS'), checksums, { flag: 'wx' });
    await writeFile(join(output, 'macos-installer-correction.json'), JSON.stringify({
        schemaVersion: 1,
        version: correctedProvenance.version,
        originalCommit: originalProvenance.commit,
        commit: correctedProvenance.commit,
        candidateRun: correctedProvenance.candidateRun,
        assets: corrected,
    }, null, 2) + '\n', { flag: 'wx' });
}
export function assertCandidateBinding(provenance: BuildProvenance, original: BuildProvenance): void {
    const inventory = (value: BuildProvenance) => JSON.stringify({
        schemaVersion: value.schemaVersion,
        version: value.version,
        commit: value.commit,
        candidateRun: value.candidateRun,
        sources: [...value.sources].sort((a, b) => a.name.localeCompare(b.name)),
        assets: [...value.assets].sort((a, b) => a.target.localeCompare(b.target)),
    });
    if (inventory(provenance) !== inventory(original))
        throw Error('Build provenance belongs to different candidate bytes');
}
async function verifyRemoteInventory(draft: Release, directory: string, version: string) {
    const names = completeInventory(version);
    if (draft.assets.length !== names.length || names.some(name => draft.assets.filter(asset => asset.name === name).length !== 1))
        throw Error('Remote draft inventory differs');
    for (const name of names) {
        const asset = draft.assets.find(asset => asset.name === name)!;
        const bytes = execFileSync('gh', ['api', `repos/${repository}/releases/assets/${asset.id}`, '-H', 'Accept: application/octet-stream'], { maxBuffer: 256 * 1024 * 1024 });
        if (sha256(bytes) !== sha256(await readFile(join(directory, name))))
            throw Error(`Remote bytes differ: ${name}`);
    }
}
async function main() {
    const [operation, ...args] = process.argv.slice(2);
    if (operation === 'prepare-macos-correction') {
        const [original, candidate, correction] = args;
        if (args.length !== 3 || !original || !candidate || !correction)
            throw Error('Usage: desktop-release.ts prepare-macos-correction ORIGINAL CANDIDATE OUTPUT');
        await prepareMacInstallerCorrection(resolve(original), resolve(candidate), resolve(correction));
        return;
    }
    const [version, commit, run, input, output] = args;
    if (!operation || !version || !commit || !run || !input)
        throw Error('Usage: desktop-release.ts assemble|stage|publish VERSION COMMIT CANDIDATE_RUN INPUT [OUTPUT_OR_TRUSTED_CANDIDATE]');
    const identity = releaseIdentity(version, commit);
    if (operation === 'assemble') {
        if (!output)
            throw Error('Output required');
        await assembleCandidate(resolve(input), resolve(output), version, commit, run);
        return;
    }
    if (operation === 'stage') {
        const provenance = JSON.parse(await readFile(join(input, 'desktop-build-provenance.json'), 'utf8')) as BuildProvenance;
        if (provenance.version !== version || provenance.commit !== commit || provenance.candidateRun !== run)
            throw Error('Candidate identity mismatch');
        await validateStagedDirectory(input, provenance);
        if (existingTag(identity.tag))
            throw Error('Release tag already exists');
        gh(['release', 'create', identity.tag, '--repo', repository, '--target', commit, '--draft', '--title', `Placekeeper ${version} candidate`, '--notes', 'Hosted builds and packaged runtime tests passed on all four targets.']);
        gh(['release', 'upload', identity.tag, '--repo', repository, ...completeInventory(version).map(name => join(input, name))]);
        const draft = release(identity.tag);
        if (!draft.draft || draft.prerelease || draft.target_commitish !== commit)
            throw Error('Unexpected draft provenance');
        await verifyRemoteInventory(draft, input, version);
        return;
    }
    if (operation !== 'publish')
        throw Error('Unknown operation');
    if (!output)
        throw Error('Trusted candidate-run artifact directory required for publication');
    const notes = process.env.RELEASE_NOTES;
    if (!notes?.trim() || notes.length > 10000)
        throw Error('Reviewed release notes required');
    const tag = existingTag(identity.tag);
    if (tag && (tag.type !== 'commit' || tag.sha !== commit))
        throw Error('Candidate tag commit mismatch');
    const draft = release(identity.tag);
    if (!draft.draft || draft.prerelease || draft.target_commitish !== commit)
        throw Error('Only the exact unpublished candidate can be published');
    const provenance = JSON.parse(await readFile(join(input, 'desktop-build-provenance.json'), 'utf8')) as BuildProvenance;
    if (provenance.version !== version || provenance.commit !== commit || provenance.candidateRun !== run)
        throw Error('Stale build provenance');
    await validateStagedDirectory(input, provenance);
    const manifestAsset = draft.assets.find(asset => asset.name === 'desktop-build-provenance.json');
    if (!manifestAsset)
        throw Error('Missing candidate manifest');
    const original = JSON.parse(execFileSync('gh', ['api', `repos/${repository}/releases/assets/${manifestAsset.id}`, '-H', 'Accept: application/octet-stream'], { encoding: 'utf8' })) as BuildProvenance;
    const trusted = JSON.parse(await readFile(join(output, 'desktop-build-provenance.json'), 'utf8')) as BuildProvenance;
    assertCandidateBinding(provenance, trusted);
    assertCandidateBinding(original, trusted);
    const immutablePayloads = completeInventory(version);
    for (const name of immutablePayloads)
        if (sha256(await readFile(join(input, name))) !== sha256(await readFile(join(output, name))))
            throw Error(`Payload differs from trusted candidate workflow: ${name}`);
    for (const name of immutablePayloads) {
        const matches = draft.assets.filter(asset => asset.name === name);
        if (matches.length !== 1)
            throw Error('Incomplete remote draft');
        const remote = execFileSync('gh', ['api', `repos/${repository}/releases/assets/${matches[0]!.id}`, '-H', 'Accept: application/octet-stream'], { maxBuffer: 256 * 1024 * 1024 });
        if (sha256(remote) !== sha256(await readFile(join(input, name))))
            throw Error(`Changed remote payload ${name}`);
    }
    await verifyRemoteInventory(release(identity.tag), input, version);
    gh(['release', 'edit', identity.tag, '--repo', repository, '--draft=false', '--prerelease=false', '--latest', '--title', `Placekeeper ${version}`, '--notes', notes]);
    for (const name of completeInventory(version)) {
        const response = await fetch(`${identity.sourceUrl.slice(0, identity.sourceUrl.lastIndexOf('/') + 1)}${name}`);
        if (!response.ok || sha256(new Uint8Array(await response.arrayBuffer())) !== sha256(await readFile(join(input, name))))
            throw Error(`Anonymous public download verification failed: ${name}`);
    }
}
if (process.argv[1] && await realpath(process.argv[1]).catch(() => undefined) === await realpath(fileURLToPath(import.meta.url)))
    await main();
