import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import type { ReviewState } from "../../../../packages/core/src/review-model.js";
import { ensurePrivateDirectory } from "./source-snapshot.js";

export interface RecoverableDraft {
  readonly schemaVersion: 1;
  readonly canonicalSourcePath: string;
  readonly sourceSnapshotPath: string;
  readonly state: ReviewState;
  readonly acknowledgedAt: string;
  readonly lastExportAt?: string;
  readonly acceptedOriginalDigests?: readonly string[];
}

interface SnapshotEnvelope {
  readonly checksum: string;
  readonly payload: RecoverableDraft;
}

export interface SnapshotHooks {
  readonly afterTemporarySync?: () => void | Promise<void>;
  readonly beforeFinalRename?: () => void | Promise<void>;
}

function serialize(draft: RecoverableDraft): string {
  const payload = JSON.stringify(draft);
  const envelope: SnapshotEnvelope = {
    checksum: createHash("sha256").update(payload).digest("hex"),
    payload: draft,
  };
  return JSON.stringify(envelope);
}

function parse(contents: string): RecoverableDraft | undefined {
  try {
    const envelope = JSON.parse(contents) as SnapshotEnvelope;
    const payload = JSON.stringify(envelope.payload);
    const checksum = createHash("sha256").update(payload).digest("hex");
    if (checksum !== envelope.checksum || envelope.payload.schemaVersion !== 1) {
      return undefined;
    }
    return envelope.payload;
  } catch {
    return undefined;
  }
}

async function readValid(path: string): Promise<RecoverableDraft | undefined> {
  try {
    return parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export class DraftSnapshotStore {
  readonly directory: string;
  readonly #hooks: SnapshotHooks;

  constructor(directory: string, hooks: SnapshotHooks = {}) {
    this.directory = directory;
    this.#hooks = hooks;
  }

  get currentPath(): string {
    return join(this.directory, "draft.json");
  }

  get previousPath(): string {
    return join(this.directory, "draft.previous.json");
  }

  async initialize(): Promise<void> {
    await ensurePrivateDirectory(this.directory);
    const entries = await import("node:fs/promises").then((fs) =>
      fs.readdir(this.directory, { withFileTypes: true }),
    );
    await Promise.all(
      entries
        .filter(
          (entry) =>
            entry.isFile() && /^\.(?:draft|source)-.*\.tmp$/u.test(entry.name),
        )
        .map((entry) => rm(join(this.directory, entry.name), { force: true })),
    );
  }

  async persist(draft: RecoverableDraft, signal?: AbortSignal): Promise<void> {
    await this.initialize();
    signal?.throwIfAborted();
    const temporaryPath = join(this.directory, `.draft-${randomUUID()}.tmp`);
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(serialize(draft), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await this.#hooks.afterTemporarySync?.();
      signal?.throwIfAborted();
      try {
        await rename(this.currentPath, this.previousPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      await this.#hooks.beforeFinalRename?.();
      signal?.throwIfAborted();
      await rename(temporaryPath, this.currentPath);
      await chmod(this.currentPath, 0o600);
      const directoryHandle = await open(this.directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  async recover(): Promise<RecoverableDraft | undefined> {
    await this.initialize();
    const candidates = await Promise.all([
      readValid(this.currentPath),
      readValid(this.previousPath),
    ]);
    return candidates
      .filter((draft): draft is RecoverableDraft => draft !== undefined)
      .sort((left, right) => right.state.revision - left.state.revision)[0];
  }

  async remove(): Promise<void> {
    await rm(this.directory, { recursive: true, force: true });
  }

  async allocatedBytes(): Promise<number> {
    await this.initialize();
    let total = 0;
    const entries = await import("node:fs/promises").then((fs) =>
      fs.readdir(this.directory, { withFileTypes: true }),
    );
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.endsWith(".tmp")) continue;
      total += (await stat(join(this.directory, entry.name))).size;
    }
    return total;
  }
}
