import { expect, type Locator, type Page } from '@playwright/test';

interface ReferencePlacementSample {
  placement: string | null;
  inlineStyle: string | null;
  rect: { left: number; top: number; right: number; bottom: number; width: number; height: number };
  origin: { left: number; top: number; right: number; bottom: number; width: number; height: number } | null;
  viewport: { left: number; top: number; right: number; bottom: number };
  computed: { display: string; visibility: string; opacity: string; position: string };
  mutationCount: number;
}

export async function installFirstVisibleReferencePlacementProbe(
  page: Page,
  key: string,
  targetSelector: string,
  originSelector: string,
): Promise<void> {
  await page.evaluate(({ key, targetSelector, originSelector }) => {
    type Probe = {
      first: ReferencePlacementSample | null;
      mutationCount: number;
      observer: MutationObserver;
      frame: number | null;
    };
    const scope = globalThis as typeof globalThis & {
      __referenceFirstVisiblePlacementProbes?: Record<string, Probe>;
    };
    const probes = scope.__referenceFirstVisiblePlacementProbes ??= {};
    probes[key]?.observer.disconnect();
    if (probes[key]?.frame !== null && probes[key]?.frame !== undefined) {
      cancelAnimationFrame(probes[key]!.frame!);
    }
    const bounds = (element: Element | null) => {
      if (element === null) return null;
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      };
    };
    const observer = new MutationObserver((mutations) => {
      probes[key]!.mutationCount += mutations.length;
    });
    const probe: Probe = { first: null, mutationCount: 0, observer, frame: null };
    probes[key] = probe;
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'data-composer-placement'],
    });
    const capture = () => {
      const target = document.querySelector<HTMLElement>(targetSelector);
      const rect = bounds(target);
      const computed = target === null ? null : getComputedStyle(target);
      if (target !== null && rect !== null && rect.width > 0 && rect.height > 0
        && computed !== null && computed.display !== 'none' && computed.visibility !== 'hidden'
        && Number(computed.opacity) > 0) {
        probe.first = {
          placement: target.getAttribute('data-composer-placement'),
          inlineStyle: target.getAttribute('style'),
          rect,
          origin: bounds(document.querySelector(originSelector)),
          viewport: globalThis.visualViewport === null
            ? { left: 0, top: 0, right: innerWidth, bottom: innerHeight }
            : {
                left: globalThis.visualViewport.offsetLeft,
                top: globalThis.visualViewport.offsetTop,
                right: globalThis.visualViewport.offsetLeft + globalThis.visualViewport.width,
                bottom: globalThis.visualViewport.offsetTop + globalThis.visualViewport.height,
              },
          computed: {
            display: computed.display,
            visibility: computed.visibility,
            opacity: computed.opacity,
            position: computed.position,
          },
          mutationCount: probe.mutationCount,
        };
        observer.disconnect();
        probe.frame = null;
        return;
      }
      probe.frame = requestAnimationFrame(capture);
    };
    probe.frame = requestAnimationFrame(capture);
  }, { key, targetSelector, originSelector });
}

export async function expectFirstVisibleReferencePlacement(
  page: Page,
  key: string,
  target: Locator,
  originSelector: string,
): Promise<void> {
  await expect.poll(() => page.evaluate((probeKey) => {
    const scope = globalThis as typeof globalThis & {
      __referenceFirstVisiblePlacementProbes?: Record<
        string,
        { first: ReferencePlacementSample | null }
      >;
    };
    return scope.__referenceFirstVisiblePlacementProbes?.[probeKey]?.first ?? null;
  }, key)).not.toBeNull();
  await expect(target).toHaveAttribute(
    'data-composer-placement',
    /^(?:above|below|side|bottom-sheet)$/u,
  );
  const first = await page.evaluate((probeKey) => {
    const scope = globalThis as typeof globalThis & {
      __referenceFirstVisiblePlacementProbes?: Record<
        string,
        { first: ReferencePlacementSample | null }
      >;
    };
    return scope.__referenceFirstVisiblePlacementProbes?.[probeKey]?.first ?? null;
  }, key);
  if (first === null) throw new Error(`${key} first-visible placement was not captured.`);
  const settled = await target.evaluate(async (element, selector) => {
    const bounds = (candidate: Element | null) => {
      if (candidate === null) return null;
      const rect = candidate.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      };
    };
    const sample = (): Omit<ReferencePlacementSample, 'mutationCount'> => {
      const computed = getComputedStyle(element);
      return {
        placement: element.getAttribute('data-composer-placement'),
        inlineStyle: element.getAttribute('style'),
        rect: bounds(element)!,
        origin: bounds(document.querySelector(selector)),
        viewport: globalThis.visualViewport === null
          ? { left: 0, top: 0, right: innerWidth, bottom: innerHeight }
          : {
              left: globalThis.visualViewport.offsetLeft,
              top: globalThis.visualViewport.offsetTop,
              right: globalThis.visualViewport.offsetLeft + globalThis.visualViewport.width,
              bottom: globalThis.visualViewport.offsetTop + globalThis.visualViewport.height,
            },
        computed: {
          display: computed.display,
          visibility: computed.visibility,
          opacity: computed.opacity,
          position: computed.position,
        },
      };
    };
    let previous = sample();
    for (let frame = 0; frame < 30; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const current = sample();
      if (JSON.stringify(current) === JSON.stringify(previous)) return current;
      previous = current;
    }
    throw new Error('Reference placement did not settle across consecutive animation frames.');
  }, originSelector);
  const relationship = (sample: Pick<ReferencePlacementSample, 'rect' | 'origin'>) => {
    if (sample.origin === null) return 'missing-origin';
    if (sample.rect.bottom <= sample.origin.top + 1) return 'above';
    if (sample.rect.top >= sample.origin.bottom - 1) return 'below';
    if (sample.rect.right <= sample.origin.left + 1) return 'left';
    if (sample.rect.left >= sample.origin.right - 1) return 'right';
    return 'overlap';
  };
  expect(first.mutationCount, `${key} observer saw no authoring mutation`).toBeGreaterThan(0);
  expect(first.placement, `${key} painted once with the unresolved Main placement`).toBe(settled.placement);
  expect(first.inlineStyle?.trim().length, `${key} first paint had no positioned inline style`)
    .toBeGreaterThan(0);
  expect(first.computed).toEqual(settled.computed);
  expect(first.computed.position).toBe('absolute');
  expect(relationship(first), `${key} first paint was not resolved from its Reference origin`)
    .toBe(relationship(settled));
  expect(first.origin, `${key} first paint had no Reference origin`).not.toBeNull();
  expect(settled.origin, `${key} settled placement had no Reference origin`).not.toBeNull();
  expect(first.rect.width).toBe(settled.rect.width);
  expect(first.rect.height).toBe(settled.rect.height);
  expect(first.rect.left).toBeGreaterThanOrEqual(first.viewport.left);
  expect(first.rect.top).toBeGreaterThanOrEqual(first.viewport.top);
  expect(first.rect.right).toBeLessThanOrEqual(first.viewport.right);
  expect(first.rect.bottom).toBeLessThanOrEqual(first.viewport.bottom);
}

export async function installFirstVisibleReferenceCardProbe(
  page: Page,
  key: string,
  itemId: string,
): Promise<void> {
  await page.evaluate(({ key, itemId }) => {
    type CardSample = {
      referenceInspection: boolean;
      selected: string | null;
    };
    type CardProbe = {
      first: CardSample[] | null;
      frames: CardSample[][];
      frame: number | null;
    };
    const scope = globalThis as typeof globalThis & {
      __referenceFirstVisibleCardProbes?: Record<string, CardProbe>;
    };
    const probes = scope.__referenceFirstVisibleCardProbes ??= {};
    if (probes[key]?.frame !== null && probes[key]?.frame !== undefined) {
      cancelAnimationFrame(probes[key]!.frame!);
    }
    const probe: CardProbe = {
      first: null,
      frames: [],
      frame: null,
    };
    probes[key] = probe;
    const capture = () => {
      const visible = [...document.querySelectorAll<HTMLElement>('[data-annotation-peek]')]
        .filter((element) => element.dataset.annotationPeek === itemId)
        .filter((element) => {
          const bounds = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return bounds.width > 0 && bounds.height > 0 && style.display !== 'none'
            && style.visibility !== 'hidden' && Number(style.opacity) > 0;
        })
        .map((element) => ({
          referenceInspection: element.hasAttribute('data-reference-annotation-inspection'),
          selected: element.getAttribute('data-peek-selected'),
        }));
      probe.frames.push(visible);
      if (visible.length > 0 && probe.first === null) {
        probe.first = visible;
      }
      probe.frame = requestAnimationFrame(capture);
    };
    probe.frame = requestAnimationFrame(capture);
  }, { key, itemId });
}

export async function expectFirstVisibleReferenceCard(page: Page, key: string): Promise<void> {
  await expect.poll(() => page.evaluate((probeKey) => {
    const scope = globalThis as typeof globalThis & {
      __referenceFirstVisibleCardProbes?: Record<
        string,
        { first: Array<{ referenceInspection: boolean; selected: string | null }> | null }
      >;
    };
    return scope.__referenceFirstVisibleCardProbes?.[probeKey]?.first ?? null;
  }, key)).not.toBeNull();
  const first = await page.evaluate((probeKey) => {
    const scope = globalThis as typeof globalThis & {
      __referenceFirstVisibleCardProbes?: Record<
        string,
        { first: Array<{ referenceInspection: boolean; selected: string | null }> | null }
      >;
    };
    return scope.__referenceFirstVisibleCardProbes?.[probeKey]?.first ?? null;
  }, key);
  expect(first).toEqual([{
    referenceInspection: true,
    selected: 'false',
  }]);
}

export async function expectReferenceCardProbeOnlyReference(page: Page, key: string): Promise<void> {
  const frames = await page.evaluate((probeKey) => {
    const scope = globalThis as typeof globalThis & {
      __referenceFirstVisibleCardProbes?: Record<
        string,
        {
          frames: Array<Array<{ referenceInspection: boolean; selected: string | null }>>;
          frame: number | null;
        }
      >;
    };
    const probe = scope.__referenceFirstVisibleCardProbes?.[probeKey];
    if (!probe) return [];
    if (probe.frame !== null) cancelAnimationFrame(probe.frame);
    probe.frame = null;
    return probe.frames;
  }, key);
  expect(frames.some((frame) => frame.some(({ referenceInspection }) => referenceInspection)))
    .toBe(true);
  expect(
    frames.some((frame) => frame.some(({ referenceInspection }) => !referenceInspection)),
    `${key} painted a Main card while the Reference card was acquiring or holding the pointer`,
  ).toBe(false);
}

export async function installPostClickTransitionProbe(
  page: Page,
  key: string,
  fromSelector: string,
  toSelector: string,
  terminal: 'to-visible' | 'from-hidden',
): Promise<void> {
  await page.evaluate(({ key, fromSelector, toSelector, terminal }) => {
    type TransitionFrame = { fromVisible: boolean; toVisible: boolean };
    type TransitionProbe = {
      frames: TransitionFrame[];
      complete: boolean;
      frame: number | null;
    };
    const scope = globalThis as typeof globalThis & {
      __referenceTransitionProbes?: Record<string, TransitionProbe>;
    };
    const probes = scope.__referenceTransitionProbes ??= {};
    if (probes[key]?.frame !== null && probes[key]?.frame !== undefined) {
      cancelAnimationFrame(probes[key]!.frame!);
    }
    const probe: TransitionProbe = { frames: [], complete: false, frame: null };
    probes[key] = probe;
    const visible = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
      .some((element) => {
        const bounds = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return bounds.width > 0 && bounds.height > 0 && style.display !== 'none'
          && style.visibility !== 'hidden' && Number(style.opacity) > 0;
      });
    const capture = () => {
      const frame = {
        fromVisible: visible(fromSelector),
        toVisible: visible(toSelector),
      };
      probe.frames.push(frame);
      const complete = terminal === 'to-visible' ? frame.toVisible : !frame.fromVisible;
      if (complete) {
        probe.complete = true;
        probe.frame = null;
        return;
      }
      probe.frame = requestAnimationFrame(capture);
    };
    document.addEventListener('click', () => {
      probe.frame = requestAnimationFrame(capture);
    }, { capture: true, once: true });
  }, { key, fromSelector, toSelector, terminal });
}

export async function expectPostClickTransitionWithoutSurface(
  page: Page,
  key: string,
  forbidden: 'fromVisible' | 'toVisible',
): Promise<void> {
  await expect.poll(() => page.evaluate((probeKey) => {
    const scope = globalThis as typeof globalThis & {
      __referenceTransitionProbes?: Record<string, { complete: boolean }>;
    };
    return scope.__referenceTransitionProbes?.[probeKey]?.complete ?? false;
  }, key)).toBe(true);
  const frames = await page.evaluate((probeKey) => {
    const scope = globalThis as typeof globalThis & {
      __referenceTransitionProbes?: Record<
        string,
        { frames: Array<{ fromVisible: boolean; toVisible: boolean }> }
      >;
    };
    return scope.__referenceTransitionProbes?.[probeKey]?.frames ?? [];
  }, key);
  expect(frames.length).toBeGreaterThan(0);
  expect(frames.some((frame) => frame[forbidden]), `${key} painted an intermediate surface`)
    .toBe(false);
}
