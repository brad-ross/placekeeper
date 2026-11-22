import { isDocumentPanelKey } from "../../../packages/core/src/review-runtime-protocol.js";

export interface DocumentBinding {
  readonly outputPath: string;
  readonly sourceRoot?: string;
}

export interface DocumentPanelLike {
  viewColumn?: number;
  reveal(viewColumn?: number, preserveFocus?: boolean): void;
  onDidDispose(listener: () => void): { dispose(): unknown };
}

export interface SerializedDocumentPanelState {
  readonly panelKey: string;
}

export interface DocumentPanelControllerOptions<Panel extends DocumentPanelLike> {
  readonly canonicalize: (path: string) => Promise<string>;
  readonly create: (binding: DocumentBinding, column: "beside") => Promise<Panel>;
  readonly detach?: (canonicalOutputPath: string) => void | Promise<void>;
  readonly resolvePanelKey?: (panelKey: string) => Promise<DocumentBinding | undefined>;
  readonly attachRestored?: (panel: Panel, binding: DocumentBinding) => Promise<void>;
}

/** Owns the one-panel-per-canonical-output invariant without owning review state. */
export class DocumentPanelController<Panel extends DocumentPanelLike> {
  readonly #options: DocumentPanelControllerOptions<Panel>;
  readonly #panels = new Map<string, Panel>();
  readonly #opening = new Map<string, Promise<Panel>>();

  constructor(options: DocumentPanelControllerOptions<Panel>) {
    this.#options = options;
  }

  async open(binding: DocumentBinding, options: { readonly preserveFocus?: boolean } = {}): Promise<Panel> {
    const canonicalOutputPath = await this.#options.canonicalize(binding.outputPath);
    const existing = this.#panels.get(canonicalOutputPath);
    if (existing !== undefined) {
      existing.reveal(existing.viewColumn, options.preserveFocus ?? false);
      return existing;
    }
    const opening = this.#opening.get(canonicalOutputPath);
    if (opening !== undefined) return opening;
    const canonicalBinding = { ...binding, outputPath: canonicalOutputPath };
    const created = this.#options.create(canonicalBinding, "beside").then((panel) => {
      this.#bind(canonicalOutputPath, panel);
      return panel;
    });
    this.#opening.set(canonicalOutputPath, created);
    try {
      return await created;
    } finally {
      if (this.#opening.get(canonicalOutputPath) === created) {
        this.#opening.delete(canonicalOutputPath);
      }
    }
  }

  async restore(
    panel: Panel,
    serialized: unknown,
  ): Promise<{ readonly status: "restored"; readonly outputPath: string } | { readonly status: "retry"; readonly reason: string }> {
    const state = parseSerializedPanelState(serialized);
    if (state === undefined || this.#options.resolvePanelKey === undefined || this.#options.attachRestored === undefined) {
      return { status: "retry", reason: "panel-state-is-unavailable" };
    }
    try {
      const binding = await this.#options.resolvePanelKey(state.panelKey);
      if (binding === undefined) return { status: "retry", reason: "panel-output-is-unavailable" };
      const canonicalOutputPath = await this.#options.canonicalize(binding.outputPath);
      await this.#options.attachRestored(panel, { ...binding, outputPath: canonicalOutputPath });
      this.#bind(canonicalOutputPath, panel);
      return { status: "restored", outputPath: canonicalOutputPath };
    } catch {
      return { status: "retry", reason: "panel-reattachment-failed" };
    }
  }

  panelFor(outputPath: string): Promise<Panel | undefined> {
    return this.#options.canonicalize(outputPath).then((canonical) => this.#panels.get(canonical));
  }

  #bind(canonicalOutputPath: string, panel: Panel): void {
    this.#panels.set(canonicalOutputPath, panel);
    panel.onDidDispose(() => {
      if (this.#panels.get(canonicalOutputPath) !== panel) return;
      this.#panels.delete(canonicalOutputPath);
      void this.#options.detach?.(canonicalOutputPath);
    });
  }
}

function parseSerializedPanelState(value: unknown): SerializedDocumentPanelState | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  return isDocumentPanelKey(input.panelKey) ? { panelKey: input.panelKey } : undefined;
}
