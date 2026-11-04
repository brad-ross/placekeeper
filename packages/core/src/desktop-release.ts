export const RELEASE_REPOSITORY = 'https://github.com/brad-ross/placekeeper';
export const RELEASE_API_URL = 'https://api.github.com/repos/brad-ross/placekeeper/releases/latest';
export const ALL_DOWNLOADS_URL = `${RELEASE_REPOSITORY}/releases/latest`;
export const DESKTOP_TARGETS = {
    'darwin-arm64': { label: 'macOS Apple Silicon', guidance: 'macOS on Apple Silicon; unsigned app approval may be required.' },
    'darwin-x64': { label: 'macOS Intel', guidance: 'macOS on Intel; unsigned app approval may be required.' },
    'win32-x64': { label: 'Windows x64', guidance: 'Windows x64; unsigned installer approval may be required.' },
    'linux-x64': { label: 'Ubuntu / Debian x64', guidance: 'Ubuntu or Debian x64 with deb package support.' },
} as const;
export type DesktopTarget = keyof typeof DESKTOP_TARGETS;
export interface DesktopReleaseCatalog {
    readonly schemaVersion: 1;
    readonly version: string;
    readonly notesUrl: string;
    readonly checksumsUrl: string;
    readonly downloads: Record<DesktopTarget, { readonly name: string; readonly url: string; readonly label: string; readonly guidance: string }>;
    readonly source: { readonly repositoryUrl: string; readonly shellUrl: string; readonly powershellUrl: string; readonly archiveUrl?: string };
}
function semver(value: string) {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
    if (!match || match[4]?.split('.').some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) throw new Error('Invalid semantic version');
    return { numbers: [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!)], prerelease: match[4]?.split('.') };
}
export function compareVersions(left: string, right: string): -1 | 0 | 1 {
    const a = semver(left), b = semver(right);
    for (let i = 0; i < 3; i++) if (a.numbers[i] !== b.numbers[i]) return a.numbers[i]! > b.numbers[i]! ? 1 : -1;
    if (!a.prerelease || !b.prerelease) return a.prerelease ? -1 : b.prerelease ? 1 : 0;
    for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
        const x = a.prerelease[i], y = b.prerelease[i];
        if (x === y) continue;
        if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
        const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
        if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1;
        if (xn !== yn) return xn ? -1 : 1;
        return x > y ? 1 : -1;
    }
    return 0;
}
export function desktopAssetNames(version: string): Record<DesktopTarget, string> {
    semver(version);
    return { 'darwin-arm64': `Placekeeper-${version}-macos-arm64.dmg`, 'darwin-x64': `Placekeeper-${version}-macos-x64.dmg`, 'win32-x64': `Placekeeper-${version}-windows-x64-Setup.exe`, 'linux-x64': `Placekeeper-${version}-linux-x64.deb` };
}
export function desktopTarget(platform: string, architecture: string | undefined): DesktopTarget | undefined {
    const target = `${platform}-${architecture}`;
    return Object.hasOwn(DESKTOP_TARGETS, target) ? target as DesktopTarget : undefined;
}
export function isSafeReleaseUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return url.origin === 'https://github.com' && !url.username && !url.password && !url.search && !url.hash && value === url.href && /^\/brad-ross\/placekeeper\/releases\/(?:latest|tag\/v[0-9A-Za-z.+-]+|download\/v[0-9A-Za-z.+-]+\/[0-9A-Za-z._-]+)$/.test(url.pathname);
    } catch { return false; }
}
export function parseDesktopRelease(value: unknown): DesktopReleaseCatalog {
    if (!value || typeof value !== 'object') throw new Error('Missing release metadata');
    const release = value as Record<string, unknown>;
    if (release.draft !== false || release.prerelease !== false || typeof release.tag_name !== 'string' || !release.tag_name.startsWith('v')) throw new Error('Not a published stable release');
    const version = release.tag_name.slice(1);
    if (semver(version).prerelease) throw new Error('Not a stable version');
    const notesUrl = `${RELEASE_REPOSITORY}/releases/tag/${release.tag_name}`;
    if (release.html_url !== notesUrl || !isSafeReleaseUrl(notesUrl) || !Array.isArray(release.assets)) throw new Error('Invalid release links');
    const assetUrl = (name: string): string => {
        const assets = (release.assets as Record<string, unknown>[]).filter(asset => asset && asset.name === name);
        const expected = `${RELEASE_REPOSITORY}/releases/download/${release.tag_name}/${name}`;
        const asset = assets[0];
        if (assets.length !== 1 || asset?.state !== 'uploaded' || typeof asset.size !== 'number' || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.browser_download_url !== expected || !isSafeReleaseUrl(expected)) throw new Error('Desktop release is incomplete or unsafe');
        return expected;
    };
    const names = desktopAssetNames(version);
    const downloads = Object.fromEntries((Object.keys(names) as DesktopTarget[]).map(target => [target, { name: names[target], url: assetUrl(names[target]), ...DESKTOP_TARGETS[target] }])) as DesktopReleaseCatalog['downloads'];
    const archiveName = `placekeeper-source-v${version}.tar.gz`;
    const archiveUrl = release.assets.some(asset => asset && typeof asset === 'object' && asset.name === archiveName) ? assetUrl(archiveName) : undefined;
    return { schemaVersion: 1, version, notesUrl, checksumsUrl: assetUrl('SHA256SUMS'), downloads, source: { repositoryUrl: RELEASE_REPOSITORY, shellUrl: `${RELEASE_REPOSITORY}/blob/${release.tag_name}/install.sh`, powershellUrl: `${RELEASE_REPOSITORY}/blob/${release.tag_name}/install.ps1`, ...(archiveUrl ? { archiveUrl } : {}) } };
}
