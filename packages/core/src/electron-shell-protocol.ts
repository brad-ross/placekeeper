import { decodePlacekeeperLinkFragment, encodePlacekeeperLinkFragment, type PlacekeeperLinkLocation } from './placekeeper-link.js';
import type { ReviewCommandSurfaceSnapshot, ReviewSemanticCommand } from '../../../apps/web/src/review/review-command-surface.js';
/** Renderer-safe capability surface. Native paths and recovery authority stay in main. */
export interface ElectronShellIdentity { readonly windowId: string; readonly attemptId: string }
export type ElectronShellEvent =
    | { readonly type: 'source-endpoint'; readonly token: string }
    | { readonly type: 'toolbar-hover'; readonly hovered: boolean }
    | { readonly type: 'command'; readonly id: ReviewSemanticCommand; readonly token: number; readonly revision: number }
    | { readonly type: 'confirm-visible'; readonly generation: number; readonly token: string; readonly location?: PlacekeeperLinkLocation }
    | { readonly type: 'settle-close'; readonly token: string };
export interface ElectronShellBridge {
    sourceEndpoint(identity: ElectronShellIdentity, token: string, endpoint: string | null): Promise<void>;
    identity(): Promise<ElectronShellIdentity & { readonly sourceEndpointToken?: string; readonly presentation?: { readonly pageIndex: number; readonly zoom: number } }>;
    request(identity: ElectronShellIdentity, message: unknown): Promise<unknown>;
    createLink(identity: ElectronShellIdentity, location: PlacekeeperLinkLocation): Promise<string>;
    focusFailed(identity: ElectronShellIdentity, token: string): Promise<void>;
    requestClose(identity: ElectronShellIdentity): Promise<void>;
    readyToSettle(identity: ElectronShellIdentity): Promise<void>;
    documentReady(identity: ElectronShellIdentity, generation: number): Promise<void>;
    visible(identity: ElectronShellIdentity, generation: number, token?: string): Promise<void>;
    commandSurface(identity: ElectronShellIdentity, revision: number, snapshot: ReviewCommandSurfaceSnapshot): Promise<void>;
    presentation(identity: ElectronShellIdentity, state: { readonly pageIndex: number; readonly zoom: number }): Promise<void>;
    toolbarHeight(identity: ElectronShellIdentity, height: number): Promise<void>;
    closeSettled(identity: ElectronShellIdentity, token: string, error?: string): Promise<void>;
    writeClipboard(identity: ElectronShellIdentity, text: string): Promise<void>;
    subscribeShell(listener: (message: ElectronShellEvent) => void): () => void;
    subscribe(listener: (message: unknown) => void): () => void;
}

/** Closed location data only: native paths and task proofs never cross this lane. */
export function parseElectronLocation(value: unknown): PlacekeeperLinkLocation | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['kind', 'page', 'itemId', 'mode', 'params'].includes(key))) return undefined;
    if (!['page', 'item', 'destination'].includes((value as { kind?: unknown }).kind as string)) return undefined;
    try { return decodePlacekeeperLinkFragment(encodePlacekeeperLinkFragment(value as PlacekeeperLinkLocation)); }
    catch { return undefined; }
}
