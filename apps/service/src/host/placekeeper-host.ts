import type {
  LaunchSurface as BrokerLaunchSurface,
  RecoveryDecision,
  RecoveryOfferIdentity,
} from "../sessions/session-broker.js";
import { isLaunchSurface, SessionBroker } from "../sessions/session-broker.js";
import {
  startHttpServer,
  type LocalHttpServer,
  type WebAssetOptions,
} from "../server/http-server.js";
import { createSelectedPdfWriter } from "../../../../packages/pdf-backends/src/selected-writer.js";
import { PdfSaveCoordinator } from "../saving/pdf-save-coordinator.js";
import { MacOsDestinationPicker } from "./destination-picker.js";
import { LiveContextService } from "../context/live-context-service.js";
import { SourceReconciliationService } from "../context/source-reconciliation-service.js";
import { LiveSourceWorkflowService } from "../context/live-source-workflow-service.js";
import type { TaskBindingRegistry } from "../context/task-binding-registry.js";
import { DaemonLifecycleCoordinator } from "./daemon-lifecycle.js";
import { decodePlacekeeperLink } from "../../../../packages/core/src/placekeeper-link.js";
import { openPlacekeeperLink } from "../links/placekeeper-link.js";
import type { ReviewWorkflowMode } from "../../../../packages/core/src/review-model.js";
import { ExportCoordinator, type FrozenReviewDelivery } from "../export/export-coordinator.js";
import {
  BrowserSourceStore,
  type ChromeBrowserSourceOpenRequest,
} from "../browser/browser-source-store.js";
import type { ChromePdfInspection } from "../browser/chrome-pdf-validator.js";
import { dirname, join } from "node:path";
import { ChromeTransferStore } from "../browser/chrome-handoff.js";
import { validatePdfInSubprocess } from "../browser/chrome-pdf-validator.js";
import { ChromeRuntimeManager } from "../browser/chrome-runtime.js";
import { ChromeServiceRuntimeBackend } from "../browser/chrome-runtime-backend.js";
import { MacosRuntimeManager } from "../macos/macos-runtime.js";
import { MacosAppLifecycleManager } from "../macos/app-lifecycle.js";

export type LaunchSurface = BrokerLaunchSurface;

export interface LaunchRequest {
  readonly pdfPath: string;
  readonly sourceRootPath?: string;
  readonly fork?: boolean;
  readonly recovery?: RecoveryDecision;
  readonly recoveryOffer?: RecoveryOfferIdentity;
  readonly recoveryOperationId?: string;
  readonly surface?: LaunchSurface;
  readonly workflowMode?: ReviewWorkflowMode;
}

export interface LaunchFailure {
  readonly kind: "input-unavailable" | "unsupported-context" | "upgrade-required";
  readonly message: string;
  readonly recoveryAction: string;
}

export interface LinkOpenRequest {
  readonly link: string;
  readonly confirmed?: boolean;
  readonly recovery?: RecoveryDecision;
  readonly recoveryOffer?: RecoveryOfferIdentity;
  readonly recoveryOperationId?: string;
  readonly surface?: LaunchSurface;
}

export type LinkPreflightResponse =
  | {
      readonly ok: true;
      readonly kind: "link-preflight";
      readonly path: string;
      readonly confirmationRequired: boolean;
    }
  | { readonly ok: false; readonly error: LaunchFailure };

export type LinkLaunchResponse = LaunchResponse | {
  readonly ok: true;
  readonly kind: "confirmation-required";
  readonly path: string;
};

export type LaunchResponse =
  | {
      readonly ok: true;
      readonly kind: "opened" | "focused";
      readonly url: string;
      readonly sessionId: string;
      readonly documentGeneration: number;
      readonly bindProof?: string;
    }
  | {
      readonly ok: true;
      readonly kind: "recovery-offered";
      readonly recoverySessionId: string;
      readonly choices: readonly RecoveryDecision[];
      readonly recoveryOffer: RecoveryOfferIdentity;
    }
  | { readonly ok: false; readonly error: LaunchFailure };

export interface PlacekeeperHostOptions {
  readonly recoveryRoot: string;
  readonly browserSourceRoot?: string;
  readonly webAssets?: WebAssetOptions;
  readonly taskBindings?: TaskBindingRegistry;
  readonly port?: number;
  readonly browserSourceInspector?: (
    path: string,
    signal?: AbortSignal,
  ) => Promise<ChromePdfInspection>;
}

function failure(
  kind: Exclude<LaunchFailure["kind"], "upgrade-required">,
  message: string,
): { readonly ok: false; readonly error: LaunchFailure } {
  return {
    ok: false,
    error: {
      kind,
      message,
      recoveryAction:
        kind === "input-unavailable"
          ? "Choose one readable local PDF"
          : "Choose a supported local workspace",
    },
  };
}

function upgradeFailure(): { readonly ok: false; readonly error: LaunchFailure } {
  return {
    ok: false,
    error: {
      kind: "upgrade-required",
      message: "Placekeeper is restarting after an upgrade. Retry this launch.",
      recoveryAction: "Close Placekeeper reviews and retry",
    },
  };
}

function launchUrl(
  origin: string,
  launch: { readonly launchPath: string; readonly fragment: string },
  surface: LaunchSurface,
): string {
  const url = new URL(launch.launchPath, origin);
  if (surface === "vscode") url.searchParams.set("embed", "vscode");
  url.hash = launch.fragment.slice(1);
  return url.href;
}

function trustedSurface(value: LaunchRequest["surface"]): LaunchSurface {
  const surface = value ?? "browser";
  if (!isLaunchSurface(surface)) {
    throw new TypeError("Unsupported launch surface");
  }
  return surface;
}

/** One long-lived host owns the only broker and HTTP authority used by all launchers. */
export class PlacekeeperHost {
  readonly broker: SessionBroker;
  readonly server: LocalHttpServer;
  readonly context: LiveContextService;
  readonly reconciliation: SourceReconciliationService;
  readonly sourceWorkflow: LiveSourceWorkflowService;
  readonly saving: PdfSaveCoordinator;
  readonly exporting: ExportCoordinator;
  readonly lifecycle: DaemonLifecycleCoordinator;
  readonly browserSources: BrowserSourceStore;
  readonly chromeRuntime: ChromeRuntimeManager;
  readonly macosRuntime: MacosRuntimeManager;
  readonly macosLifecycle: MacosAppLifecycleManager;
  #closePromise?: Promise<void>;

  private constructor(
    broker: SessionBroker,
    server: LocalHttpServer,
    context: LiveContextService,
    reconciliation: SourceReconciliationService,
    sourceWorkflow: LiveSourceWorkflowService,
    saving: PdfSaveCoordinator,
    exporting: ExportCoordinator,
    lifecycle: DaemonLifecycleCoordinator,
    browserSources: BrowserSourceStore,
    chromeRuntime: ChromeRuntimeManager,
    macosRuntime: MacosRuntimeManager,
    macosLifecycle: MacosAppLifecycleManager,
  ) {
    this.broker = broker;
    this.server = server;
    this.context = context;
    this.reconciliation = reconciliation;
    this.sourceWorkflow = sourceWorkflow;
    this.saving = saving;
    this.exporting = exporting;
    this.lifecycle = lifecycle;
    this.browserSources = browserSources;
    this.chromeRuntime = chromeRuntime;
    this.macosRuntime = macosRuntime;
    this.macosLifecycle = macosLifecycle;
  }

  static async start(options: PlacekeeperHostOptions): Promise<PlacekeeperHost> {
    const broker = new SessionBroker({
      recoveryRoot: options.recoveryRoot,
      ...(options.taskBindings === undefined ? {} : { taskBindings: options.taskBindings }),
      ...(options.browserSourceInspector === undefined
        ? {}
        : { browserSourceInspector: options.browserSourceInspector }),
    });
    await broker.initialize();
    const writer = await createSelectedPdfWriter();
    const browserSources = await BrowserSourceStore.create(
      options.browserSourceRoot ?? join(dirname(options.recoveryRoot), "browser-sources"),
    );
    const saving = new PdfSaveCoordinator({
      broker,
      writer,
      ...(process.platform === "darwin" ? { picker: new MacOsDestinationPicker() } : {}),
    });
    const exporting = new ExportCoordinator({
      writer,
      capabilities: broker.capabilities,
      controls: broker.controls,
      recordSuccessfulExport: (sessionId) => broker.recordSuccessfulExport(sessionId),
      validateFrozenDelivery: (delivery) => broker.isFrozenDeliveryCurrent(delivery as FrozenReviewDelivery),
    });
    const chromeTransferStore = await ChromeTransferStore.create({
      root: browserSources.root,
      validate: options.browserSourceInspector === undefined
        ? validatePdfInSubprocess
        : async (path) => { await options.browserSourceInspector!(path); },
    });
    const chromeRuntimeBackend = new ChromeServiceRuntimeBackend({
      broker, browserSources, transferStore: chromeTransferStore, saving, exporting,
    });
    const chromeRuntime = new ChromeRuntimeManager(chromeRuntimeBackend.authority());
    const macosRuntimeBackend = new ChromeServiceRuntimeBackend({
      broker, browserSources, transferStore: chromeTransferStore, saving, exporting,
      runtimeHost: "macos",
    });
    const macosRuntime = new MacosRuntimeManager(macosRuntimeBackend.authority());
    const macosLifecycle = new MacosAppLifecycleManager(macosRuntime);
    const lifecycle = new DaemonLifecycleCoordinator({
      activity: () => {
        const activity = broker.activity();
        const chromeActivity = chromeRuntime.activity();
        const macosActivity = macosRuntime.activity();
        const macosAppActivity = macosLifecycle.activity();
        return {
          ...activity,
          reviewPresence: activity.reviewPresence + chromeActivity.connections
            + macosActivity.helpers + macosAppActivity.appInstances,
          transientWork: activity.transientWork + saving.activityCount(),
        };
      },
      drain: async () => {
        await saving.drain();
        await broker.drainWrites();
      },
    });
    const server = await startHttpServer(broker, {
      ...(options.port === undefined ? {} : { port: options.port }),
      ...(options.webAssets === undefined ? {} : { webAssets: options.webAssets }),
      saving,
      exporting,
      lifecycle,
    });
    const context = new LiveContextService({ broker });
    const reconciliation = new SourceReconciliationService({ broker });
    const sourceWorkflow = new LiveSourceWorkflowService({ broker, context, reconciliation });
    broker.onGenerationAdvance((event) => {
      // Observation cursors, evidence handles, source hints, and source-work
      // baselines are generation-bound even when the exact task lease migrates.
      context.discardSession(event.sessionId);
      if (event.migratedTaskSessionId !== undefined) {
        sourceWorkflow.discardTask(event.migratedTaskSessionId);
      }
    });
    return new PlacekeeperHost(
      broker,
      server,
      context,
      reconciliation,
      sourceWorkflow,
      saving,
      exporting,
      lifecycle,
      browserSources,
      chromeRuntime,
      macosRuntime,
      macosLifecycle,
    );
  }

  async open(request: LaunchRequest): Promise<LaunchResponse> {
    const response = await this.lifecycle.runActivity(() => this.#open(request));
    return response ?? upgradeFailure();
  }

  async openChromeBrowserSource(
    request: ChromeBrowserSourceOpenRequest,
    signal?: AbortSignal,
  ): Promise<LaunchResponse> {
    const response = await this.lifecycle.runActivity(async () => {
      try {
        const opened = await this.broker.openChromeBrowserSource(request, this.browserSources, signal);
        if (opened.kind === "recovery-offered") {
          throw new Error("Remote acquisitions cannot reuse protected recovery");
        }
        return {
          ok: true as const,
          kind: opened.kind,
          url: launchUrl(this.server.origin, opened.launch, "browser"),
          sessionId: opened.launch.sessionId,
          documentGeneration: opened.launch.documentGeneration,
        };
      } catch {
        return failure("input-unavailable", "The browser PDF could not be opened.");
      }
    });
    return response ?? upgradeFailure();
  }

  async preflightLink(link: string): Promise<LinkPreflightResponse> {
    const response = await this.lifecycle.runActivity<LinkPreflightResponse>(() => {
      try {
        const decoded = decodePlacekeeperLink(link);
        return {
          ok: true,
          kind: "link-preflight",
          path: decoded.path,
          confirmationRequired: !this.broker.activeReviewOwnsPath(decoded.path),
        };
      } catch (error) {
        return failure(
          "input-unavailable",
          error instanceof Error ? error.message : "The Placekeeper link is invalid.",
        );
      }
    });
    return response ?? upgradeFailure();
  }

  async openLink(request: LinkOpenRequest): Promise<LinkLaunchResponse> {
    const response = await this.lifecycle.runActivity(() => this.#openLink(request));
    return response ?? upgradeFailure();
  }

  async #openLink(request: LinkOpenRequest): Promise<LinkLaunchResponse> {
    try {
      const surface = trustedSurface(request.surface);
      const opened = await openPlacekeeperLink(this.broker, {
        link: request.link,
        ...(request.confirmed === undefined ? {} : { confirmed: request.confirmed }),
        ...(request.recovery === undefined ? {} : { recovery: request.recovery }),
        ...(request.recoveryOffer === undefined ? {} : { recoveryOffer: request.recoveryOffer }),
        ...(request.recoveryOperationId === undefined
          ? {}
          : { recoveryOperationId: request.recoveryOperationId }),
        surface,
      });
      if (opened.kind === "confirmation-required") {
        return { ok: true, ...opened };
      }
      if (opened.kind === "recovery-offered") {
        return {
          ok: true,
          kind: "recovery-offered",
          recoverySessionId: opened.recoverySessionId,
          choices: opened.choices,
          recoveryOffer: opened.recoveryOffer,
        };
      }
      return {
        ok: true,
        kind: opened.kind,
        url: launchUrl(this.server.origin, opened.launch, surface),
        sessionId: opened.launch.sessionId,
        documentGeneration: opened.launch.documentGeneration,
        ...(opened.launch.bindProof === undefined
          ? {}
          : { bindProof: opened.launch.bindProof }),
      };
    } catch (error) {
      return failure(
        "input-unavailable",
        error instanceof Error
          ? error.message
          : "The Placekeeper link is invalid.",
      );
    }
  }

  async #open(request: LaunchRequest): Promise<LaunchResponse> {
    if (typeof request.pdfPath !== "string" || request.pdfPath.length === 0) {
      return failure("input-unavailable", "Open exactly one readable local PDF.");
    }
    const recoveryDecision: RecoveryDecision | undefined =
      request.fork === true ? "fork" : request.recovery;
    try {
      const surface = trustedSurface(request.surface);
      const opened = await this.broker.openReview({
        pdfPath: request.pdfPath,
        ...(request.sourceRootPath === undefined
          ? {}
          : { sourceRootPath: request.sourceRootPath }),
        ...(recoveryDecision === undefined ? {} : { recoveryDecision }),
        ...(request.recoveryOffer === undefined ? {} : { recoveryOffer: request.recoveryOffer }),
        ...(request.recoveryOperationId === undefined
          ? {}
          : { recoveryOperationId: request.recoveryOperationId }),
        surface,
        ...(request.workflowMode === undefined ? {} : { workflowMode: request.workflowMode }),
      });
      if (opened.kind === "recovery-offered") {
        return {
          ok: true,
          kind: "recovery-offered",
          recoverySessionId: opened.recoverySessionId,
          choices: opened.choices,
          recoveryOffer: opened.recoveryOffer,
        };
      }
      return {
        ok: true,
        kind: opened.kind,
        url: launchUrl(this.server.origin, opened.launch, surface),
        sessionId: opened.launch.sessionId,
        documentGeneration: opened.launch.documentGeneration,
        ...(opened.launch.bindProof === undefined
          ? {}
          : { bindProof: opened.launch.bindProof }),
      };
    } catch (error) {
      return request.sourceRootPath === undefined
        ? failure("input-unavailable", "Open exactly one readable local PDF.")
        : failure("unsupported-context", "Choose a readable local source workspace.");
    }
  }

  async close(): Promise<void> {
    this.#closePromise ??= (async () => {
      this.context.discardAll();
      await this.server.close();
      await this.chromeRuntime.close();
      await this.macosLifecycle.close();
      await this.macosRuntime.close();
      await this.saving.drain();
      await this.broker.quiesceForShutdown();
    })();
    await this.#closePromise;
  }
}
