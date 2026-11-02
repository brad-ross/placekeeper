import { it, expect } from 'vitest';
import { parseDesktopOpenIntent, secondInstanceArguments } from '../src/open-intent.js';
it('opaque launches survive Chromium second-instance switch/value reordering through exact structured arguments', () => {
    const launchId = 'a'.repeat(43);
    const exact = ['--isolated-installed-smoke', '--http-port', '4200', '--isolated-test-root', '/isolated', '--placekeeper-launch', launchId];
    const reordered = ['--isolated-installed-smoke', '--http-port', '--isolated-test-root', '--placekeeper-launch', '4200', '/isolated', launchId];
    expect(() => parseDesktopOpenIntent(reordered)).toThrow('Invalid desktop launch intent');
    expect(parseDesktopOpenIntent(secondInstanceArguments(reordered, { argv: exact }))).toEqual({ type: 'launch', launchId });
});
it('structured arguments retain source and launch validation and reject malformed metadata', () => {
    const launchId = 'a'.repeat(43);
    expect(() => secondInstanceArguments([], { argv: ['--placekeeper-launch', launchId, '/paper.pdf'] })).toThrow();
    expect(() => secondInstanceArguments([], { argv: ['--placekeeper-launch', 'wrong'] })).toThrow();
    expect(() => secondInstanceArguments([], { argv: [null] })).toThrow();
    expect(() => secondInstanceArguments([], { argv: [], sourcePath: '/paper.pdf' })).toThrow();
    expect(parseDesktopOpenIntent(secondInstanceArguments(['/paper.pdf'], {}))).toEqual({ type: 'paths', paths: ['/paper.pdf'] });
    expect(() => secondInstanceArguments([null], undefined)).toThrow();
});
