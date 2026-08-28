import type { ReviewState } from "../../../../packages/core/src/review-model.js";
import type {
  ProductionExportResult,
  ProductionSaveStatus,
  ProductionScope,
  ProductionSession,
  ProductionSessionApi,
} from "../app/ProductionReviewApp.js";
import type { ViewerAssetUrls, ViewerResourcePolicy } from "../pdf/embedpdf-viewer.js";

export const HOST_RUNTIME_PROTOCOL = "placekeeper.review-runtime" as const;
export const HOST_RUNTIME_VERSION = 1 as const;

export interface HostRuntimeIdentity {
  readonly sessionId: string;
  readonly generation: number;
  readonly revision: number;
}

export interface HostRuntimeBootstrap extends HostRuntimeIdentity {
  readonly session: ProductionSession;
  readonly state: ReviewState;
  readonly scope: ProductionScope;
  readonly saveStatus: ProductionSaveStatus;
  readonly viewerAssets: ViewerAssetUrls;
  readonly resourcePolicy: ViewerResourcePolicy;
}

export interface HostRuntimeInvalidation extends HostRuntimeIdentity {
  readonly reason: "generation" | "revision" | "freshness";
  readonly previousGeneration?: number;
}

export type HostRuntimeCommand =
  | { readonly command: "reattach" }
  | {
      readonly command: "forward-synctex";
      readonly pageIndex: number;
      readonly point: { readonly x: number; readonly y: number };
    };

export interface HostRuntime extends ProductionSessionApi {
  readonly host: "browser" | "vscode";
  bootstrap(signal?: AbortSignal): Promise<HostRuntimeBootstrap>;
  subscribeInvalidations(listener: (event: HostRuntimeInvalidation) => void): () => void;
  subscribeHostCommands?(listener: (command: HostRuntimeCommand) => void): () => void;
  exportReviewedCopy(confirmPossiblyStale?: true): Promise<ProductionExportResult>;
  forwardSyncTex(input: unknown): Promise<unknown>;
  reverseSyncTex(input: unknown): Promise<unknown>;
  dispose(): void;
}
