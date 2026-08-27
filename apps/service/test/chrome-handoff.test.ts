import { lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CHROME_EXTENSION_ORIGIN,
  ChromeHandoffSession,
  ChromeTransferQuota,
  ChromeTransferStore,
  type ChromeBrowserReviewOpener,
  type SealedBrowserSourceHandle,
} from "../src/browser/chrome-handoff.js";
import { validatePdfFile, validatePdfInSubprocess } from "../src/browser/chrome-pdf-validator.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(options: {
  readonly opener?: ChromeBrowserReviewOpener;
  readonly quota?: ChromeTransferQuota;
  readonly validate?: (path: string) => Promise<void>;
  readonly maxTransferBytes?: number;
  readonly maxAggregateBytes?: number;
  readonly now?: () => number;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "placekeeper-chrome-handoff-"));
  roots.push(root);
  const destination =
    "http://127.0.0.1:43179/s/779e1d9d-58c1-4b12-8dc2-3449dad132c1/bootstrap#cap=1234567890123456789012345678901234567890123";
  const opened: Array<string | SealedBrowserSourceHandle> = [];
  const opener = options.opener ?? {
    async openLocal(path: string) { opened.push(path); return destination; },
    async openSealed(handle: SealedBrowserSourceHandle) { opened.push(handle); return destination; },
  };
  const store = await ChromeTransferStore.create({
    root: join(root, "browser-sources"),
    validate: options.validate ?? (async (path) => {
      const bytes = await readFile(path);
      if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("invalid-pdf");
    }),
    ...(options.maxAggregateBytes === undefined
      ? {}
      : { maxAggregateBytes: options.maxAggregateBytes }),
  });
  const session = new ChromeHandoffSession({
    callerOrigin: CHROME_EXTENSION_ORIGIN,
    store,
    opener,
    quota: options.quota ?? new ChromeTransferQuota(),
    ...(options.maxTransferBytes === undefined ? {} : { maxTransferBytes: options.maxTransferBytes }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { root, destination, opened, store, session };
}

describe("bounded Chrome handoff", () => {
  it("acks ordered chunks, seals a private 0600 PDF, and opens one browser review", async () => {
    const { destination, opened, store, session } = await fixture();
    await expect(session.handle({
      type: "start", protocolVersion: 1, transferId: "transfer-1",
      disposition: "remote-temporary", displayName: "Paper.pdf",
    })).resolves.toEqual({ type: "ack", transferId: "transfer-1", phase: "start" });
    await expect(session.handle({
      type: "chunk", transferId: "transfer-1", sequence: 0,
      data: Buffer.from("%PDF-1.7\nbody\n%%EOF").toString("base64"),
    })).resolves.toEqual({ type: "ack", transferId: "transfer-1", phase: "chunk", sequence: 0 });
    await expect(session.handle({ type: "finish", transferId: "transfer-1", sequence: 1 }))
      .resolves.toEqual({ type: "success", transferId: "transfer-1", destination });

    expect(opened).toHaveLength(1);
    const handle = opened[0] as SealedBrowserSourceHandle;
    const sealed = await store.inspect(handle);
    expect(sealed).toMatchObject({ disposition: "remote-temporary", displayName: "Paper.pdf" });
    expect((await lstat(sealed.path)).mode & 0o777).toBe(0o600);
    expect(await readFile(sealed.path, "utf8")).toBe("%PDF-1.7\nbody\n%%EOF");
  });

  it("opens the exact canonical local PDF without staging a copy or granting Codex scope", async () => {
    const { root, opened, store, session } = await fixture();
    const pdf = join(root, "Exact paper.pdf");
    await writeFile(pdf, "%PDF-1.7\nlocal\n%%EOF");

    await session.handle({
      type: "start", protocolVersion: 1, transferId: "transfer-local",
      disposition: "local", fileUrl: pathToFileURL(pdf).href,
    });
    await expect(session.handle({ type: "finish", transferId: "transfer-local", sequence: 0 }))
      .resolves.toMatchObject({ type: "success", transferId: "transfer-local" });

    expect(opened).toEqual([await realpath(pdf)]);
    expect(await readdir(store.root)).toEqual([]);
  });

  it.each([
    ["out-of-order", { type: "chunk", transferId: "transfer-1", sequence: 1, data: "JVBERi0=" }],
    ["source-mode-mutation", { type: "start", protocolVersion: 1, transferId: "transfer-1", disposition: "local", fileUrl: "file:///tmp/x.pdf" }],
    ["daemon-control", { kind: "management", protocolVersion: 1, operation: "shutdown-if-idle" }],
  ])("fails closed for %s input and removes the partial", async (_name, message) => {
    const { store, session } = await fixture();
    await session.handle({
      type: "start", protocolVersion: 1, transferId: "transfer-1", disposition: "remote-temporary",
    });
    await expect(session.handle(message)).resolves.toMatchObject({ type: "failure", transferId: "transfer-1" });
    expect(await readdir(store.root)).toEqual([]);
  });

  it("cleans up on invalid PDF, oversized totals, disconnect, timeout, and service failure", async () => {
    let now = 0;
    const opener: ChromeBrowserReviewOpener = {
      async openLocal() { throw new Error("service details must not escape"); },
      async openSealed() { throw new Error("socket /private/path control.sock failed"); },
    };
    for (const mode of ["invalid", "oversized", "disconnect", "timeout", "service"] as const) {
      const { store, session } = await fixture({
        opener,
        maxTransferBytes: mode === "oversized" ? 4 : 1024,
        now: () => now,
      });
      await session.handle({
        type: "start", protocolVersion: 1, transferId: `transfer-${mode}`,
        disposition: "remote-temporary",
      });
      if (mode === "disconnect") await session.disconnect();
      else if (mode === "timeout") {
        now = 60_001;
        await expect(session.handle({
          type: "chunk", transferId: `transfer-${mode}`, sequence: 0, data: "JVBERi0=",
        })).resolves.toMatchObject({ type: "failure", reason: "transfer-timeout" });
      } else {
        const data = mode === "invalid" ? Buffer.from("not a pdf") : Buffer.from("%PDF-1.7\n%%EOF");
        const chunk = await session.handle({
          type: "chunk", transferId: `transfer-${mode}`, sequence: 0, data: data.toString("base64"),
        });
        if (mode === "oversized") expect(chunk).toMatchObject({ type: "failure", reason: "transfer-too-large" });
        else await expect(session.handle({
          type: "finish", transferId: `transfer-${mode}`, sequence: 1,
        })).resolves.toMatchObject({
          type: "failure",
          reason: mode === "service" ? "service-unavailable" : "invalid-pdf",
        });
      }
      expect(await readdir(store.root)).toEqual([]);
    }
  });

  it("enforces exact origin, version, concurrent and aggregate byte quotas", async () => {
    const sharedQuota = new ChromeTransferQuota({ maxConcurrentTransfers: 1, maxAggregateBytes: 8 });
    const first = await fixture({ quota: sharedQuota });
    const second = await fixture({ quota: sharedQuota });
    await first.session.handle({
      type: "start", protocolVersion: 1, transferId: "transfer-1", disposition: "remote-temporary",
    });
    await expect(second.session.handle({
      type: "start", protocolVersion: 1, transferId: "transfer-2", disposition: "remote-temporary",
    })).resolves.toMatchObject({ type: "failure", reason: "host-busy" });
    await expect(first.session.handle({
      type: "chunk", transferId: "transfer-1", sequence: 0,
      data: Buffer.alloc(9).toString("base64"),
    })).resolves.toMatchObject({ type: "failure", reason: "host-byte-budget" });

    expect(() => new ChromeHandoffSession({
      callerOrigin: "chrome-extension://evil/",
      store: first.store,
      opener: { openLocal: vi.fn(), openSealed: vi.fn() },
    })).toThrow("unauthorized-origin");
    const version = await fixture();
    await expect(version.session.handle({
      type: "start", protocolVersion: 0, transferId: "transfer-3", disposition: "remote-temporary",
    })).resolves.toMatchObject({ type: "failure", reason: "protocol-mismatch" });
  });

  it("counts sealed sources against the persistent aggregate disk budget", async () => {
    const { store, session } = await fixture({ maxAggregateBytes: 12 });
    await session.handle({
      type: "start", protocolVersion: 1, transferId: "transfer-1", disposition: "remote-temporary",
    });
    await session.handle({
      type: "chunk", transferId: "transfer-1", sequence: 0,
      data: Buffer.from("%PDF-123").toString("base64"),
    });
    await session.handle({ type: "finish", transferId: "transfer-1", sequence: 1 });

    const next = new ChromeHandoffSession({
      callerOrigin: CHROME_EXTENSION_ORIGIN,
      store,
      opener: { async openLocal() { throw new Error("unused"); }, async openSealed() { throw new Error("unused"); } },
    });
    await next.handle({
      type: "start", protocolVersion: 1, transferId: "transfer-2", disposition: "remote-temporary",
    });
    await expect(next.handle({
      type: "chunk", transferId: "transfer-2", sequence: 0,
      data: Buffer.from("%PDF-").toString("base64"),
    })).resolves.toMatchObject({ type: "failure", reason: "host-byte-budget" });
  });

  it.each([
    "http://user@127.0.0.1:43179/s/779e1d9d-58c1-4b12-8dc2-3449dad132c1/bootstrap#cap=1234567890123456789012345678901234567890123",
    "http://127.0.0.1:43179/s/779e1d9d-58c1-1b12-8dc2-3449dad132c1/bootstrap#cap=1234567890123456789012345678901234567890123",
  ])("rejects a malformed service destination: %s", async (destination) => {
    const opener: ChromeBrowserReviewOpener = {
      async openLocal() { return destination; },
      async openSealed() { return destination; },
    };
    const { root, session } = await fixture({ opener });
    const pdf = join(root, "local.pdf");
    await writeFile(pdf, "%PDF-1.7\n%%EOF");
    await session.handle({
      type: "start", protocolVersion: 1, transferId: "transfer-local",
      disposition: "local", fileUrl: pathToFileURL(pdf).href,
    });
    await expect(session.handle({ type: "finish", transferId: "transfer-local", sequence: 0 }))
      .resolves.toMatchObject({ type: "failure", reason: "service-unavailable" });
  });

  it("enforces concurrent admission across independent native-host store instances", async () => {
    const root = await mkdtemp(join(tmpdir(), "placekeeper-shared-store-"));
    roots.push(root);
    const sourceRoot = join(root, "sources");
    const validate = async () => undefined;
    const firstStore = await ChromeTransferStore.create({
      root: sourceRoot,
      validate,
      maxConcurrentTransfers: 1,
    });
    const secondStore = await ChromeTransferStore.create({
      root: sourceRoot,
      validate,
      maxConcurrentTransfers: 1,
    });
    const opener: ChromeBrowserReviewOpener = {
      async openLocal() { throw new Error("unused"); },
      async openSealed() { throw new Error("unused"); },
    };
    const first = new ChromeHandoffSession({
      callerOrigin: CHROME_EXTENSION_ORIGIN,
      store: firstStore,
      opener,
    });
    const second = new ChromeHandoffSession({
      callerOrigin: CHROME_EXTENSION_ORIGIN,
      store: secondStore,
      opener,
    });
    await first.handle({
      type: "start", protocolVersion: 1, transferId: "transfer-1", disposition: "remote-temporary",
    });
    await expect(second.handle({
      type: "start", protocolVersion: 1, transferId: "transfer-2", disposition: "remote-temporary",
    })).resolves.toMatchObject({ type: "failure", reason: "host-busy" });
    await first.disconnect();
  });

  it("rejects symlink staging roots and malformed local file URLs", async () => {
    const root = await mkdtemp(join(tmpdir(), "placekeeper-chrome-root-"));
    roots.push(root);
    const target = join(root, "target");
    const alias = join(root, "alias");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, alias);
    await expect(ChromeTransferStore.create({ root: alias, validate: async () => undefined }))
      .rejects.toThrow("secure directory");

    const { session } = await fixture();
    await session.handle({
      type: "start", protocolVersion: 1, transferId: "transfer-local",
      disposition: "local", fileUrl: "file://attacker.example/tmp/paper.pdf",
    });
    await expect(session.handle({ type: "finish", transferId: "transfer-local", sequence: 0 }))
      .resolves.toMatchObject({ type: "failure", reason: "invalid-local-source" });
  });

  it("fails closed when an untrusted partial entry appears inside the private root", async () => {
    const { root, store, session } = await fixture();
    const outside = join(root, "outside.partial");
    await writeFile(outside, "not transfer state");
    await symlink(outside, join(store.root, "hostile.partial"));
    await session.handle({
      type: "start",
      protocolVersion: 1,
      transferId: "transfer-1",
      disposition: "remote-temporary",
    });

    await expect(session.handle({
      type: "chunk",
      transferId: "transfer-1",
      sequence: 0,
      data: Buffer.from("%PDF-").toString("base64"),
    })).resolves.toMatchObject({ type: "failure", reason: "host-byte-budget" });
    expect(await readFile(outside, "utf8")).toBe("not transfer state");
    expect(await readdir(store.root)).toEqual(["hostile.partial"]);
  });

  it("kills a stalled structural validator without stalling the caller", async () => {
    const root = await mkdtemp(join(tmpdir(), "placekeeper-validator-"));
    roots.push(root);
    const worker = join(root, "stall.mjs");
    await writeFile(worker, "setInterval(() => undefined, 1000);\n");

    await expect(validatePdfInSubprocess("/private/redacted.pdf", {
      entryPath: worker,
      execArgv: [],
      timeoutMs: 25,
    })).rejects.toThrow("validation-timeout");
  });

  it.each(["/Encrypt", "/DocMDP"])("rejects a structurally restricted %s source", async (marker) => {
    const root = await mkdtemp(join(tmpdir(), "placekeeper-restricted-pdf-"));
    roots.push(root);
    const path = join(root, "restricted.pdf");
    await writeFile(path, `%PDF-1.7\n${marker}\n%%EOF`);

    await expect(validatePdfFile(path)).rejects.toThrow("invalid-pdf");
  });
});
