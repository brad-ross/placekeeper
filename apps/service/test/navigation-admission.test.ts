import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it, vi } from "vitest";
import { SessionBroker } from "../src/sessions/session-broker.js";
import * as fileCapabilities from "../src/files/file-capabilities.js";
import { LocalDocumentObserver } from "../src/sessions/local-document-observer.js";

describe("presentation navigation admission", () => {
  it("keeps each concurrent focused launch's approved source root", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "navigation-admission-")));
    const admissionEntered = Promise.withResolvers<void>();
    const releaseAdmission = Promise.withResolvers<void>();
    const broker = new SessionBroker({ recoveryRoot: join(root, "recovery"), rewriteAssessor: async () => {
      admissionEntered.resolve();
      await releaseAdmission.promise;
      return { eligible: true };
    } });
    try {
      const pdf = await PDFDocument.create();
      pdf.addPage([300, 300]);
      const pdfPath = join(root, "paper.pdf");
      await writeFile(pdfPath, await pdf.save({ useObjectStreams: false }));
      await writeFile(join(root, "paper.synctex"), "SyncTeX Version:1\nInput:1:paper.tex\nContent:\n");
      const roots = [join(root, "editor-a"), join(root, "editor-b")] as const;
      await Promise.all(roots.map(async path => {
        await mkdir(path);
        await writeFile(join(path, "paper.tex"), "Source text");
      }));
      const original = broker.openReview({ pdfPath, sourceRootPath: roots[0], surface: "vscode", workflowMode: "generated-output" });
      await admissionEntered.promise;
      const waitingHashes = Promise.withResolvers<void>();
      const hashFile = fileCapabilities.hashFile;
      let hashes = 0;
      vi.spyOn(fileCapabilities, "hashFile").mockImplementation(async path => {
        const digest = await hashFile(path);
        if (++hashes === 2) waitingHashes.resolve();
        return digest;
      });
      const bothObserved = Promise.withResolvers<void>();
      const releaseObservation = Promise.withResolvers<void>();
      let observations = 0;
      const check = vi.spyOn(LocalDocumentObserver.prototype, "check").mockImplementation(async () => {
        if (++observations === 2) bothObserved.resolve();
        await releaseObservation.promise;
        return undefined;
      });
      const requests = roots.map(sourceRootPath => broker.openReview({ pdfPath, sourceRootPath, surface: "vscode", workflowMode: "generated-output" }));
      await waitingHashes.promise;
      await new Promise(resolve => setImmediate(resolve));
      releaseAdmission.resolve();
      expect((await original).kind).toBe("opened");
      await bothObserved.promise;
      releaseObservation.resolve();
      const launches = await Promise.all(requests);
      check.mockRestore();
      for (const [index, opened] of launches.entries()) {
        if (opened.kind !== "focused") throw new Error("Expected the existing PDF session");
        const credential = broker.exchangeBootstrap(opened.launch.sessionId, opened.launch.fragment.slice("#cap=".length))!;
        const navigationAttachmentId = broker.navigationAttachmentForCredential(opened.launch.sessionId, credential)!;
        const result = await broker.forwardSyncTex({
          sessionId: opened.launch.sessionId, navigationAttachmentId,
          sourcePath: "paper.tex", line: 1, operationToken: `editor-${index}`,
          run: async request => {
            expect(request.cwd).toBe(roots[index]);
            return { stdout: `Output:${request.argv.at(-1)}\nPage:1\nx:1\ny:2\n`, stderr: "", exitCode: 0 };
          },
        });
        expect(result.status).toBe("ok");
      }
    } finally {
      vi.restoreAllMocks();
      await broker.quiesceForShutdown();
      await rm(root, { recursive: true, force: true });
    }
  });
});
