import { createHash, randomBytes, randomUUID } from "node:crypto";
import { access, lstat, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BrowserSourceStore,
  isChromeBrowserSourceOpenRequest,
  type ChromeBrowserSourceOpenRequest,
} from "../src/browser/browser-source-store.js";
import { DraftSnapshotStore } from "../src/recovery/draft-snapshot.js";
import { SessionBroker } from "../src/sessions/session-broker.js";
import { addPageNote } from "../../../packages/core/src/review-commands.js";
import { encodePlacekeeperLink } from "../../../packages/core/src/placekeeper-link.js";
import { openPlacekeeperLink } from "../src/links/placekeeper-link.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "placekeeper-browser-source-"));
  roots.push(root);
  const browserRoot = join(root, "browser-sources");
  const recoveryRoot = join(root, "recovery");
  const store = await BrowserSourceStore.create(browserRoot);
  const bytes = Buffer.from("%PDF-1.7\nbrowser source\n%%EOF");
  const request = async (displayName = "Private paper.pdf"): Promise<ChromeBrowserSourceOpenRequest> => {
    const sourceHandle = randomBytes(24).toString("base64url");
    await writeFile(join(browserRoot, `${sourceHandle}.pdf`), bytes, { mode: 0o600 });
    return {
      protocolVersion: 1,
      sourceHandle,
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      displayName,
    };
  };
  return { root, browserRoot, recoveryRoot, store, bytes, request };
}

describe("temporary browser source ownership", () => {
  it("moves one sealed inode into recovery ownership and validates the closed request schema", async () => {
    const value = await fixture();
    const request = await value.request("../Secret.pdf");
    const stagedPath = join(value.browserRoot, `${request.sourceHandle}.pdf`);
    const stagedInode = (await stat(stagedPath)).ino;
    const sessionDirectory = join(value.recoveryRoot, randomUUID());

    const adopted = await value.store.adopt(request, sessionDirectory);

    expect(adopted).toMatchObject({
      disposition: "remote-temporary",
      displayName: "Secret.pdf",
      sha256: request.sha256,
      byteLength: request.byteLength,
    });
    expect((await stat(adopted.path)).ino).toBe(stagedInode);
    await expect(access(stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(adopted.path)).mode & 0o777).toBe(0o600);
    expect(isChromeBrowserSourceOpenRequest(request)).toBe(true);
    expect(isChromeBrowserSourceOpenRequest({ ...request, kind: "management" })).toBe(false);
  });

  it("creates independent acquisitions, projects no private path, and deletes clean ownership", async () => {
    const value = await fixture();
    const broker = new SessionBroker({ recoveryRoot: value.recoveryRoot, portableReader: async () => [] });
    const first = await broker.openChromeBrowserSource(await value.request(), value.store);
    const second = await broker.openChromeBrowserSource(await value.request(), value.store);
    if (first.kind !== "opened" || second.kind !== "opened") throw new Error("Expected opens");

    expect(second.launch.sessionId).not.toBe(first.launch.sessionId);
    expect(await readdir(value.browserRoot)).toEqual([]);
    const firstDraft = await new DraftSnapshotStore(
      join(value.recoveryRoot, first.launch.sessionId),
    ).recover();
    const secondDraft = await new DraftSnapshotStore(
      join(value.recoveryRoot, second.launch.sessionId),
    ).recover();
    expect(firstDraft?.source).toMatchObject({ disposition: "remote-temporary" });
    expect(secondDraft?.source).toMatchObject({ disposition: "remote-temporary" });
    expect(secondDraft?.source).not.toMatchObject({ acquisitionId: firstDraft?.source.disposition === "remote-temporary" ? firstDraft.source.acquisitionId : "" });
    expect(await readFile(
      join(value.recoveryRoot, first.launch.sessionId, "draft.json"),
      "utf8",
    )).not.toContain(value.root);

    const scope = await broker.sessionScope(first.launch.sessionId);
    expect(scope).toMatchObject({
      documentTitle: "Private paper.pdf",
      sourceDisposition: "remote-temporary",
      sourceDisplayName: "Private paper.pdf",
    });
    expect(JSON.stringify(scope)).not.toContain(value.root);
    const capability = new URLSearchParams(first.launch.fragment.slice(1)).get("cap")!;
    const exchange = broker.exchangeBootstrapForHttp(first.launch.sessionId, capability);
    expect(exchange?.view?.pathname).toContain("/Placekeeper%20Browser/");
    expect(exchange?.view?.pathname).not.toContain(encodeURIComponent(value.root));

    await broker.finish(first.launch.sessionId);
    await expect(access(join(value.recoveryRoot, first.launch.sessionId))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains a dirty remote source across restart and resumes with its disposition", async () => {
    const value = await fixture();
    const first = new SessionBroker({ recoveryRoot: value.recoveryRoot, portableReader: async () => [] });
    const opened = await first.openChromeBrowserSource(await value.request("Restart.pdf"), value.store);
    if (opened.kind !== "opened") throw new Error("Expected open");
    const state = first.state(opened.launch.sessionId)!;
    await first.acceptMutation(
      opened.launch.sessionId,
      addPageNote(state, 0, { x: 1, y: 2, width: 20, height: 10 }, "protected"),
    );
    await first.quiesceForShutdown();

    const sourcePath = join(value.recoveryRoot, opened.launch.sessionId, "source.pdf");
    expect(await readFile(sourcePath)).toEqual(value.bytes);
    const recovered = await new DraftSnapshotStore(
      join(value.recoveryRoot, opened.launch.sessionId),
    ).recover();
    expect(recovered?.source).toMatchObject({
      disposition: "remote-temporary",
      displayName: "Restart.pdf",
      digest: createHash("sha256").update(value.bytes).digest("hex"),
    });

    const restarted = new SessionBroker({ recoveryRoot: value.recoveryRoot, portableReader: async () => [] });
    const remoteSource = recovered?.source.disposition === "remote-temporary" ? recovered.source : undefined;
    const publicPath = `/Placekeeper Browser/${remoteSource?.acquisitionId}/${remoteSource?.displayName}`;
    const link = encodePlacekeeperLink({ path: publicPath, location: { kind: "page", page: 1 } });
    const offered = await openPlacekeeperLink(restarted, { link, confirmed: true, surface: "browser" });
    if (offered.kind !== "recovery-offered") throw new Error("Expected recovery offer");
    const resumed = await openPlacekeeperLink(restarted, {
      link,
      confirmed: true,
      recovery: "resume",
      recoveryOffer: offered.recoveryOffer,
      recoveryOperationId: randomBytes(24).toString("base64url"),
      surface: "browser",
    });
    if (resumed.kind !== "opened") throw new Error("Expected resumed review");
    expect(await restarted.sessionScope(resumed.launch.sessionId)).toMatchObject({
      sourceDisposition: "remote-temporary",
      sourceDisplayName: "Restart.pdf",
    });
  });
});
