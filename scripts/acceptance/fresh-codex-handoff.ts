import { spawn } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  addHighlight,
  addPageNote,
  addReplace,
  type ReviewSelectionAnchor,
} from "../../packages/core/src/review-commands.js";
import { hashFile } from "../../apps/service/src/files/file-capabilities.js";
import { ReviewDeliveryService } from "../../apps/service/src/delivery/review-delivery-service.js";
import { SessionBroker } from "../../apps/service/src/sessions/session-broker.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureRoot = join(repositoryRoot, "test/fixtures/latex");
const codexBinary =
  process.env.PDF_PROOFREADER_CODEX_BINARY ??
  "/Applications/ChatGPT.app/Contents/Resources/codex";

function run(
  executable: string,
  argv: readonly string[],
  options: { readonly cwd: string; readonly quiet?: boolean },
): Promise<void> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, [...argv], {
      cwd: options.cwd,
      shell: false,
      stdio: options.quiet === true ? "ignore" : "inherit",
    });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${executable} exited with ${code ?? signal}`));
    });
  });
}

function selection(y: number, quote: string): ReviewSelectionAnchor {
  const rect = { x: 72, y, width: 330, height: 18 };
  return {
    pageIndex: 0,
    quote,
    prefix: "",
    suffix: "",
    rect,
    segmentRects: [rect],
    reliable: true,
  };
}

async function main(): Promise<void> {
  const runRoot = process.argv[2] === undefined
    ? await mkdtemp(join(tmpdir(), "pdf-proofreader-fresh-codex-"))
    : resolve(process.argv[2]);
  if (process.argv[2] !== undefined) {
    await access(runRoot).then(
      () => { throw new Error(`Acceptance output already exists: ${runRoot}`); },
      () => undefined,
    );
  }
  const sourceRoot = join(runRoot, "source");
  const recoveryRoot = join(runRoot, "recovery");
  await mkdir(sourceRoot, { recursive: true });
  await cp(join(fixtureRoot, "paper.tex"), join(sourceRoot, "paper.tex"));
  await cp(join(fixtureRoot, "README.md"), join(sourceRoot, "README.md"));
  await run("latexmk", [
    "-pdf",
    "-synctex=1",
    "-interaction=nonstopmode",
    "-halt-on-error",
    "paper.tex",
  ], { cwd: sourceRoot, quiet: true });

  const pdfPath = join(sourceRoot, "paper.pdf");
  const broker = new SessionBroker({ recoveryRoot });
  const opened = await broker.openReview({ pdfPath, sourceRootPath: sourceRoot });
  if (opened.kind === "recovery-offered") throw new Error("Unexpected recovery draft");
  const sessionId = opened.launch.sessionId;

  let state = broker.state(sessionId)!;
  state = await broker.acceptMutation(
    sessionId,
    addPageNote(
      state,
      0,
      { x: 72, y: 705, width: 18, height: 18 },
      "Change the section heading from ‘Representative review’ to ‘Revised review’.",
      undefined,
      "Representative review",
    ),
  );
  state = await broker.acceptMutation(
    sessionId,
    addHighlight(
      state,
      selection(660, "This sentence can be revised unambiguously."),
      "No source change is needed for this sentence; confirm that it is already satisfied.",
    ),
  );
  state = await broker.acceptMutation(
    sessionId,
    addReplace(
      state,
      selection(680, "The repeated sentence needs careful review."),
      "The repeated sentence has been reviewed.",
    ),
  );
  await broker.acceptMutation(
    sessionId,
    addPageNote(
      state,
      0,
      { x: 430, y: 610, width: 18, height: 18 },
      "Add the missing appendix source, but do not invent content when no appendix source is present.",
      undefined,
      "missing appendix source",
    ),
  );

  const delivery = await ReviewDeliveryService.create(broker);
  const prepared = await delivery.prepareCodex(sessionId);
  const instructionPath = await delivery.saveInstruction(sessionId, prepared.receiptId);
  const before = {
    handoff: await hashFile(prepared.handoffPath),
    reviewedPdf: await hashFile(prepared.reviewedPdfPath),
  };
  const lastMessagePath = join(prepared.resultDirectory, "codex-last-message.txt");
  await run(codexBinary, [
    "exec",
    "-C",
    sourceRoot,
    "--skip-git-repo-check",
    "-s",
    "workspace-write",
    "--ephemeral",
    "-o",
    lastMessagePath,
    await readFile(instructionPath, "utf8"),
  ], { cwd: sourceRoot });

  const dispositionPath = join(prepared.resultDirectory, "disposition.json");
  const revisedPdfPath = join(prepared.resultDirectory, "paper-revised.pdf");
  await access(dispositionPath);
  const dispositionText = await readFile(dispositionPath, "utf8");
  const revisedPdfSelected = await access(revisedPdfPath).then(() => true, () => false);
  const checked = await delivery.checkCodex(sessionId, {
    receiptId: prepared.receiptId,
    dispositionText,
    revisedPdfSelected,
  });
  const disposition = JSON.parse(dispositionText) as {
    readonly build?: { readonly status?: string };
    readonly items?: readonly { readonly status?: string }[];
  };
  const after = {
    handoff: await hashFile(prepared.handoffPath),
    reviewedPdf: await hashFile(prepared.reviewedPdfPath),
  };
  console.log(JSON.stringify({
    runRoot,
    sourceRoot,
    instructionPath,
    handoffPath: prepared.handoffPath,
    reviewedPdfPath: prepared.reviewedPdfPath,
    resultDirectory: prepared.resultDirectory,
    result: checked,
    buildStatus: disposition.build?.status,
    itemStatuses: disposition.items?.map(({ status }) => status),
    immutableEvidence: before.handoff === after.handoff && before.reviewedPdf === after.reviewedPdf,
    codexApprovalPolicy: "never",
    codexSandbox: "workspace-write",
  }, null, 2));
}

await main();
