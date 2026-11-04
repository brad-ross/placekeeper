import { expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ app: {}, BrowserWindow: class {}, dialog: {}, ipcMain: {}, session: {} }));
import { parseStandaloneChooser, acceptsStandaloneEndpoint } from '../src/standalone-chooser.js';

it('standalone chooser accepts only exact closed user-selection intents', () => {
    expect(parseStandaloneChooser(['--placekeeper-choose', 'folder', '/project'])).toEqual({ kind: 'folder', start: '/project' });
    expect(parseStandaloneChooser(['--placekeeper-choose', 'pdf', '/project'])).toEqual({ kind: 'pdf', start: '/project' });
    expect(parseStandaloneChooser(['--placekeeper-choose', 'endpoint'])).toEqual({ kind: 'endpoint' });
    expect(parseStandaloneChooser(['/paper.pdf'])).toBeUndefined();
    for (const args of [['--placekeeper-choose', 'folder', 'relative'], ['--placekeeper-choose', 'endpoint', '/root'], ['--placekeeper-choose', 'shell', '/root'], ['--placekeeper-choose', 'pdf', '/root', '--placekeeper-launch', 'a'.repeat(43)]]) expect(() => parseStandaloneChooser(args)).toThrow();
});

it('endpoint chooser accepts only its exact current main frame, identity and token', () => {
    const frame = {}, identity = { windowId: 'window123', attemptId: 'attempt123' };
    const binding = { frame, ...identity, token: 'token123' };
    expect(acceptsStandaloneEndpoint(binding, frame, identity, 'token123', '\\\\.\\pipe\\nvim')).toBe(true);
    expect(acceptsStandaloneEndpoint(binding, frame, identity, 'token123', null)).toBe(true);
    for (const [source, id, token, endpoint] of [[{}, identity, 'token123', '/socket'], [frame, { ...identity, attemptId: 'old' }, 'token123', '/socket'], [frame, identity, 'old', '/socket'], [frame, identity, 'token123', 'x'.repeat(4097)], [frame, identity, 'token123', '']]) expect(acceptsStandaloneEndpoint(binding, source, id, token, endpoint)).toBe(false);
});
