import { describe, expect, it } from 'vitest';

import {
  addDelete,
  addHighlight,
  addInsert,
  addPageNote,
  addReplace,
  editReviewItem,
  removeReviewItem,
  type ReviewCommandFactory,
} from '../src/review-commands.js';
import { createReviewState, type ReviewState } from '../src/review-model.js';
import { InvalidReviewCommandError, reduceReview } from '../src/review-reducer.js';

const source = { fileId: 'source-file', digest: 'a'.repeat(64), byteLength: 10 };
const selection = {
  pageIndex: 0,
  quote: 'unique equilibrium',
  prefix: 'the ',
  suffix: ' exists',
  rect: { x: 72, y: 92, width: 120, height: 14 },
  segmentRects: [{ x: 72, y: 92, width: 120, height: 14 }],
  reliable: true as const,
};
const caret = {
  pageIndex: 0,
  position: { x: 192, y: 92, width: 2, height: 14 },
  leftContext: 'the equilibrium',
  rightContext: ' exists',
  reliable: true as const,
};

function setup(): { state: ReviewState; commands: ReviewCommandFactory } {
  let id = 0;
  const commands = new (class implements ReviewCommandFactory {
    createId() {
      id += 1;
      return `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`;
    }
    now() {
      return '2026-08-07T12:00:00.000Z';
    }
  })();
  return {
    state: createReviewState({ sessionId: 'session', source }),
    commands,
  };
}

describe('canonical review commands', () => {
  it('creates all five v1 tools as stable semantic items and advances one revision each', () => {
    let { state, commands } = setup();
    const commandBuilders = [
      () => addReplace(state, selection, 'locally unique equilibrium', commands),
      () => addDelete(state, selection, commands),
      () => addInsert(state, caret, 'perhaps ', commands),
      () => addHighlight(state, selection, 'Check this claim.', commands),
      () => addPageNote(state, 1, { x: 44, y: 55, width: 18, height: 18 }, 'Rewrite this paragraph.', commands),
    ];

    for (const build of commandBuilders) state = reduceReview(state, build());

    expect(state.revision).toBe(5);
    expect(state.items.map(({ kind }) => kind)).toEqual([
      'replace', 'delete', 'insert', 'highlight', 'pageNote',
    ]);
    expect(new Set(state.items.map(({ id }) => id)).size).toBe(5);
    expect(state.items[0]?.payload).toMatchObject({
      quote: 'unique equilibrium',
      reliable: true,
      proposedText: 'locally unique equilibrium',
    });
    expect(state.items[2]?.payload).toMatchObject({
      leftContext: 'the equilibrium',
      rightContext: ' exists',
      reliable: true,
      proposedText: 'perhaps ',
    });
    expect(state.items[2]?.payload).not.toHaveProperty('quote');

    const ids = state.items.map(({ id }) => id);
    for (let index = 0; index < 5; index += 1) {
      state = reduceReview(state, { type: 'undo', expectedRevision: state.revision });
    }
    expect(state.items).toEqual([]);
    for (let index = 0; index < 5; index += 1) {
      state = reduceReview(state, { type: 'redo', expectedRevision: state.revision });
    }
    expect(state.items.map(({ id }) => id)).toEqual(ids);
  });

  it('preserves an ID through edits and undo/redo, while delete-and-recreate gets a new ID', () => {
    let { state, commands } = setup();
    state = reduceReview(state, addHighlight(state, selection, undefined, commands));
    const firstId = state.items[0]!.id;
    state = reduceReview(state, editReviewItem(state, firstId, { comment: 'Keep this.' }, commands));
    expect(state.items[0]).toMatchObject({ id: firstId, payload: { comment: 'Keep this.' } });

    state = reduceReview(state, { type: 'undo', expectedRevision: state.revision });
    expect(state.items[0]).toMatchObject({ id: firstId, payload: {} });
    state = reduceReview(state, { type: 'redo', expectedRevision: state.revision });
    expect(state.items[0]).toMatchObject({ id: firstId, payload: { comment: 'Keep this.' } });

    state = reduceReview(state, removeReviewItem(state, firstId));
    state = reduceReview(state, addHighlight(state, selection, 'Keep this.', commands));
    expect(state.items[0]!.id).not.toBe(firstId);
  });

  it('persists canonical undo/redo history through recovery serialization', () => {
    let { state, commands } = setup();
    state = reduceReview(state, addReplace(state, selection, 'locally unique equilibrium', commands));
    state = reduceReview(state, addDelete(state, { ...selection, quote: 'clearly' }, commands));
    state = reduceReview(state, { type: 'undo', expectedRevision: state.revision });

    const recovered = JSON.parse(JSON.stringify(state)) as ReviewState;
    const redone = reduceReview(recovered, { type: 'redo', expectedRevision: recovered.revision });
    expect(redone.items.map(({ kind }) => kind)).toEqual(['replace', 'delete']);
    expect(redone.revision).toBe(4);
    const backAgain = reduceReview(redone, { type: 'undo', expectedRevision: redone.revision });
    expect(backAgain.items.map(({ kind }) => kind)).toEqual(['replace']);
  });

  it('clears redo after a new mutation and preserves meaningful whitespace suggestions', () => {
    let { state, commands } = setup();
    state = reduceReview(state, addReplace(state, selection, 'first', commands));
    state = reduceReview(state, addDelete(state, selection, commands));
    state = reduceReview(state, { type: 'undo', expectedRevision: state.revision });
    state = reduceReview(state, addInsert(state, caret, ' ', commands));

    expect(state.historyCursor).toBe(2);
    expect(state.history).toHaveLength(2);
    expect(state.items.map(({ kind }) => kind)).toEqual(['replace', 'insert']);
    expect(state.items[1]?.payload.proposedText).toBe(' ');
    expect(() => reduceReview(state, { type: 'redo', expectedRevision: state.revision }))
      .toThrow(InvalidReviewCommandError);
  });

  it('rejects payloads that do not deeply match their semantic tool', () => {
    const { state, commands } = setup();
    const command = addHighlight(state, selection, undefined, commands);
    if (command.type !== 'add') throw new Error('Expected an add command');
    const invalid = {
      ...command,
      item: { ...command.item, payload: { comment: 'missing anchor' } },
    };

    expect(() => reduceReview(state, invalid)).toThrow(InvalidReviewCommandError);

    const deleteCommand = addDelete(state, selection, commands);
    if (deleteCommand.type !== 'add') throw new Error('Expected an add command');
    const { reliable: _reliable, ...untrustedPayload } = deleteCommand.item.payload;
    expect(() => reduceReview(state, {
      ...deleteCommand,
      item: { ...deleteCommand.item, payload: untrustedPayload },
    })).toThrow(InvalidReviewCommandError);
  });
});
