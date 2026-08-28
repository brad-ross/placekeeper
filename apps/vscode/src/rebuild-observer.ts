import { dirname, extname, resolve } from "node:path";

export type ObservedFileEvent = "create" | "change" | "delete";
export type ValidationReason = "watcher" | "reveal" | "activation" | "interval";

export interface RebuildValidationInput {
  readonly outputPath: string;
  readonly observationEpoch: number;
  readonly reason: ValidationReason;
}

export interface RebuildObserverOptions<Result> {
  readonly outputPath: string;
  readonly validate: (input: RebuildValidationInput) => Promise<Result>;
  readonly markPossiblyStale: () => Promise<void>;
  readonly onCurrentResult?: (result: Result) => void;
  readonly initialEpoch?: number;
}

/** Coalesces noisy filesystem signals while leaving candidate validation to the broker. */
export class RebuildObserver<Result> {
  readonly #outputPath: string;
  readonly #watchedPaths: ReadonlySet<string>;
  readonly #validate: RebuildObserverOptions<Result>["validate"];
  readonly #markPossiblyStale: RebuildObserverOptions<Result>["markPossiblyStale"];
  readonly #onCurrentResult: RebuildObserverOptions<Result>["onCurrentResult"];
  #latestEpoch: number;
  #pendingWatcherEpoch: number | undefined;
  #possiblyStale = false;
  #disposed = false;

  constructor(options: RebuildObserverOptions<Result>) {
    this.#outputPath = resolve(options.outputPath);
    const extension = extname(this.#outputPath);
    const stem = extension.toLowerCase() === ".pdf"
      ? this.#outputPath.slice(0, -extension.length)
      : this.#outputPath;
    this.#watchedPaths = new Set([this.#outputPath, `${stem}.synctex`, `${stem}.synctex.gz`]);
    this.#validate = options.validate;
    this.#markPossiblyStale = options.markPossiblyStale;
    this.#onCurrentResult = options.onCurrentResult;
    this.#latestEpoch = options.initialEpoch ?? 0;
    if (!Number.isSafeInteger(this.#latestEpoch) || this.#latestEpoch < 0) {
      throw new RangeError("initialEpoch must be a non-negative safe integer");
    }
  }

  get directory(): string { return dirname(this.#outputPath); }
  get possiblyStale(): boolean { return this.#possiblyStale; }

  noteFileEvent(_kind: ObservedFileEvent, path: string): number | undefined {
    if (this.#disposed || !this.#watchedPaths.has(resolve(path))) return undefined;
    this.#latestEpoch += 1;
    this.#pendingWatcherEpoch = this.#latestEpoch;
    return this.#latestEpoch;
  }

  async flush(): Promise<void> {
    const epoch = this.#pendingWatcherEpoch;
    if (epoch === undefined || this.#disposed) return;
    this.#pendingWatcherEpoch = undefined;
    await this.#run(epoch, "watcher");
  }

  async noteSourceSaved(_sourcePath: string): Promise<void> {
    if (this.#disposed) return;
    this.#possiblyStale = true;
    await this.#markPossiblyStale();
  }

  async revalidate(reason: Extract<ValidationReason, "reveal" | "activation">): Promise<void> {
    if (this.#disposed) return;
    this.#latestEpoch += 1;
    await this.#run(this.#latestEpoch, reason);
  }

  async tick(): Promise<void> {
    if (this.#disposed || !this.#possiblyStale) return;
    this.#latestEpoch += 1;
    await this.#run(this.#latestEpoch, "interval");
  }

  noteCurrent(): void { this.#possiblyStale = false; }
  dispose(): void { this.#disposed = true; }

  async #run(epoch: number, reason: ValidationReason): Promise<void> {
    const result = await this.#validate({ outputPath: this.#outputPath, observationEpoch: epoch, reason });
    if (this.#disposed || epoch !== this.#latestEpoch) return;
    this.#onCurrentResult?.(result);
  }
}
