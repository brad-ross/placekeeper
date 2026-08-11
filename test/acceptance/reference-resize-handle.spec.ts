import { expect, test } from '@playwright/test';

type ReferenceResizeHandleEvents = { readonly changes: number[]; readonly commits: number };

test('commits a captured reference resize once when pointer capture is lost', async ({ page }) => {
  await page.goto('/test/acceptance/reference-resize-handle-harness/index.html');
  const handle = page.getByRole('separator', { name: 'Resize References' });
  await expect(handle).toBeAttached();

  await handle.evaluate((element) => {
    let capturedPointerId: number | null = null;
    Object.assign(element, {
      setPointerCapture(pointerId: number) { capturedPointerId = pointerId; },
      hasPointerCapture(pointerId: number) { return capturedPointerId === pointerId; },
      releasePointerCapture(pointerId: number) {
        if (capturedPointerId === pointerId) capturedPointerId = null;
      },
    });
    const dispatch = (type: string, clientY: number) => element.dispatchEvent(new PointerEvent(type, {
      bubbles: true, pointerId: 17, pointerType: 'mouse', isPrimary: true, button: 0, clientY,
    }));
    dispatch('pointerdown', 500);
    dispatch('pointermove', 460);
    dispatch('lostpointercapture', 460);
    dispatch('pointermove', 420);
    dispatch('pointerup', 420);
  });

  await expect.poll(() => page.evaluate(() => (
    globalThis as typeof globalThis & { __referenceResizeHandleEvents: ReferenceResizeHandleEvents }
  ).__referenceResizeHandleEvents)).toEqual({
    changes: [424],
    commits: 1,
  });
});
