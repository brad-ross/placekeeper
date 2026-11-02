import type { ElectronShellEvent } from '../../../../packages/core/src/electron-shell-protocol.js';
import type { PlacekeeperLinkLocation } from '../../../../packages/core/src/placekeeper-link.js';
/** Only the latest focused launch may publish visibility after shared navigation settles. */
export class FocusedLaunchNavigation {
    private currentToken?: string;
    private disposed = false;
    constructor(private readonly dependencies: {
        navigate(location: PlacekeeperLinkLocation, generation: number): Promise<void>;
        painted(): Promise<void>;
        visible(generation: number, token: string): Promise<void>;
        failed(token: string): Promise<void>;
    }) {}
    async apply(event: Extract<ElectronShellEvent, { type: 'confirm-visible' }>): Promise<void> {
        if (this.disposed) return;
        this.currentToken = event.token;
        const current = () => !this.disposed && this.currentToken === event.token;
        try {
            if (event.location) await this.dependencies.navigate(event.location, event.generation);
            if (!current()) return;
            await this.dependencies.painted();
            if (current()) await this.dependencies.visible(event.generation, event.token);
        } catch (error) {
            if (!current()) return;
            await this.dependencies.failed(event.token);
            throw error;
        }
    }
    dispose(): void { this.disposed = true; delete this.currentToken; }
}
