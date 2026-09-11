import { expect, it } from 'vitest';
import { createReviewCommandSurface, reviewCommandForShortcut } from '../src/review/review-command-surface.js';

it.each([
  ['0', 'fit-width'], ['l', 'toggle-horizontal-scroll-lock'],
  ['O', 'open-outline'], ['a', 'open-annotations'], ['r', 'open-references'],
])('routes %s with Control-Command or Control-Alt', (key, command) => {
  for (const metaKey of [true, false]) {
    expect(reviewCommandForShortcut({ key, shiftKey: false, metaKey, ctrlKey: true, altKey: !metaKey, isComposing: false })).toBe(command);
  }
});
it('rejects old aliases, composition and extra modifiers', () => {
  const base = { key: 'l', shiftKey: false, metaKey: true, ctrlKey: true, altKey: false, isComposing: false };
  for (const override of [{ctrlKey:false}, {metaKey:false}, {altKey:true}, {isComposing:true}, {shiftKey:true}, {ctrlKey:false,shiftKey:true}]) {
    expect(reviewCommandForShortcut({...base, ...override})).toBeUndefined();
  }
  expect(reviewCommandForShortcut({...base, key:'0', ctrlKey:false})).toBeUndefined();
});
it.each(['review', 'editable', 'dialog'] as const)('gates new commands in %s focus', (focusContext) => {
  let invoked = 0;
  const ids = ['fit-width', 'toggle-horizontal-scroll-lock', 'open-outline', 'open-annotations', 'open-references'] as const;
  const surface = createReviewCommandSurface({
    focusContext, canUndo: false, canRedo: false, canNavigateBack: false, canNavigateForward: false,
    canFind: false, canOpenAnnotations: true, canOpenOutline: true, canOpenReferences: true, canOpenSaveOptions: false,
    canFitWidth: true, canZoom: true, canToggleHorizontalScrollLock: true, horizontalScrollLocked: true,
    handlers: Object.fromEntries(ids.map((id) => [id, () => { invoked++; }])),
  });
  for (const id of ids) expect(surface.invoke(id)).toBe(focusContext === 'review'
    || (focusContext === 'editable' && (id === 'fit-width' || id === 'open-annotations')));
  expect(invoked).toBe(focusContext === 'review' ? 5 : focusContext === 'editable' ? 2 : 0);
  expect(surface.snapshot.commands.find(({id}) => id === 'toggle-horizontal-scroll-lock')?.label).toBe('Unlock Horizontal Scrolling');
});

it.each([[false, false], [true, false], [false, true], [true, true]])(
  'independently gates outline %s and references %s availability', (canOpenOutline, canOpenReferences) => {
    const invoked: string[] = [];
    const surface = createReviewCommandSurface({
      focusContext: 'review', canUndo: false, canRedo: false, canNavigateBack: false,
      canNavigateForward: false, canFind: false, canOpenAnnotations: true,
      canOpenOutline, canOpenReferences, canOpenSaveOptions: false, canFitWidth: false, canZoom: false,
      handlers: { 'open-outline': () => invoked.push('outline'), 'open-references': () => invoked.push('references') },
    });
    expect(surface.snapshot.commands.find(({id}) => id === 'open-outline')?.enabled).toBe(canOpenOutline);
    expect(surface.snapshot.commands.find(({id}) => id === 'open-references')?.enabled).toBe(canOpenReferences);
    expect(surface.invoke('open-outline')).toBe(canOpenOutline);
    expect(surface.invoke('open-references')).toBe(canOpenReferences);
    expect(invoked).toEqual([...(canOpenOutline ? ['outline'] : []), ...(canOpenReferences ? ['references'] : [])]);
  },
);
