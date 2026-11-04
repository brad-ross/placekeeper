import { expect, it, vi } from 'vitest';
import { stageDesktopLink } from '../src/open-link.js';

const link = 'placekeeper:///paper.pdf#v=1&page=3';
const launchId = 'a'.repeat(43);
const receipt = { ok: true as const, kind: 'opened' as const, native: true as const, surface: 'electron' as const, launchId, sessionId: 'session123', documentGeneration: 1, bindProof: 'proof123', expiresAt: new Date(Date.now() + 10000).toISOString() };
it('OS links require explicit confirmation before receiving staged launch authority', async () => {
    const open = vi.fn(async () => receipt);
    const confirm = vi.fn(async () => true);
    expect(await stageDesktopLink(link, { preflight: async () => ({ ok: true, kind: 'link-preflight', path: '/paper.pdf', confirmationRequired: true }), confirm, open, recover: async () => undefined })).toBe(launchId);
    expect(confirm).toHaveBeenCalledWith('/paper.pdf');
    expect(open).toHaveBeenCalledWith({ link, desktop: 'electron', confirmed: true });
});
it('canceling confirmation never stages or opens a PDF', async () => {
    const open = vi.fn();
    expect(await stageDesktopLink(link, { preflight: async () => ({ ok: true, kind: 'link-preflight', path: '/paper.pdf', confirmationRequired: true }), confirm: async () => false, open, recover: async () => undefined })).toBeUndefined();
    expect(open).not.toHaveBeenCalled();
});
it('recovery retries carry the native offer fence and selected decision', async () => {
    const offer = { id: 'offer12345678', expiresAt: new Date(Date.now() + 10000).toISOString() };
    const open = vi.fn().mockResolvedValueOnce({ ok: true, kind: 'recovery-offered', recoverySessionId: 'recover123', choices: ['resume'], recoveryOffer: offer }).mockResolvedValueOnce(receipt);
    expect(await stageDesktopLink(link, { preflight: async () => ({ ok: true, kind: 'link-preflight', path: '/paper.pdf', confirmationRequired: false }), confirm: async () => true, open, recover: async () => 'resume' })).toBe(launchId);
    expect(open.mock.calls[1]?.[0]).toMatchObject({ desktop: 'electron', link, recovery: 'resume', recoveryOffer: offer, recoveryOperationId: expect.any(String) });
});
