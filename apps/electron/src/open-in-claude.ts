/** Claude Desktop's documented prefill deep link; the message is placed in a new chat, never sent. */
export const CLAUDE_NEW_CHAT_URL = 'claude://claude.ai/new?q=';
/** Claude truncates `q` near 14,000 characters; refuse well before that. */
export const MAX_CLAUDE_URL_LENGTH = 8000;
export const CLAUDE_OPEN_FAILURE = 'Claude Desktop could not be opened. Install Claude Desktop and set up the Placekeeper integration, then try again.';

const absolute = (path: string) => path.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(path) || /^\\\\[^\\]+\\[^\\]+/u.test(path);

/** The prefilled Claude prompt for a canonical local path, or undefined when the path cannot be expressed safely. */
export function claudeOpenPrompt(path: unknown): string | undefined {
    if (typeof path !== 'string' || path.length === 0 || path.includes('\0') || !absolute(path)) return undefined;
    // Windows paths cannot contain `"`, so ordinary paths stay verbatim (no doubled
    // backslashes). Anything a plain quote cannot delimit is sent as an explicit JSON string.
    if (!/["\u0000-\u001f\u007f\u2028\u2029]/u.test(path)) return `Open "${path}" in Placekeeper.`;
    return `Open the PDF at the absolute path given by this JSON string literal in Placekeeper: ${JSON.stringify(path)}`;
}

/** Builds `claude://claude.ai/new?q=…` from trusted main-process state only. */
export function claudeOpenUrl(path: unknown): string | undefined {
    const prompt = claudeOpenPrompt(path);
    if (prompt === undefined) return undefined;
    let url: string;
    try { url = CLAUDE_NEW_CHAT_URL + encodeURIComponent(prompt); } catch { return undefined; } // lone surrogates
    return url.length <= MAX_CLAUDE_URL_LENGTH ? url : undefined;
}

/** Main-process action: opens only URLs this module built, and reports failure without blocking. */
export function createOpenInClaude(options: { openExternal(url: string): Promise<void>; notify(message: string): void | Promise<unknown> }) {
    return async (sourcePath: string | undefined): Promise<boolean> => {
        const url = claudeOpenUrl(sourcePath);
        if (url === undefined) return false;
        try { await options.openExternal(url); return true; }
        catch { void Promise.resolve().then(() => options.notify(CLAUDE_OPEN_FAILURE)).catch(error => console.error('Claude failure notice unavailable', error)); return false; }
    };
}
