import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { desktopAssetNames } from '../packages/core/src/desktop-release.js';
import { releaseIdentity } from './package-source-release.js';
export interface Artifact {
    target: string;
    name: string;
    sha256: string;
}
export interface Evidence {
    scenario: string;
    status: string;
    category: string;
    reference: string;
    sha256: string;
    commit: string;
    candidateRun: string;
}
export interface SourceArtifact {
    name: string;
    sha256: string;
}
export interface Qualification {
    schemaVersion: number;
    version: string;
    commit: string;
    candidateRun: string;
    sources: SourceArtifact[];
    assets: (Artifact & {
        evidence: Evidence[];
    })[];
}
export function requiredScenarios(target: string): string[] {
    const common = [
        'fresh-install',
        'identical-reinstall',
        'accepted-upgrade',
        'declined-upgrade',
        'pending-writes',
        'failed-writes',
        'startup-failure-recovery',
        'uninstall-reinstall',
        'integration-repair',
        'downloaded-os-approval',
        'real-host-integrations',
    ];
    return [
        ...common,
        ...(target === 'darwin-arm64' ? ['legacy-service-migration', 'legacy-0.2.4-migration'] : []),
        ...(target === 'linux-x64' ? ['multiple-users', 'debian-remove-purge'] : []),
    ];
}
function expectedEvidenceCategory(scenario: string): string {
    if (['downloaded-os-approval', 'legacy-0.2.4-migration'].includes(scenario)) return 'interactive';
    if (scenario === 'real-host-integrations') return 'real-host';
    return 'automated';
}
export function validateArtifactInventory(assets: Artifact[], version: string): void {
    const expected = desktopAssetNames(version);
    if (assets.length !== 4)
        throw Error('Exactly four desktop assets required');
    for (const [target, name] of Object.entries(expected)) {
        const matches = assets.filter(asset => asset.target === target);
        if (matches.length !== 1 || matches[0]!.name !== name || !/^[a-f0-9]{64}$/u.test(matches[0]!.sha256))
            throw Error(`Invalid or duplicate asset: ${target}`);
    }
}
export function qualificationTemplate(version: string, commit: string, candidateRun: string, assets: Artifact[], sources: SourceArtifact[]): Qualification {
    releaseIdentity(version, commit);
    validateArtifactInventory(assets, version);
    if (sources.length !== 2 || [`placekeeper-source-v${version}.tar.gz`, 'install-placekeeper.sh'].some(name => sources.filter(source => source.name === name && /^[a-f0-9]{64}$/u.test(source.sha256)).length !== 1))
        throw Error('Exact source assets required');
    if (!/^\d+$/u.test(candidateRun))
        throw Error('Candidate workflow run required');
    return { schemaVersion: 1, version, commit, candidateRun, sources, assets: assets.map(asset => ({ ...asset, evidence: [] })) };
}
export function validateQualification(value: Qualification, assets: Artifact[], version: string, commit: string, candidateRun: string, sources: SourceArtifact[]): void {
    qualificationTemplate(version, commit, candidateRun, assets, sources);
    if (JSON.stringify([...value.sources].sort((a, b) => a.name.localeCompare(b.name))) !== JSON.stringify([...sources].sort((a, b) => a.name.localeCompare(b.name))))
        throw Error('Source payload hash mismatch');
    if (value.schemaVersion !== 1 || value.version !== version || value.commit !== commit || value.candidateRun !== candidateRun)
        throw Error('Stale qualification identity');
    validateArtifactInventory(value.assets, version);
    for (const asset of assets) {
        const approved = value.assets.find(entry => entry.target === asset.target)!;
        if (approved.sha256 !== asset.sha256)
            throw Error(`Changed artifact: ${asset.name}`);
        for (const scenario of requiredScenarios(asset.target)) {
            const evidence = approved.evidence.filter(entry => entry.scenario === scenario);
            const expectedCategory = expectedEvidenceCategory(scenario);
            if (evidence.length !== 1
                || evidence[0]!.status !== 'passed'
                || evidence[0]!.category !== expectedCategory
                || evidence[0]!.sha256 !== asset.sha256
                || evidence[0]!.commit !== commit
                || evidence[0]!.candidateRun !== candidateRun
                || !/^https:\/\/github\.com\/brad-ross\/placekeeper\/(?:actions\/runs\/\d+|issues\/\d+|pull\/\d+)(?:[/?#].*)?$/u.test(evidence[0]!.reference))
                throw Error(`Missing, stale or failed ${scenario} evidence for ${asset.target}`);
        }
    }
}
if (process.argv[1] && await realpath(process.argv[1]).catch(() => undefined) === await realpath(fileURLToPath(import.meta.url))) {
    const [manifest, inventory, version, commit, run] = process.argv.slice(2);
    if (!manifest || !inventory || !version || !commit || !run)
        throw Error('Usage: validate-desktop-qualification.ts MANIFEST INVENTORY VERSION COMMIT CANDIDATE_RUN');
    const expected = JSON.parse(await readFile(inventory, 'utf8'));
    validateQualification(JSON.parse(await readFile(manifest, 'utf8')), expected.assets, version, commit, run, expected.sources);
    console.log('Complete exact-artifact qualification passed');
}
