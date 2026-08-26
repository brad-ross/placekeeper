import type { ReviewCommand, ReviewItem, ReviewState } from "./review-model.js";

export const MAX_REVIEW_SELECTION_SEGMENTS = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class ReviewConflictError extends Error {
  readonly code = "REVISION_CONFLICT";

  constructor(expected: number, actual: number) {
    super(`Expected review revision ${expected}, but current revision is ${actual}`);
    this.name = "ReviewConflictError";
  }
}

export class InvalidReviewCommandError extends Error {
  readonly code = "INVALID_REVIEW_COMMAND";

  constructor(message: string) {
    super(message);
    this.name = "InvalidReviewCommandError";
  }
}

function assertMutable(state: ReviewState, command: ReviewCommand): void {
  if (state.lifecycle !== "active") {
    throw new InvalidReviewCommandError("A completed review cannot be mutated");
  }
  if (command.expectedRevision !== state.revision) {
    throw new ReviewConflictError(command.expectedRevision, state.revision);
  }
}

export function assertReviewItem(
  item: ReviewItem,
  options: { readonly maxSelectionSegments?: number } = {},
): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(item.id)) {
    throw new InvalidReviewCommandError("Review item IDs must be UUIDs");
  }
  if (!Number.isSafeInteger(item.pageIndex) || item.pageIndex < 0) {
    throw new InvalidReviewCommandError("Review item pageIndex must be non-negative");
  }
  if (
    !["replace", "delete", "insert", "highlight", "pageNote"].includes(
      item.kind,
    )
  ) {
    throw new InvalidReviewCommandError("Review item kind is not supported");
  }
  if (!Number.isFinite(Date.parse(item.createdAt)) || !Number.isFinite(Date.parse(item.updatedAt))) {
    throw new InvalidReviewCommandError("Review item dates must be valid timestamps");
  }

  const keys = Object.keys(item.payload);
  const allowedByKind: Record<ReviewItem['kind'], readonly string[]> = {
    replace: ['quote', 'prefix', 'suffix', 'rect', 'segmentRects', 'reliable', 'proposedText'],
    delete: ['quote', 'prefix', 'suffix', 'rect', 'segmentRects', 'reliable'],
    insert: ['position', 'leftContext', 'rightContext', 'reliable', 'proposedText'],
    highlight: ['quote', 'prefix', 'suffix', 'rect', 'segmentRects', 'reliable', 'comment'],
    pageNote: ['position', 'comment', 'nearbyText'],
  };
  if (keys.some((key) => !allowedByKind[item.kind].includes(key))) {
    throw new InvalidReviewCommandError("Review item payload has unsupported fields");
  }
  if (
    Array.isArray(item.payload.segmentRects) &&
    item.payload.segmentRects.length >
      (options.maxSelectionSegments ?? MAX_REVIEW_SELECTION_SEGMENTS)
  ) {
    const maximum = options.maxSelectionSegments ?? MAX_REVIEW_SELECTION_SEGMENTS;
    throw new InvalidReviewCommandError(
      `Selections can contain at most ${maximum} text segments. Shorten the selection and try again.`,
    );
  }
  const text = (field: string, allowEmpty = true) =>
    typeof item.payload[field] === 'string' && (allowEmpty || item.payload[field] !== '');
  const geometry = (field: string) => {
    const value = item.payload[field];
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const object = value as Record<string, unknown>;
    return ['x', 'y', 'width', 'height'].every((key) =>
      typeof object[key] === 'number' && Number.isFinite(object[key])) &&
      (object.width as number) > 0 && (object.height as number) > 0;
  };
  const selection = () =>
    text('quote', false) && text('prefix') && text('suffix') && item.payload.reliable === true && geometry('rect') &&
    Array.isArray(item.payload.segmentRects) && item.payload.segmentRects.length > 0 &&
    item.payload.segmentRects.every((_, index) => {
      const segments = item.payload.segmentRects as unknown[];
      const value = segments[index];
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
      const object = value as Record<string, unknown>;
      return ['x', 'y', 'width', 'height'].every((key) =>
        typeof object[key] === 'number' && Number.isFinite(object[key])) &&
        (object.width as number) > 0 && (object.height as number) > 0;
    });

  const valid =
    (item.kind === 'replace' && selection() && text('proposedText', false)) ||
    (item.kind === 'delete' && selection()) ||
    (item.kind === 'insert' && item.payload.reliable === true && geometry('position') && text('leftContext') && text('rightContext') && text('proposedText', false) && item.payload.quote === undefined) ||
    (item.kind === 'highlight' && selection() && (item.payload.comment === undefined || text('comment'))) ||
    (item.kind === 'pageNote' && geometry('position') && text('comment', false) && (item.payload.nearbyText === undefined || text('nearbyText')));
  if (!valid) throw new InvalidReviewCommandError("Review item payload does not match its kind");
}

export function assertReviewCommand(command: unknown): asserts command is ReviewCommand {
  if (
    !isRecord(command) ||
    !Number.isSafeInteger(command.expectedRevision) ||
    (command.expectedRevision as number) < 0
  ) {
    throw new InvalidReviewCommandError("Review command is malformed");
  }
  switch (command.type) {
    case "add":
      if (!isRecord(command.item) || !isRecord(command.item.payload)) {
        throw new InvalidReviewCommandError("Review command is malformed");
      }
      return;
    case "edit":
      if (
        typeof command.id !== "string" ||
        typeof command.updatedAt !== "string" ||
        !isRecord(command.payload)
      ) {
        throw new InvalidReviewCommandError("Review command is malformed");
      }
      return;
    case "remove":
      if (typeof command.id !== "string") {
        throw new InvalidReviewCommandError("Review command is malformed");
      }
      return;
    case "undo":
    case "redo":
      return;
    default:
      throw new InvalidReviewCommandError("Review command type is not supported");
  }
}

export function reduceReview(
  state: ReviewState,
  command: ReviewCommand,
): ReviewState {
  assertReviewCommand(command);
  assertMutable(state, command);

  const history = state.history;
  const historyCursor = state.historyCursor;

  if (command.type === "undo") {
    if (historyCursor <= 0) {
      throw new InvalidReviewCommandError("There is no review command to undo");
    }
    const entry = history[historyCursor - 1]!;
    return {
      ...state,
      revision: state.revision + 1,
      items: entry.beforeItems,
      history,
      historyCursor: historyCursor - 1,
    };
  }
  if (command.type === "redo") {
    if (historyCursor >= history.length) {
      throw new InvalidReviewCommandError("There is no review command to redo");
    }
    const entry = history[historyCursor]!;
    return {
      ...state,
      revision: state.revision + 1,
      items: entry.afterItems,
      history,
      historyCursor: historyCursor + 1,
    };
  }

  let items: readonly ReviewItem[];
  switch (command.type) {
    case "add": {
      assertReviewItem(command.item);
      if (state.items.some((item) => item.id === command.item.id)) {
        throw new InvalidReviewCommandError("Review item ID already exists");
      }
      items = [...state.items, command.item];
      break;
    }
    case "edit": {
      const index = state.items.findIndex((item) => item.id === command.id);
      if (index < 0) {
        throw new InvalidReviewCommandError("Review item does not exist");
      }
      const existing = state.items[index]!;
      const mutable = existing.kind === 'replace' || existing.kind === 'insert'
        ? ['proposedText']
        : existing.kind === 'highlight' || existing.kind === 'pageNote'
          ? ['comment']
          : [];
      if (Object.keys(command.payload).length === 0 || Object.keys(command.payload).some((key) => !mutable.includes(key))) {
        throw new InvalidReviewCommandError("Only proposed text or comments may be edited");
      }
      const edited: ReviewItem = {
        ...existing,
        payload: { ...existing.payload, ...command.payload },
        updatedAt: command.updatedAt,
      };
      assertReviewItem(edited);
      items = state.items.map((item, itemIndex) => itemIndex === index ? edited : item);
      break;
    }
    case "remove": {
      if (!state.items.some((item) => item.id === command.id)) {
        throw new InvalidReviewCommandError("Review item does not exist");
      }
      items = state.items.filter((item) => item.id !== command.id);
      break;
    }
    default:
      throw new InvalidReviewCommandError("Review command type is not supported");
  }

  const retainedHistory = history.slice(0, historyCursor);
  return {
    ...state,
    revision: state.revision + 1,
    items,
    history: [...retainedHistory, { beforeItems: state.items, afterItems: items }],
    historyCursor: retainedHistory.length + 1,
  };
}
