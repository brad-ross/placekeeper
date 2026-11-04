import { describe, expect, it } from 'vitest';
import { compareVersions, desktopAssetNames, desktopTarget, parseDesktopRelease, RELEASE_REPOSITORY } from '../src/desktop-release.js';
export function releaseFixture(version = '0.3.0') {
    const tag = `v${version}`;
    return { tag_name: tag, draft: false, prerelease: false, html_url: `${RELEASE_REPOSITORY}/releases/tag/${tag}`, assets: [...Object.values(desktopAssetNames(version)), 'SHA256SUMS'].map(name => ({ name, state: 'uploaded', size: 1024, browser_download_url: `${RELEASE_REPOSITORY}/releases/download/${tag}/${name}` })) };
}
describe('desktop release catalog', () => {
    it('validates the complete catalog and target mapping', () => {
        const catalog = parseDesktopRelease(releaseFixture());
        expect(catalog.schemaVersion).toBe(1);
        expect(Object.keys(catalog.downloads)).toHaveLength(4);
        expect(catalog.downloads['win32-x64'].url).toContain('windows-x64-Setup.exe');
        expect(catalog.checksumsUrl).toContain('/v0.3.0/SHA256SUMS');
        expect(catalog.source.shellUrl).toContain('/blob/v0.3.0/install.sh');
        expect(catalog.source.archiveUrl).toBeUndefined();
        expect(desktopTarget('darwin', 'arm64')).toBe('darwin-arm64');
        expect(desktopTarget('linux', 'arm64')).toBeUndefined();
        expect(desktopTarget('darwin', undefined)).toBeUndefined();
    });
    it('exposes the source archive only when present with its verified public asset name', () => {
        const release = releaseFixture();
        const url = `${RELEASE_REPOSITORY}/releases/download/v0.3.0/placekeeper-source-v0.3.0.tar.gz`;
        release.assets.push({ name: 'placekeeper-source-v0.3.0.tar.gz', state: 'uploaded', size: 1024, browser_download_url: url });
        expect(parseDesktopRelease(release).source.archiveUrl).toBe(url);
        release.assets.at(-1)!.browser_download_url = 'https://evil.example/source';
        expect(() => parseDesktopRelease(release)).toThrow();
    });
    it('compares numeric versions and prerelease precedence', () => {
        expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
        expect(compareVersions('0.3.0', '0.3.0')).toBe(0);
        expect(compareVersions('0.3.0-rc.2', '0.3.0')).toBe(-1);
        expect(compareVersions('0.3.0-rc.10', '0.3.0-rc.2')).toBe(1);
        expect(compareVersions('0.3.0+build', '0.3.0')).toBe(0);
    });
    it('rejects historical source-only, incomplete, draft, prerelease and malformed releases', () => {
        for (const release of [{ ...releaseFixture(), assets: [] }, { ...releaseFixture(), assets: releaseFixture().assets.slice(1) }, { ...releaseFixture(), draft: true }, { ...releaseFixture(), prerelease: true }, { ...releaseFixture(), tag_name: 'vbad' }, releaseFixture('0.3.0-rc.1')]) expect(() => parseDesktopRelease(release)).toThrow();
    });
    it('rejects required assets that are not uploaded nonempty files', () => {
        for (const name of [...Object.values(desktopAssetNames('0.3.0')), 'SHA256SUMS']) {
            for (const invalid of [{ state: 'new' }, { state: undefined }, { size: 0 }, { size: -1 }, { size: 1.5 }, { size: Number.MAX_SAFE_INTEGER + 1 }, { size: '1024' }, { size: undefined }]) {
                const release = releaseFixture();
                Object.assign(release.assets.find(asset => asset.name === name)!, invalid);
                expect(() => parseDesktopRelease(release)).toThrow();
            }
        }
    });
    it('rejects unsafe notes and asset URLs, duplicate assets and credentials', () => {
        for (const url of ['https://evil.example/file', 'http://github.com/brad-ross/placekeeper/releases/tag/v0.3.0', `${RELEASE_REPOSITORY}/releases/tag/v0.3.0?redirect=evil`, 'https://user@github.com/brad-ross/placekeeper/releases/tag/v0.3.0']) expect(() => parseDesktopRelease({ ...releaseFixture(), html_url: url })).toThrow();
        const release = releaseFixture(); release.assets[0]!.browser_download_url = 'https://evil.example/installer';
        expect(() => parseDesktopRelease(release)).toThrow();
        const duplicate = releaseFixture(); duplicate.assets.push(duplicate.assets[0]!);
        expect(() => parseDesktopRelease(duplicate)).toThrow();
    });
});
