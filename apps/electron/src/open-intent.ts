export type DesktopOpenIntent = { readonly type: 'paths'; readonly paths: readonly string[] } | { readonly type: 'launch'; readonly launchId: string };
/** Opaque task launches never accept native paths or proof material from argv. */
export function parseDesktopOpenIntent(args: readonly string[]): DesktopOpenIntent {
    const paths = args.filter(arg => arg.toLowerCase().endsWith('.pdf'));
    const indices = args.flatMap((arg, index) => arg === '--placekeeper-launch' ? [index] : []);
    if (!indices.length) return { type: 'paths', paths };
    const launchId = args[indices[0]! + 1];
    if (indices.length !== 1 || paths.length || typeof launchId !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(launchId)) throw new Error('Invalid desktop launch intent');
    return { type: 'launch', launchId };
}

/** Chromium can reorder second-instance switches and loose values. Prefer the
 * exact argument list supplied through Electron's separate structured channel.
 */
export function secondInstanceArguments(nativeArguments: unknown, additionalData: unknown): string[] {
    const record = additionalData !== null && typeof additionalData === 'object' && !Array.isArray(additionalData)
        ? additionalData as Record<string, unknown> : undefined;
    let args: unknown = nativeArguments;
    if (record && Object.keys(record).length > 0) {
        if (Object.keys(record).length !== 1 || !Object.hasOwn(record, 'argv')) throw new Error('Invalid desktop launch data');
        args = record.argv;
    } else if (additionalData !== undefined && !record) throw new Error('Invalid desktop launch data');
    if (!Array.isArray(args) || !args.every(value => typeof value === 'string')) throw new Error('Invalid desktop launch arguments');
    parseDesktopOpenIntent(args);
    return [...args];
}
