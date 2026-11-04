import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopAssetNames } from '../packages/core/src/desktop-release.js';
import { releaseIdentity } from './package-source-release.js';
import { qualificationTemplate, validateQualification, type Artifact, type Qualification } from './validate-desktop-qualification.js';
export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export function payloadNames(version: string): string[] {
    return [...Object.values(desktopAssetNames(version)), `placekeeper-source-v${version}.tar.gz`, 'install-placekeeper.sh'];
}
export function completeInventory(version: string): string[] {
    return [...payloadNames(version), 'SHA256SUMS', 'desktop-qualification.json'];
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
            || matches[0].nativeQualificationRun !== run
            || matches[0].name !== asset.name
            || matches[0].sha256 !== asset.sha256)
            throw Error(`Native build provenance mismatch: ${asset.target}`);
    }
    await mkdir(output, { recursive: true });
    for (const [name, data] of Object.entries(files))
        await writeFile(join(output, name), data, { flag: 'wx' });
    await writeFile(join(output, 'SHA256SUMS'), result.checksums, { flag: 'wx' });
    const qualification = qualificationTemplate(version, commit, run, result.assets, result.sources);
    await writeFile(join(output, 'desktop-qualification.json'), JSON.stringify(qualification, null, 2) + '\n', { flag: 'wx' });
    return qualification;
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
    return JSON.parse(gh(['api', `repos/${repository}/releases/tags/${tag}`]));
}
export async function validateStagedDirectory(directory: string, qualification: Qualification) {
    const names = await readdir(directory);
    if (names.length !== completeInventory(qualification.version).length || completeInventory(qualification.version).some(name => !names.includes(name)))
        throw Error('Draft inventory must contain exactly the complete release set');
    const files: Record<string, Buffer> = {};
    for (const name of payloadNames(qualification.version))
        files[name] = await readFile(join(directory, name));
    const result = verifyReleaseFiles(files, qualification.version);
    const descriptor = execFileSync('tar', ['-xOf', join(directory, `placekeeper-source-v${qualification.version}.tar.gz`), 'placekeeper-source/release-descriptor.txt'], { encoding: 'utf8' });
    if (descriptor !== releaseIdentity(qualification.version, qualification.commit).descriptor)
        throw Error('Source provenance changed');
    if (await readFile(join(directory, 'SHA256SUMS'), 'utf8') !== result.checksums)
        throw Error('Checksum inventory changed');
    validateQualification(qualification, result.assets, qualification.version, qualification.commit, qualification.candidateRun, result.sources);
    return result;
}
export function assertCandidateBinding(qualification: Qualification, original: Qualification): void {
    const inventory = (value: Qualification) => JSON.stringify({
        schemaVersion: value.schemaVersion,
        version: value.version,
        commit: value.commit,
        candidateRun: value.candidateRun,
        sources: [...value.sources].sort((a, b) => a.name.localeCompare(b.name)),
        assets: value.assets.map(({ evidence, ...asset }) => asset).sort((a, b) => a.target.localeCompare(b.target)),
    });
    if (inventory(qualification) !== inventory(original))
        throw Error('Approval belongs to different candidate bytes');
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
    const [operation, version, commit, run, input, output] = process.argv.slice(2);
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
        const qualification = JSON.parse(await readFile(join(input, 'desktop-qualification.json'), 'utf8')) as Qualification;
        if (qualification.version !== version || qualification.commit !== commit || qualification.candidateRun !== run)
            throw Error('Candidate identity mismatch');
        if (existingTag(identity.tag))
            throw Error('Release tag already exists');
        gh(['release', 'create', identity.tag, '--repo', repository, '--target', commit, '--draft', '--title', `Placekeeper ${version} candidate`, '--notes', 'Unqualified candidate. Publication requires the complete exact-artifact lifecycle evidence.']);
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
    const qualification = JSON.parse(await readFile(join(input, 'desktop-qualification.json'), 'utf8')) as Qualification;
    if (qualification.version !== version || qualification.commit !== commit || qualification.candidateRun !== run)
        throw Error('Stale approval');
    await validateStagedDirectory(input, qualification);
    const manifestAsset = draft.assets.find(asset => asset.name === 'desktop-qualification.json');
    if (!manifestAsset)
        throw Error('Missing candidate manifest');
    const original = JSON.parse(execFileSync('gh', ['api', `repos/${repository}/releases/assets/${manifestAsset.id}`, '-H', 'Accept: application/octet-stream'], { encoding: 'utf8' })) as Qualification;
    const trusted = JSON.parse(await readFile(join(output, 'desktop-qualification.json'), 'utf8')) as Qualification;
    assertCandidateBinding(qualification, trusted);
    assertCandidateBinding(original, trusted);
    const immutablePayloads = payloadNames(version).concat('SHA256SUMS');
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
    gh(['release', 'upload', identity.tag, '--repo', repository, join(input, 'desktop-qualification.json'), '--clobber']);
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
