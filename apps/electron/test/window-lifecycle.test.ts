import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it as test, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import { alignNativeWindowButtons, trackTitlebarHover } from '../src/titlebar.js';
import { DocumentWindowRegistry } from '../src/window-registry.js';
import { parseWindowState } from '../src/window-state.js';
test('native toolbar hover follows scaled window bounds without DOM movement and stops sampling on blur or retirement', () => {
    vi.useFakeTimers();
    let point = { x: 500, y: 200 };
    let scale = 1;
    let focused = true;
    let destroyed = false;
    const cursor = vi.fn(() => point);
    const send = vi.fn<(channel: string, message: { type: string; hovered: boolean }) => void>();
    const contents = Object.assign(new EventEmitter(), { send, isDestroyed: () => destroyed, getZoomFactor: () => scale });
    const window = Object.assign(new EventEmitter(), {
        webContents: contents, isFocused: () => focused, isVisible: () => true, isMinimized: () => false,
        getContentBounds: () => ({ x: 100, y: 100, width: 800, height: 600 }),
    });
    const dispose = trackTitlebarHover(window as unknown as BrowserWindow, cursor);
    try {
        assert.deepEqual(send.mock.lastCall, ['review:shell', { type: 'toolbar-hover', hovered: false }]);
        point = { x: 500, y: 125 };
        vi.advanceTimersByTime(50);
        assert.deepEqual(send.mock.lastCall, ['review:shell', { type: 'toolbar-hover', hovered: true }]);
        vi.advanceTimersByTime(1000);
        assert.equal(send.mock.calls.length, 2);
        point.y = 180;
        vi.advanceTimersByTime(50);
        assert.equal(send.mock.lastCall![1].hovered, false);
        scale = 2;
        vi.advanceTimersByTime(50);
        assert.equal(send.mock.lastCall![1].hovered, true);
        focused = false; window.emit('blur');
        assert.equal(send.mock.lastCall![1].hovered, false);
        const samples = cursor.mock.calls.length;
        vi.advanceTimersByTime(1000);
        assert.equal(cursor.mock.calls.length, samples);
        focused = true; window.emit('focus');
        assert.equal(send.mock.lastCall![1].hovered, true);
        destroyed = true; dispose();
        const retiredSamples = cursor.mock.calls.length;
        window.emit('focus'); contents.emit('did-finish-load');
        vi.advanceTimersByTime(1000);
        assert.equal(cursor.mock.calls.length, retiredSamples);
    } finally { dispose(); vi.useRealTimers(); }
});
test('concurrent duplicate and alias opens focus one window while distinct documents remain independent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'electron-windows-'));
    try {
        await writeFile(join(root, 'a.pdf'), 'a'); await writeFile(join(root, 'b.pdf'), 'b');
        await symlink(join(root, 'a.pdf'), join(root, 'alias.pdf'));
        const registry = new DocumentWindowRegistry<{ id: number; page: number }>();
        let created = 0; let focused = 0;
        const create = async () => ({ id: ++created, page: 4 });
        const focus = () => { focused++; };
        const [a, alias, b] = await Promise.all([registry.open(join(root, 'a.pdf'), create, focus), registry.open(join(root, 'alias.pdf'), create, focus), registry.open(join(root, 'b.pdf'), create, focus)]);
        assert.equal(a, alias); assert.notEqual(a, b); assert.equal(a.page, 4); assert.equal(created, 2); assert.equal(focused, 1);
        registry.remove(a); await Promise.resolve();
        assert.notEqual(await registry.open(join(root, 'a.pdf'), create, focus), a);
    } finally { await rm(root, { recursive: true, force: true }); }
});
test('restoration retains only native intent, geometry and bounded presentation', () => {
    const [state] = parseWindowState([{ sourcePath: '/paper.pdf', bounds: { width: 10, height: 900, x: 4 }, maximized: true, presentation: { pageIndex: 3, zoom: 1.5, capability: 'secret' }, sessionId: 'secret', attemptId: 'secret' }]);
    assert.deepEqual(state, { sourcePath: '/paper.pdf', bounds: { width: 600, height: 900, x: 4 }, maximized: true, presentation: { pageIndex: 3, zoom: 1.5 } });
    assert.deepEqual(parseWindowState([{ sourcePath: '/paper.pdf', bounds: { width: NaN, height: 500 } }]), []);
});
import { parseDesktopOpenIntent } from '../src/open-intent.js';
test('task invocation accepts one opaque id and rejects mixed native path or repeated launch authority', () => {
    const id = 'a'.repeat(43);
    assert.deepEqual(parseDesktopOpenIntent(['--placekeeper-launch', id]), { type: 'launch', launchId: id });
    assert.throws(() => parseDesktopOpenIntent(['--placekeeper-launch', id, '/a.pdf']));
    assert.throws(() => parseDesktopOpenIntent(['--placekeeper-launch', id, '--placekeeper-launch', id]));
    assert.throws(() => parseDesktopOpenIntent(['--placekeeper-launch']));
});

import { WindowActivityRegistry } from '../src/window-lifecycle.js';
import { NativeAppLifecycleManager } from '../../service/src/desktop/app-lifecycle.js';
test('opening-window activity remains valid when helper attachment wins the lifecycle-pipe race', async () => {
    const appInstanceId = 'app_instance_1234';
    const manager = new NativeAppLifecycleManager({ detach: async () => undefined });
    await manager.handle({ protocolVersion: 1, type: 'register-app', appInstanceId, processId: 123, startIdentity: 'start_12345678', buildIdentity: 'build_12345678' });
    const windows = new WindowActivityRegistry();
    windows.register('helper_12345678');
    // Direct admission arrives first; the buffered lifecycle activity follows it.
    assert.equal(manager.attachHelper(appInstanceId, 'helper_12345678'), true);
    assert.equal((await manager.handle({ protocolVersion: 1, type: 'activity', appInstanceId, ...windows.snapshot() })).type, 'ack');
    assert.deepEqual(manager.activity(), { appInstances: 1, registeredWindows: 1, bootstrappingWindows: 1 });
});
test('closing one of two windows retains ownership until its native detach acknowledgement', async () => {
    const appInstanceId = 'app_instance_1234';
    let acknowledge!: () => void;
    let enteredDetach!: () => void;
    const detachEntered = new Promise<void>(resolve => { enteredDetach = resolve; });
    const manager = new NativeAppLifecycleManager({ detach: () => new Promise(resolve => { acknowledge = resolve; enteredDetach(); }) });
    await manager.handle({ protocolVersion: 1, type: 'register-app', appInstanceId, processId: 123, startIdentity: 'start_12345678', buildIdentity: 'build_12345678' });
    const windows = new WindowActivityRegistry();
    for (const helper of ['helper_12345678', 'helper_abcdefgh']) { windows.register(helper); manager.attachHelper(appInstanceId, helper); windows.activated(helper); }
    windows.retiring('helper_12345678');
    assert.deepEqual(windows.snapshot(), { activeWindows: 2, bootstrappingWindows: 0 });
    // A delayed close activity frame is still safe before the detach route runs.
    assert.equal((await manager.handle({ protocolVersion: 1, type: 'activity', appInstanceId, ...windows.snapshot() })).type, 'ack');
    const detach = manager.handle({ protocolVersion: 1, type: 'detach-helper', appInstanceId, helperId: 'helper_12345678' });
    assert.equal(windows.snapshot().activeWindows, 2);
    await detachEntered; acknowledge(); assert.equal((await detach).type, 'ack'); windows.detached('helper_12345678');
    assert.equal((await manager.handle({ protocolVersion: 1, type: 'activity', appInstanceId, ...windows.snapshot() })).type, 'ack');
    assert.deepEqual(manager.activity(), { appInstances: 1, registeredWindows: 1, bootstrappingWindows: 0 });
    assert.equal(manager.ownsHelper(appInstanceId, 'helper_abcdefgh'), true);
});

import { ActivityAcknowledgements } from '../src/window-lifecycle.js';
test('concurrent window admissions cannot overtake lower queued activity snapshots', async () => {
    const appInstanceId = 'app_instance_1234';
    const manager = new NativeAppLifecycleManager({ detach: async () => undefined });
    await manager.handle({ protocolVersion: 1, type: 'register-app', appInstanceId, processId: 123, startIdentity: 'start_12345678', buildIdentity: 'build_12345678' });
    const windows = new WindowActivityRegistry();
    const acknowledgements = new ActivityAcknowledgements();
    const frames: Array<{ activeWindows: number; bootstrappingWindows: number }> = [];
    windows.register('helper_12345678');
    const first = acknowledgements.enqueue(() => frames.push(windows.snapshot())).then(() => manager.attachHelper(appInstanceId, 'helper_12345678'));
    windows.register('helper_abcdefgh');
    let secondAdmitted = false;
    const second = acknowledgements.enqueue(() => frames.push(windows.snapshot())).then(() => { secondAdmitted = true; return manager.attachHelper(appInstanceId, 'helper_abcdefgh'); });
    assert.equal(secondAdmitted, false);
    for (const frame of frames) {
        assert.equal((await manager.handle({ protocolVersion: 1, type: 'activity', appInstanceId, ...frame })).type, 'ack');
        acknowledgements.acknowledge(); await Promise.resolve();
    }
    assert.equal(await first, true); assert.equal(await second, true);
    assert.equal(manager.activity().registeredWindows, 2);
});
test('lifecycle EOF rejects all queued activity barriers and future admissions', async () => {
    const acknowledgements = new ActivityAcknowledgements();
    const first = acknowledgements.enqueue(() => {});
    const second = acknowledgements.enqueue(() => {});
    const failures = Promise.all([assert.rejects(first, /channel ended/), assert.rejects(second, /channel ended/)]);
    acknowledgements.fail(new Error('channel ended'));
    await failures;
    await assert.rejects(acknowledgements.enqueue(() => {}), /channel ended/);
});

test('native buttons align to the measured toolbar height and interface scale', () => {
    const positions: unknown[] = [];
    const window = { isDestroyed: () => false, webContents: { getZoomFactor: () => 1.25 },
        getWindowButtonPosition: () => positions.at(-1),
        setWindowButtonPosition: (position: unknown) => positions.push(position) };
    alignNativeWindowButtons(window as unknown as BrowserWindow, 52, 'darwin');
    alignNativeWindowButtons(window as unknown as BrowserWindow, 52, 'darwin');
    alignNativeWindowButtons(window as unknown as BrowserWindow, 60, 'darwin');
    alignNativeWindowButtons(window as unknown as BrowserWindow, 60, 'darwin');
    assert.deepEqual(positions, [{ x: 20, y: 26 }, { x: 20, y: 31 }]);
});
