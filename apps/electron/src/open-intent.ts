import { decodePlacekeeperLink } from '../../../packages/core/src/placekeeper-link.js';
export type DesktopOpenIntent = { readonly type: 'paths'; readonly paths: readonly string[] } | { readonly type: 'launch'; readonly launchId: string } | { readonly type: 'navigation'; readonly ticket: string } | { readonly type: 'link'; readonly link: string };
/** Opaque task launches never accept native paths or proof material from argv. */
export function parseDesktopOpenIntent(args: readonly string[]): DesktopOpenIntent {
    if (args.some(arg => /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(arg) && !/^placekeeper:/u.test(arg))) throw new Error('Unsupported desktop URL scheme');
    const links = args.filter(arg => /^placekeeper:/iu.test(arg));
    const paths = args.filter(arg => !/^placekeeper:/iu.test(arg) && arg.toLowerCase().endsWith('.pdf'));
    const indices = args.flatMap((arg, index) => arg === '--placekeeper-launch' ? [index] : []);
    const navigation = args.flatMap((arg, index) => arg === '--placekeeper-navigation' ? [index] : []);
    if (links.length) {
        if (links.length !== 1 || paths.length || indices.length || navigation.length) throw new Error('Invalid desktop link intent');
        decodePlacekeeperLink(links[0]!);
        return { type: 'link', link: links[0]! };
    }
    if (navigation.length) {
        const ticket = args[navigation[0]! + 1];
        if (navigation.length !== 1 || indices.length || paths.length || typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(ticket)) throw new Error('Invalid desktop navigation intent');
        return { type: 'navigation', ticket };
    }
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

/** OS callbacks can arrive before runtime registration; preserve their exact args. */
export class DesktopInvocationQueue {
    private readonly pending: string[][] = [];
    private route?: (args: string[]) => void;
    enqueue(args: readonly string[]): void {
        parseDesktopOpenIntent(args);
        if (this.route) this.route([...args]); else this.pending.push([...args]);
    }
    activate(route: (args: string[]) => void): void { this.route = route; }
    take(): string[][] { return this.pending.splice(0); }
}
