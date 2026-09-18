import type { ReviewExportFence } from "../../../../packages/core/src/review-runtime-protocol.js";
import type { SaveStatus } from "../../../../packages/core/src/save-status.js";
import type { ReviewState } from "../../../../packages/core/src/review-model.js";
import type {
  ForwardSyncTexRequest,
  ProductionExportResult,
  ProductionScope,
  ProductionSession,
  ProductionSessionApi,
} from "./session-contracts.js";
import type { ViewerAssetUrls, ViewerResourcePolicy } from "../pdf/embedpdf-viewer.js";
import type { ReviewLocationHistoryPort } from "../review/review-location-history.js";

export interface HostRuntimeIdentity {
  readonly sessionId: string;
  readonly generation: number;
  readonly revision: number;
}

export interface HostRuntimeBootstrap extends HostRuntimeIdentity {
  /** Ephemeral broker presence; absent on older hosts and never persisted in ReviewState. */
  readonly activeAuthoringDraftIds?: readonly string[];
  readonly session: ProductionSession;
  readonly state: ReviewState;
  readonly scope: ProductionScope;
  readonly saveStatus: SaveStatus;
  readonly viewerAssets: ViewerAssetUrls;
  readonly resourcePolicy: ViewerResourcePolicy;
  readonly locationHistory?: ReviewLocationHistoryPort;
  readonly canonicalLinkBase?: string;
}

export interface HostRuntimeInvalidation extends HostRuntimeIdentity {
  readonly reason: "generation" | "revision" | "freshness" | "presence";
  readonly previousGeneration?: number;
}

export type HostRuntimeCommand =
  | { readonly command: "review-command"; readonly id: import("../review/review-command-surface.js").ReviewSemanticCommand }
  | { readonly command: "reattach" }
  | { readonly command: "export-reviewed-pdf" }
  | { readonly command: "reverse-synctex" }
  | ({ readonly command: "forward-synctex" } & ForwardSyncTexRequest);

export interface HostRuntime extends ProductionSessionApi {
  readonly host: "browser" | "vscode" | "chrome" | "macos" | "static";
  bootstrap(signal?: AbortSignal): Promise<HostRuntimeBootstrap>;
  subscribeInvalidations(listener: (event: HostRuntimeInvalidation) => void): () => void;
  subscribeHostCommands?(listener: (command: HostRuntimeCommand) => void): () => void;
  exportReviewedCopy(confirmPossiblyStale?: true, fence?: ReviewExportFence): Promise<ProductionExportResult>;
  forwardSyncTex(input: unknown): Promise<unknown>;
  reverseSyncTex(input: unknown): Promise<unknown>;
  dispose(): void;
}
