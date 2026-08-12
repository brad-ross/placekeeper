import type {
  LaunchSurface as BrokerLaunchSurface,
  RecoveryDecision,
} from "../sessions/session-broker.js";
import { SessionBroker } from "../sessions/session-broker.js";
import { ReviewDeliveryService } from "../delivery/review-delivery-service.js";
import {
  startHttpServer,
  type LocalHttpServer,
  type WebAssetOptions,
} from "../server/http-server.js";
import { createSelectedPdfWriter } from "../../../../packages/pdf-backends/src/selected-writer.js";
import { PdfSaveCoordinator } from "../saving/pdf-save-coordinator.js";
import { MacOsDestinationPicker } from "./destination-picker.js";
import { LiveContextService } from "../context/live-context-service.js";

export type LaunchSurface = BrokerLaunchSurface;

export interface LaunchRequest {
  readonly pdfPath: string;
  readonly sourceRootPath?: string;
  readonly fork?: boolean;
  readonly recovery?: RecoveryDecision;
  readonly surface?: LaunchSurface;
}

export interface LaunchFailure {
  readonly kind: "input-unavailable" | "unsupported-context";
  readonly message: string;
  readonly recoveryAction:
    | "Choose one readable local PDF"
    | "Choose a supported local workspace";
}

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
    }
  | { readonly ok: false; readonly error: LaunchFailure };

export interface ProofreaderHostOptions {
  readonly recoveryRoot: string;
  readonly webAssets?: WebAssetOptions;
}

function failure(
  kind: LaunchFailure["kind"],
  message: string,
): LaunchResponse {
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
  if (!["browser", "finder", "codex", "vscode"].includes(surface)) {
    throw new TypeError("Unsupported launch surface");
  }
  return surface;
}

/** One long-lived host owns the only broker and HTTP authority used by all launchers. */
export class ProofreaderHost {
  readonly broker: SessionBroker;
  readonly server: LocalHttpServer;
  readonly context: LiveContextService;

  private constructor(
    broker: SessionBroker,
    server: LocalHttpServer,
    context: LiveContextService,
  ) {
    this.broker = broker;
    this.server = server;
    this.context = context;
  }

  static async start(options: ProofreaderHostOptions): Promise<ProofreaderHost> {
    const broker = new SessionBroker({ recoveryRoot: options.recoveryRoot });
    await broker.initialize();
    const delivery = await ReviewDeliveryService.create(broker);
    const saving = new PdfSaveCoordinator({
      broker,
      writer: await createSelectedPdfWriter(),
      ...(process.platform === "darwin" ? { picker: new MacOsDestinationPicker() } : {}),
    });
    const server = await startHttpServer(broker, {
      ...(options.webAssets === undefined ? {} : { webAssets: options.webAssets }),
      delivery,
      saving,
    });
    return new ProofreaderHost(broker, server, new LiveContextService({ broker }));
  }

  async open(request: LaunchRequest): Promise<LaunchResponse> {
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
        surface,
      });
      if (opened.kind === "recovery-offered") {
        return {
          ok: true,
          kind: "recovery-offered",
          recoverySessionId: opened.recoverySessionId,
          choices: opened.choices,
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

  close(): Promise<void> {
    return this.server.close();
  }
}
