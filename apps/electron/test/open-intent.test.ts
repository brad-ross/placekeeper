import { it, expect } from 'vitest';
import { parseDesktopOpenIntent, secondInstanceArguments, DesktopInvocationQueue } from '../src/open-intent.js';
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
it('opaque source navigation is exclusive and preserves exact second-instance arguments', () => {
    const ticket = 'n'.repeat(43);
    const argv = ['--placekeeper-navigation', ticket];
    expect(parseDesktopOpenIntent(argv)).toEqual({ type: 'navigation', ticket });
    expect(parseDesktopOpenIntent(secondInstanceArguments(['--placekeeper-navigation'], { argv }))).toEqual({ type: 'navigation', ticket });
    for (const args of [[...argv, '/paper.pdf'], [...argv, '--placekeeper-launch', 'a'.repeat(43)], [...argv, ...argv], ['--placekeeper-navigation'], ['--placekeeper-navigation', '/private/path']]) expect(() => parseDesktopOpenIntent(args)).toThrow();
});
it('canonical OS review links retain locations without accepting mixed launch authority', () => {
    const link = 'placekeeper:///Users/brad/paper.pdf#v=1&page=3';
    expect(parseDesktopOpenIntent([link])).toEqual({ type: 'link', link });
    expect(parseDesktopOpenIntent(secondInstanceArguments([], { argv: [link] }))).toEqual({ type: 'link', link });
    for (const args of [[link, '/other.pdf'], [link, link], [link, '--placekeeper-launch', 'a'.repeat(43)], [link, '--placekeeper-navigation', 'a'.repeat(43)], ['placekeeper://remote/paper.pdf'], ['placekeeper:///paper.pdf#v=1&page=0']]) expect(() => parseDesktopOpenIntent(args)).toThrow();
});

it('cold OS URL callbacks queue exact canonical links and warm callbacks route immediately', () => {
    const queue = new DesktopInvocationQueue();
    const cold = 'placekeeper:///cold.pdf#v=1&page=2', warm = 'placekeeper:///warm.pdf#v=1&page=3';
    queue.enqueue([cold]);
    const routed: string[][] = [];
    queue.activate(args => routed.push(args));
    expect(queue.take()).toEqual([[cold]]);
    queue.enqueue([warm]);
    expect(routed).toEqual([[warm]]);
    for (const invalid of ['https://host/paper.pdf', 'placekeeper://remote/paper.pdf', 'placekeeper:///paper.pdf#v=1&page=0']) expect(() => queue.enqueue([invalid])).toThrow();
    expect(routed).toEqual([[warm]]);
});
