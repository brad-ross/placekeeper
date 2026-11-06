import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { InstalledCandidate } from './electron-installed-harness.js';
import { requestControl } from '../../apps/service/src/host/launch-control.js';
import { decodePlacekeeperLink, encodePlacekeeperLink } from '../../packages/core/src/placekeeper-link.js';

test('focused native links settle in the existing reader before task activation without showing copy-link controls', async () => {
    test.setTimeout(90_000);
    const candidate = await InstalledCandidate.create('reference-navigation.pdf');
    const socket = join(candidate.root, 'control.sock');
    let cleanupTaskSessionId: string | undefined;
    let launchId: string | undefined;
    let primaryFailed = false;
    try {
        const page = await candidate.launch();
        await expect(page.locator('[data-production-review]')).toHaveAttribute('data-initial-view-ready', 'true', { timeout: 30_000 });
        await expect.poll(() => candidate.timings().some(event => event.stage === 'visible-active')).toBe(true);
        const identity = await page.evaluate(() => window.placekeeper.identity());
        const location = { kind: 'page', page: 3 } as const;
        const staged = await requestControl(socket, { kind: 'link-open', request: {
            link: encodePlacekeeperLink({ path: candidate.source, location }), confirmed: true, desktop: 'electron',
        } });
        if (staged.kind !== 'link-open' || !staged.response.ok || !('launchId' in staged.response)) throw new Error('Expected an opaque native link launch');
        const receipt = staged.response;
        launchId = receipt.launchId;
        const taskSessionId = `focused-link-${randomUUID()}`;
        cleanupTaskSessionId = taskSessionId;
        expect(await requestControl(socket, { kind: 'claim-binding', native: true, taskSessionId,
            reviewSessionId: receipt.sessionId, documentGeneration: receipt.documentGeneration, bindProof: receipt.bindProof,
        })).toMatchObject({ kind: 'codex-binding', status: 'accepted' });
        const before = await requestControl(socket, { kind: 'refresh-context', taskSessionId });
        expect(before).toMatchObject({ kind: 'context', result: { status: 'unavailable' } });
        await candidate.openLaunch(receipt.launchId);
        await expect(page.getByRole('textbox', { name: /^Current page 3 of 4\./u })).toHaveValue('3');
        expect(await page.evaluate(() => window.placekeeper.identity())).toMatchObject({ windowId: identity.windowId, attemptId: identity.attemptId });
        expect(candidate.pages().filter(p => p.url().startsWith('placekeeper-app:'))).toHaveLength(1);
        await expect.poll(async () => {
            const result = await requestControl(socket, { kind: 'refresh-context', taskSessionId });
            return result.kind === 'context' ? result.result.status : 'unexpected';
        }).toBe('current');
        await page.locator('[data-review-chrome]').hover();
        await expect(page.getByRole('button', { name: 'Copy link to current PDF location', exact: true })).toHaveCount(0);
        const copied = await page.evaluate(async () => {
            const shell = window.placekeeper;
            return shell.createLink(await shell.identity(), { kind: 'page', page: 3 });
        });
        expect(decodePlacekeeperLink(copied).location).toEqual(location);
        await expect(page.getByRole('button', { name: 'Back in document history', exact: true })).toBeEnabled();
    } catch (error) { primaryFailed = true; throw error; }
    finally {
        const failures: unknown[] = [];
        if (cleanupTaskSessionId) {
            try { await requestControl(socket, { kind: 'revoke-task', taskSessionId: cleanupTaskSessionId }); }
            catch (error) { failures.push(error); }
        }
        if (launchId) {
            try { await requestControl(socket, { kind: 'electron-cancel-launch', launchId }); }
            catch (error) { failures.push(error); }
        }
        try { await candidate.dispose(); } catch (error) { failures.push(error); }
        if (failures.length) {
            if (primaryFailed) console.error('Focused-link cleanup failures after primary test failure', failures);
            else throw new AggregateError(failures, 'Focused-link test cleanup failed');
        }
    }
});
