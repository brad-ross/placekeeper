import type { DocumentExportFence } from "../../../../packages/core/src/document-runtime-protocol.js";
import type { SaveStatus } from "../../../../packages/core/src/save-status.js";
import type { DocumentStateView } from "../../../../packages/core/src/document-model.js";
import type {
  ForwardSyncTexRequest,
  ProductionExportResult,
  ProductionScope,
  ProductionSession,
  ProductionSessionApi,
} from "./session-contracts.js";
import type { ViewerAssetUrls, ViewerResourcePolicy } from "../pdf/embedpdf-viewer.js";
import type { DocumentLocationHistoryPort } from "../reader/document-location-history.js";

export interface HostRuntimeIdentity {
  readonly sessionId: string;
  readonly generation: number;
  readonly revision: number;
}

export interface HostRuntimeBootstrap extends HostRuntimeIdentity {
  /** Ephemeral broker presence; absent on older hosts and never persisted in ReviewState. */
  readonly activeAuthoringDraftIds?: readonly string[];
  readonly session: ProductionSession;
  readonly state: DocumentStateView;
  readonly scope: ProductionScope;
  readonly saveStatus: SaveStatus;
  readonly viewerAssets: ViewerAssetUrls;
  readonly resourcePolicy: ViewerResourcePolicy;
  readonly locationHistory?: DocumentLocationHistoryPort;
  readonly canonicalLinkBase?: string;
}

export interface HostRuntimeInvalidation extends HostRuntimeIdentity {
  readonly reason: "generation" | "revision" | "freshness" | "presence";
  readonly previousGeneration?: number;
}

export type HostRuntimeCommand =
  | { readonly command: "source-navigation"; readonly state: import("../../../../packages/core/src/native-synctex-protocol.js").NativeForwardState }
  | { readonly command: "review-command"; readonly id: import("../reader/document-command-surface.js").DocumentSemanticCommand }
  | { readonly command: "reattach" }
  | { readonly command: "export-reviewed-pdf" }
  | { readonly command: "reverse-synctex" }
  | { readonly command: "cancel-synctex" }
  | ({ readonly command: "forward-synctex" } & ForwardSyncTexRequest);

export interface HostRuntime extends ProductionSessionApi {
  openExternalUrl?(url: string): Promise<void>;
  readonly host: "browser" | "vscode" | "chrome" | "macos" | "electron" | "codex" | "static";
  closeForUpgrade?(): Promise<void>;
  upgradePoll?(): Promise<import("../../../../packages/core/src/upgrade-document-protocol.js").UpgradeDocumentStatus>;
  upgradeSettle?(request: import("../../../../packages/core/src/upgrade-document-protocol.js").UpgradeDocumentSettlement): Promise<import("../../../../packages/core/src/upgrade-document-protocol.js").UpgradeDocumentStatus>;
  bootstrap(signal?: AbortSignal): Promise<HostRuntimeBootstrap>;
  subscribeInvalidations(listener: (event: HostRuntimeInvalidation) => void): () => void;
  subscribeHostCommands?(listener: (command: HostRuntimeCommand) => void): () => void;
  exportReviewedCopy(confirmPossiblyStale?: true, fence?: DocumentExportFence): Promise<ProductionExportResult>;
  forwardSyncTex(input: unknown): Promise<unknown>;
  reverseSyncTex(input: unknown): Promise<unknown>;
  dispose(): void;
}
