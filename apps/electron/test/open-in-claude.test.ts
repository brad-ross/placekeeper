import { describe, expect, it, vi } from 'vitest';
import { CLAUDE_OPEN_FAILURE, MAX_CLAUDE_URL_LENGTH, claudeOpenPrompt, claudeOpenUrl, createOpenInClaude } from '../src/open-in-claude.js';
const prefix = 'claude://claude.ai/new?q=';
const decoded = (url: string | undefined) => { expect(url?.startsWith(prefix)).toBe(true); return decodeURIComponent(url!.slice(prefix.length)); };
describe('claudeOpenUrl', () => {
    it('prefills a short quoted prompt with the exact path', () => {
        expect(claudeOpenUrl('/Users/a/paper.pdf')).toBe(prefix + 'Open%20%22%2FUsers%2Fa%2Fpaper.pdf%22%20in%20Placekeeper.');
    });
    it('encodes spaces, #, %, &, +, ? and non-ASCII so the query carries the whole prompt', () => {
        const path = '/Users/a/My Papers #1/100% & more+?=é 論文.pdf';
        const url = claudeOpenUrl(path)!;
        expect(url.slice(prefix.length)).not.toMatch(/[ #&?=+%](?![0-9A-F]{2})/u);
        expect(new URL(url).searchParams.get('q')).toBe(`Open "${path}" in Placekeeper.`);
        expect(decoded(url)).toBe(`Open "${path}" in Placekeeper.`);
    });
    it('keeps Windows drive and UNC backslash paths verbatim', () => {
        expect(decoded(claudeOpenUrl('C:\\Users\\a\\doc.pdf'))).toBe('Open "C:\\Users\\a\\doc.pdf" in Placekeeper.');
        expect(decoded(claudeOpenUrl('D:/x/doc.pdf'))).toBe('Open "D:/x/doc.pdf" in Placekeeper.');
        expect(decoded(claudeOpenUrl('\\\\server\\share\\doc.pdf'))).toBe('Open "\\\\server\\share\\doc.pdf" in Placekeeper.');
    });
    it('switches to an explicit JSON string when a quote or control character would break plain quoting', () => {
        const path = '/tmp/say "hi"\\\n.pdf';
        const prompt = claudeOpenPrompt(path)!;
        expect(decoded(claudeOpenUrl(path))).toBe(prompt);
        const literal = prompt.slice(prompt.indexOf(': ') + 2);
        expect(JSON.parse(literal)).toBe(path);
        expect(prompt).toContain('JSON string literal');
    });
    it('refuses relative, drive-relative, empty, NUL, non-string and lone-surrogate paths', () => {
        for (const value of ['paper.pdf', './paper.pdf', 'C:paper.pdf', '\\paper.pdf', '', '/a\0b.pdf', undefined, 42, '/bad\uD800.pdf'])
            expect(claudeOpenUrl(value)).toBeUndefined();
    });
    it('refuses URLs longer than the safe limit', () => {
        const fits = '/' + 'a'.repeat(MAX_CLAUDE_URL_LENGTH - (prefix.length + 'Open%20%22%2F%22%20in%20Placekeeper.'.length));
        expect(claudeOpenUrl(fits)).toHaveLength(MAX_CLAUDE_URL_LENGTH);
        expect(claudeOpenUrl(fits + 'a')).toBeUndefined();
        expect(claudeOpenUrl('/' + 'é'.repeat(2000))).toBeUndefined();
    });
});
describe('createOpenInClaude', () => {
    it('opens only the built deep link', async () => {
        const openExternal = vi.fn(async () => {}), notify = vi.fn();
        const action = createOpenInClaude({ openExternal, notify });
        await expect(action('/a/b.pdf')).resolves.toBe(true);
        expect(openExternal).toHaveBeenCalledWith(claudeOpenUrl('/a/b.pdf'));
        await expect(action('https://evil.example/')).resolves.toBe(false);
        await expect(action(undefined)).resolves.toBe(false);
        expect(openExternal).toHaveBeenCalledOnce(); expect(notify).not.toHaveBeenCalled();
    });
    it('shows the install notice when no claude:// handler exists', async () => {
        const notify = vi.fn(async () => { throw new Error('dialog closed'); });
        const action = createOpenInClaude({ openExternal: async () => { throw new Error('No application is registered'); }, notify });
        await expect(action('/a/b.pdf')).resolves.toBe(false);
        await vi.waitFor(() => expect(notify).toHaveBeenCalledWith(CLAUDE_OPEN_FAILURE));
    });
});
