import { describe, expect, it } from 'vitest';
import { browserDownloadTarget, loadDownloads } from './downloads.js';
import { desktopAssetNames, RELEASE_REPOSITORY } from '../../../../packages/core/src/desktop-release.js';

export function releaseFixture(version = '1.2.3') {
  return { draft: false, prerelease: false, tag_name: `v${version}`, html_url: `${RELEASE_REPOSITORY}/releases/tag/v${version}`, assets: [...Object.values(desktopAssetNames(version)), 'SHA256SUMS'].map(name => ({ name, state: 'uploaded', size: 123, browser_download_url: `${RELEASE_REPOSITORY}/releases/download/v${version}/${name}` })) };
}
describe('website downloads', () => {
  it.each([
    ['Windows NT 10.0; Win64; x64', 'win32-x64'],
    ['Windows NT 10.0; WOW64', 'win32-x64'],
    ['Windows NT 10.0; x86_64', 'win32-x64'],
    ['Linux x86_64', 'linux-x64'],
  ])('selects a supported desktop target for %s', (userAgent, target) => {
    expect(browserDownloadTarget(userAgent)).toBe(target);
  });
  it.each(['Mozilla Macintosh Intel Mac OS X', 'Mozilla Mac OS X', 'Mozilla Macintosh ARM64'])('defaults Mac identity %s to Apple Silicon without claiming detected architecture', userAgent => {
    expect(browserDownloadTarget(userAgent)).toBe('darwin-arm64');
  });
  it('accepts an optional plain Mac platform hint', () => {
    expect(browserDownloadTarget('', { platform: 'MacIntel' })).toBe('darwin-arm64');
    expect(browserDownloadTarget('Mozilla Macintosh Intel Mac OS X', { platform: 'MacIntel', maxTouchPoints: 1 })).toBe('darwin-arm64');
  });
  it.each([
    'Mozilla iPad Macintosh',
    'Mozilla iPhone Mac OS X',
    'Linux Android x86_64',
    'Windows NT 10.0; Win64; Mobile',
    'CrOS x86_64',
    'Linux x86_64 CrOS',
    'Windows NT 10.0; Win64; ARM64',
    'Windows NT 10.0; x86_64; aarch64',
    'Linux aarch64',
    'Linux x86_64 ARMv7',
    'Linux x86_64 aarch64',
    'Windows NT 10.0; x86',
    'Linux i686',
    '',
    'Unknown desktop',
  ])('leaves unsupported or unidentified identity %s to the alternatives', userAgent => {
    expect(browserDownloadTarget(userAgent)).toBeUndefined();
  });
  it.each([
    ['Mozilla Macintosh Intel Mac OS X', { maxTouchPoints: 5 }],
    ['Mozilla', { platform: 'MacIntel', maxTouchPoints: 2 }],
    ['Mozilla iPad', { platform: 'MacIntel' }],
    ['Linux Android x86_64', { platform: 'MacIntel' }],
    ['Windows NT 10.0; Win64', { platform: 'ARM64' }],
    ['Linux x86_64', { platform: 'Linux aarch64' }],
    ['Mozilla', { platform: 'Linux x86_64' }],
  ])('uses optional hints without overriding device exclusions for %s', (userAgent, hints) => {
    expect(browserDownloadTarget(userAgent, hints)).toBeUndefined();
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
