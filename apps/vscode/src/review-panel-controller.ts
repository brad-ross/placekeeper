export interface ReviewBinding {
  readonly outputPath: string;
  readonly sourceRoot?: string;
}

export interface ReviewPanelLike {
  viewColumn?: number;
  reveal(viewColumn?: number, preserveFocus?: boolean): void;
  onDidDispose(listener: () => void): { dispose(): unknown };
}

export interface SerializedReviewPanelState {
  readonly panelKey: string;
  readonly pageIndex?: number;
  readonly zoom?: number;
}

export interface ReviewPanelControllerOptions<Panel extends ReviewPanelLike> {
  readonly canonicalize: (path: string) => Promise<string>;
  readonly create: (binding: ReviewBinding, column: "beside") => Promise<Panel>;
  readonly detach?: (canonicalOutputPath: string) => void | Promise<void>;
  readonly resolvePanelKey?: (panelKey: string) => Promise<ReviewBinding | undefined>;
  readonly attachRestored?: (
    panel: Panel,
    binding: ReviewBinding,
    presentation: Omit<SerializedReviewPanelState, "panelKey">,
  ) => Promise<void>;
}

/** Owns the one-panel-per-canonical-output invariant without owning review state. */
export class ReviewPanelController<Panel extends ReviewPanelLike> {
  readonly #options: ReviewPanelControllerOptions<Panel>;
  readonly #panels = new Map<string, Panel>();
  readonly #opening = new Map<string, Promise<Panel>>();

  constructor(options: ReviewPanelControllerOptions<Panel>) {
    this.#options = options;
  }

  async open(binding: ReviewBinding, options: { readonly preserveFocus?: boolean } = {}): Promise<Panel> {
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
      await this.#options.attachRestored(panel, { ...binding, outputPath: canonicalOutputPath }, {
        ...(state.pageIndex === undefined ? {} : { pageIndex: state.pageIndex }),
        ...(state.zoom === undefined ? {} : { zoom: state.zoom }),
      });
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

function parseSerializedPanelState(value: unknown): SerializedReviewPanelState | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (typeof input.panelKey !== "string" || !/^[A-Za-z0-9_-]{8,128}$/u.test(input.panelKey)) return undefined;
  if (input.pageIndex !== undefined && (!Number.isSafeInteger(input.pageIndex) || (input.pageIndex as number) < 0)) return undefined;
  if (input.zoom !== undefined && (typeof input.zoom !== "number" || !Number.isFinite(input.zoom) || input.zoom <= 0)) return undefined;
  return {
    panelKey: input.panelKey,
    ...(input.pageIndex === undefined ? {} : { pageIndex: input.pageIndex as number }),
    ...(input.zoom === undefined ? {} : { zoom: input.zoom as number }),
  };
}
