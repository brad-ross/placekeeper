import { expect, it, vi } from 'vitest';
import { checkForDesktopUpdate, createManualUpdateAction, MAX_RELEASE_BYTES } from '../src/update-check.js';
import { ALL_DOWNLOADS_URL, desktopAssetNames, RELEASE_REPOSITORY } from '../../../packages/core/src/desktop-release.js';
function release(version = '0.3.0') { return { tag_name: `v${version}`, draft: false, prerelease: false, html_url: `${RELEASE_REPOSITORY}/releases/tag/v${version}`, assets: [...Object.values(desktopAssetNames(version)), 'SHA256SUMS'].map(name => ({ name, state: 'uploaded', size: 1024, browser_download_url: `${RELEASE_REPOSITORY}/releases/download/v${version}/${name}` })) }; }
function network(value: unknown = release(), status = 200) { return vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(value), { status })); }
it('distinguishes current, newer, installed ahead, and installed prerelease', async () => {
    for (const [installed, status] of [['0.3.0', 'current'], ['0.2.4', 'newer'], ['0.4.0', 'ahead'], ['0.3.0-rc.1', 'newer']] as const) {
        const fetcher = network();
        expect((await checkForDesktopUpdate(installed, fetcher)).status).toBe(status);
        expect(fetcher).toHaveBeenCalledOnce();
        expect(fetcher.mock.calls[0]![1]).toMatchObject({ redirect: 'error', credentials: 'omit' });
    }
});
it('reports offline, rate-limited, oversized, malformed, source-only and incomplete metadata as unavailable', async () => {
    const cases = [vi.fn<typeof fetch>().mockRejectedValue(new Error('offline')), network({}, 403), network({}, 429), network({}), network({ ...release(), assets: [] }), vi.fn<typeof fetch>().mockResolvedValue(new Response('{bad')), vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(MAX_RELEASE_BYTES + 1))), network({ ...release(), assets: release().assets.slice(1) })];
    for (const fetcher of cases) expect((await checkForDesktopUpdate('0.2.4', fetcher)).status).toBe('unavailable');
});
it('times out even when the network ignores abort', async () => {
    const fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}));
    expect((await checkForDesktopUpdate('0.2.4', fetcher, 5)).status).toBe('unavailable');
    expect((fetcher.mock.calls[0]![1]!.signal as AbortSignal).aborted).toBe(true);
});
it('does no work until invoked and opens the matching download only after user selection', async () => {
    const fetcher = network(), openExternal = vi.fn().mockResolvedValue(undefined), present = vi.fn().mockResolvedValue(0);
    const action = createManualUpdateAction({ installedVersion: '0.2.4', platform: 'darwin', architecture: 'arm64', fetcher, present, openExternal });
    expect(fetcher).not.toHaveBeenCalled(); expect(present).not.toHaveBeenCalled();
    await action(); expect(fetcher).toHaveBeenCalledOnce(); expect(openExternal).toHaveBeenCalledWith(`${RELEASE_REPOSITORY}/releases/download/v0.3.0/Placekeeper-0.3.0-macos-arm64.dmg`);
});
it('offers explicit architecture selection when target cannot be established', async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined), present = vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    await createManualUpdateAction({ installedVersion: '0.2.4', platform: 'darwin', architecture: undefined, fetcher: network(), present, openExternal })();
    expect(present.mock.calls[1]![0].buttons).toContain('macOS Intel');
    expect(openExternal).toHaveBeenCalledWith(expect.stringContaining('macos-x64.dmg'));
});
it('never navigates unsafe metadata and offers all-download access on unavailability', async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined), present = vi.fn().mockResolvedValue(1);
    await createManualUpdateAction({ installedVersion: '0.2.4', platform: 'win32', architecture: 'x64', fetcher: network({ ...release(), html_url: 'https://evil.example' }), present, openExternal })();
    expect(openExternal).toHaveBeenCalledWith(ALL_DOWNLOADS_URL);
});
it('reports navigation failures and does not leak rejected menu actions', async () => {
    const present = vi.fn().mockResolvedValue(0);
    await expect(createManualUpdateAction({ installedVersion: '0.2.4', platform: 'linux', architecture: 'x64', fetcher: network(), present, openExternal: vi.fn().mockRejectedValue(new Error('browser failed')) })()).resolves.toBeUndefined();
    expect(present).toHaveBeenCalledTimes(2);
});

it('cancels a stalled metadata body at the same bounded deadline', async () => {
    const cancel = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ cancel })));
    expect((await checkForDesktopUpdate('0.2.4', fetcher, 5)).status).toBe('unavailable');
    expect(cancel).toHaveBeenCalledOnce();
});

it('importing the updater and constructing an idle action make no background requests', async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);
    try {
        vi.resetModules();
        const updater = await import('../src/update-check.js');
        updater.createManualUpdateAction({ installedVersion: '0.3.0', platform: 'linux', architecture: 'x64', present: vi.fn(), openExternal: vi.fn() });
        await Promise.resolve();
        expect(fetcher).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
});
it('release notes require their own explicit user choice', async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    await createManualUpdateAction({ installedVersion: '0.2.4', platform: 'linux', architecture: 'x64', fetcher: network(), present: vi.fn().mockResolvedValue(1), openExternal })();
    expect(openExternal).toHaveBeenCalledWith(`${RELEASE_REPOSITORY}/releases/tag/v0.3.0`);
});

it('an uploading or empty installer makes a newer release unavailable', async () => {
    for (const invalid of [{ state: 'new' }, { size: 0 }]) {
        const metadata = release();
        Object.assign(metadata.assets[0]!, invalid);
        expect((await checkForDesktopUpdate('0.2.4', network(metadata))).status).toBe('unavailable');
    }
});
