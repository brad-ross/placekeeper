export interface DocumentContextVersion {
  readonly sourceKey: string;
  readonly generation: number;
  readonly digest: string;
}

export interface DocumentContextSource extends DocumentContextVersion {
  readonly title: string;
  /** Reads only the verified bytes for this displayed version, while it remains current. */
  readonly readBytes: () => Uint8Array | undefined | Promise<Uint8Array | undefined>;
}

export type DocumentContextState = {
  readonly version?: DocumentContextVersion;
  readonly canActivate: boolean;
} & (
  | { readonly status: 'idle' | 'publishing' | 'available' }
  | { readonly status: 'unsupported' | 'unavailable'; readonly reason: string }
);

export interface DocumentContextController {
  setSource(source: DocumentContextSource | undefined): void;
  getState(): DocumentContextState;
  subscribe(listener: () => void): () => void;
  activate(): void;
}

export interface DocumentContextMember extends DocumentContextVersion {
  readonly title: string;
  /** The complete, verified PDF encoded as base64. */
  readonly blob: string;
  readonly beforeSubmit?: () => Promise<void>;
}

export type DocumentContextPublicationStatus = 'publishing' | 'available' | 'unavailable' | 'removed';
