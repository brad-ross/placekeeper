/** Renderer-safe capability surface. No paths, admission, recovery or raw IPC. */
export interface ElectronShellIdentity {
    readonly windowId: string;
    readonly attemptId: string;
}
export interface ElectronShellBridge {
    identity(): Promise<ElectronShellIdentity>;
    request(identity: ElectronShellIdentity, message: unknown): Promise<unknown>;
    documentReady(identity: ElectronShellIdentity, generation: number): Promise<void>;
    visible(identity: ElectronShellIdentity, generation: number): Promise<void>;
    subscribe(listener: (message: unknown) => void): () => void;
}
