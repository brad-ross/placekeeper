import { describe, expect, it } from 'vitest';
import { browserDownloadTarget, loadDownloads } from './downloads.js';
import { desktopAssetNames, RELEASE_REPOSITORY } from '../../../../packages/core/src/desktop-release.js';

export function releaseFixture(version = '1.2.3') {
  return { draft: false, prerelease: false, tag_name: `v${version}`, html_url: `${RELEASE_REPOSITORY}/releases/tag/v${version}`, assets: [...Object.values(desktopAssetNames(version)), 'SHA256SUMS'].map(name => ({ name, state: 'uploaded', size: 123, browser_download_url: `${RELEASE_REPOSITORY}/releases/download/v${version}/${name}` })) };
}
describe('website downloads', () => {
  it('never guesses Mac architecture or a mobile desktop target', () => {
    expect(browserDownloadTarget('Mozilla Macintosh Intel Mac OS X')).toBeUndefined();
    expect(browserDownloadTarget('Mozilla iPad Macintosh')).toBeUndefined();
    expect(browserDownloadTarget('Linux Android x86_64')).toBeUndefined();
    expect(browserDownloadTarget('Windows NT 10.0; Win64; x64')).toBe('win32-x64');
    expect(browserDownloadTarget('Linux x86_64')).toBe('linux-x64');
    expect(browserDownloadTarget('Linux aarch64')).toBeUndefined();
  });
  it('offers only a complete validated catalog', async () => {
    const result = await loadDownloads(async () => new Response(JSON.stringify(releaseFixture())));
    expect(result.status).toBe('available');
    if (result.status === 'available') expect(result.catalog.downloads['darwin-arm64'].url).toContain('v1.2.3/Placekeeper-1.2.3-macos-arm64.dmg');
  });
  it.each([{}, { ...releaseFixture('0.2.4'), assets: [] }, { ...releaseFixture(), assets: releaseFixture().assets.slice(1) }])('makes missing and source-only metadata explicitly unavailable', async release => {
    expect(await loadDownloads(async () => new Response(JSON.stringify(release)))).toEqual({ status: 'unavailable' });
  });
  it('reports failed and oversized responses as unavailable', async () => {
    expect(await loadDownloads(async () => { throw Error('offline'); })).toEqual({ status: 'unavailable' });
    expect(await loadDownloads(async () => new Response('x'.repeat(1024 * 1024 + 1)))).toEqual({ status: 'unavailable' });
  });
});
