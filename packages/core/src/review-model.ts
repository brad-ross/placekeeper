export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type ReviewItemKind =
  | "replace"
  | "delete"
  | "insert"
  | "highlight"
  | "pageNote";

export interface ReviewItem {
  readonly id: string;
  readonly kind: ReviewItemKind;
  readonly pageIndex: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly payload: Readonly<Record<string, JsonValue>>;
}

export interface ReviewSourceIdentity {
  readonly fileId: string;
  readonly digest: string;
  readonly byteLength: number;
}

export interface ReviewState {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly source: ReviewSourceIdentity;
  readonly sourceRootId?: string;
  readonly revision: number;
  readonly lifecycle: "active" | "finished" | "discarded";
  readonly items: readonly ReviewItem[];
  /** Canonical semantic history. The cursor points just after the last applied entry. */
  readonly history: readonly ReviewHistoryEntry[];
  readonly historyCursor: number;
}

export interface ReviewHistoryEntry {
  readonly beforeItems: readonly ReviewItem[];
  readonly afterItems: readonly ReviewItem[];
}

export type ReviewCommand =
  | {
      readonly type: "add";
      readonly expectedRevision: number;
      readonly item: ReviewItem;
    }
  | {
      readonly type: "edit";
      readonly expectedRevision: number;
      readonly id: string;
      readonly updatedAt: string;
      readonly payload: Readonly<Record<string, JsonValue>>;
    }
  | {
      readonly type: "remove";
      readonly expectedRevision: number;
      readonly id: string;
    }
  | {
      readonly type: "undo";
      readonly expectedRevision: number;
    }
  | {
      readonly type: "redo";
      readonly expectedRevision: number;
    };

export function createReviewState(input: {
  sessionId: string;
  source: ReviewSourceIdentity;
  sourceRootId?: string;
}): ReviewState {
  return {
    schemaVersion: 1,
    sessionId: input.sessionId,
    source: input.source,
    ...(input.sourceRootId === undefined
      ? {}
      : { sourceRootId: input.sourceRootId }),
    revision: 0,
    lifecycle: "active",
    items: [],
    history: [],
    historyCursor: 0,
  };
}
