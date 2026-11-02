import { expect, test } from '@playwright/test';
import type { HostRuntimeCommand } from '../../apps/web/src/host/runtime.js';

declare global {
  interface Window { runtimeFixture: { send(command: HostRuntimeCommand): void; reverseCalls(): number }; synctexFixture: {
    observations: { calls: number; cancellations: number; focuses: number[]; acknowledgements: string[]; errors: (string | null)[] };
    render(token?: number): void; unmount(): void; settle(index: number, result: boolean): void;
  } }
}
const fixture = '/test/acceptance/synctex-harness/index.html';

test('cancels replaced forward work and acknowledges only the current completion', async ({ page }) => {
  await page.goto(fixture);
  await page.getByText('Hook mounted').waitFor();
  await page.evaluate(() => window.synctexFixture.render(1));
  await expect.poll(() => page.evaluate(() => window.synctexFixture.observations.calls)).toBe(1);
  await page.evaluate(() => window.synctexFixture.render(2));
  await expect.poll(() => page.evaluate(() => window.synctexFixture.observations.calls)).toBe(2);
  await page.evaluate(() => window.synctexFixture.settle(0, true));
  await expect.poll(() => page.evaluate(() => window.synctexFixture.observations.acknowledgements)).toEqual(['1:superseded']);
  await page.evaluate(() => window.synctexFixture.settle(1, true));
  await expect.poll(() => page.evaluate(() => window.synctexFixture.observations.acknowledgements)).toEqual(['1:superseded', '2:applied']);
  await page.evaluate(() => window.synctexFixture.render(2));
  await page.evaluate(() => window.synctexFixture.unmount());
  expect(await page.evaluate(() => window.synctexFixture.observations)).toMatchObject({ calls: 2, cancellations: 1,
    focuses: [2], acknowledgements: ['1:superseded', '2:applied'] });
});

for (const cleanup of ['clear', 'unmount'] as const) {
  test(`suppresses late focus and completion after ${cleanup}`, async ({ page }) => {
    await page.goto(fixture);
    await page.getByText('Hook mounted').waitFor();
    await page.evaluate(() => window.synctexFixture.render(1));
    await expect.poll(() => page.evaluate(() => window.synctexFixture.observations.calls)).toBe(1);
    await page.evaluate(action => action === 'clear' ? window.synctexFixture.render() : window.synctexFixture.unmount(), cleanup);
    await expect.poll(() => page.evaluate(() => window.synctexFixture.observations.cancellations)).toBe(1);
    await page.evaluate(async () => { window.synctexFixture.settle(0, true); await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(await page.evaluate(() => window.synctexFixture.observations)).toMatchObject({ focuses: [], acknowledgements: ['1:superseded'] });
  });
}

test('acknowledges a failed completion once without superseding it on unmount', async ({ page }) => {
  await page.goto(fixture);
  await page.getByText('Hook mounted').waitFor();
  await page.evaluate(() => window.synctexFixture.render(1));
  await expect.poll(() => page.evaluate(() => window.synctexFixture.observations.calls)).toBe(1);
  await page.evaluate(() => window.synctexFixture.settle(0, false));
  await expect.poll(() => page.evaluate(() => window.synctexFixture.observations.acknowledgements)).toEqual(['1:failed']);
  await page.evaluate(() => window.synctexFixture.unmount());
  expect(await page.evaluate(() => window.synctexFixture.observations)).toMatchObject({ cancellations: 0, focuses: [], acknowledgements: ['1:failed'] });
});


test('accepts repeated forward commands after cancellation and inverse search', async ({ page }) => {
  await page.goto(`${fixture}?runtime`);
  const currentPage = page.getByRole('textbox', { name: /Current page/ });
  await expect(currentPage).toHaveValue('1');
  const forward = async (pageIndex: number) => page.evaluate(index => {
    window.runtimeFixture.send({ command: 'forward-synctex', documentGeneration: 1, pageIndex: index, point: { x: 72, y: 150 } });
  }, pageIndex);
  await forward(1);
  await expect(currentPage).toHaveValue('2');
  await page.evaluate(() => window.runtimeFixture.send({ command: 'cancel-synctex' }));
  await forward(0);
  await expect(currentPage).toHaveValue('1');
  await page.evaluate(() => window.runtimeFixture.send({ command: 'reverse-synctex' }));
  await expect.poll(() => page.evaluate(() => window.runtimeFixture.reverseCalls())).toBe(1);
  await forward(1);
  await expect(currentPage).toHaveValue('2');
});
