import { randomUUID } from 'node:crypto';
import { decodePlacekeeperLink } from '../../../packages/core/src/placekeeper-link.js';
import type { LinkLaunchResponse, LinkOpenRequest, LinkPreflightResponse } from '../../service/src/host/placekeeper-host.js';

/** The service retains path approval, recovery identities, and launch authority. */
export async function stageDesktopLink(link: string, actions: {
    preflight(link: string): Promise<LinkPreflightResponse>;
    confirm(path: string): Promise<boolean>;
    open(request: LinkOpenRequest): Promise<LinkLaunchResponse>;
    recover(offer: Extract<LinkLaunchResponse, { kind: 'recovery-offered' }>): Promise<'resume' | 'discard' | 'fork' | undefined>;
}): Promise<string | undefined> {
    decodePlacekeeperLink(link);
    const preflight = await actions.preflight(link);
    if (!preflight.ok) throw new Error(preflight.error.message);
    let confirmed = false;
    if (preflight.confirmationRequired) {
        if (!await actions.confirm(preflight.path)) return undefined;
        confirmed = true;
    }
    let request: LinkOpenRequest = { link, desktop: 'electron', ...(confirmed ? { confirmed: true } : {}) };
    for (let attempt = 0; attempt < 3; attempt++) {
        const response = await actions.open(request);
        if (!response.ok) throw new Error(response.error.message);
        if (response.kind === 'confirmation-required') {
            if (confirmed || !await actions.confirm(response.path)) return undefined;
            confirmed = true; request = { ...request, confirmed: true }; continue;
        }
        if (response.kind === 'recovery-offered') {
            const recovery = await actions.recover(response);
            if (!recovery) return undefined;
            request = { ...request, recovery, recoveryOffer: response.recoveryOffer, recoveryOperationId: randomUUID() };
            continue;
        }
        if (!('surface' in response) || response.surface !== 'electron' || !('launchId' in response) || !/^[A-Za-z0-9_-]{43}$/u.test(response.launchId)) throw new Error('Invalid desktop link launch');
        return response.launchId;
    }
    throw new Error('The Placekeeper link changed while opening. Try again.');
}
