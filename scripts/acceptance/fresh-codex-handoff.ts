import { spawn } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
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

type Scenario = "success" | "missing-synctex" | "build-failure";

function parseArguments(): { readonly scenario: Scenario; readonly output?: string } {
  const values = process.argv.slice(2).filter((value) => value !== "--");
  let scenario: Scenario = "success";
  let output: string | undefined;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    if (value === "--scenario") {
      const selected = values[index + 1];
      if (!(["success", "missing-synctex", "build-failure"] as const).includes(selected as Scenario)) {
        throw new Error("--scenario must be success, missing-synctex, or build-failure");
      }
      scenario = selected as Scenario;
      index += 1;
    } else if (value.startsWith("--")) {
      throw new Error(`Unknown acceptance option: ${value}`);
    } else if (output === undefined) {
      output = value;
    } else {
      throw new Error("Pass at most one acceptance output directory");
    }
  }
  return { scenario, ...(output === undefined ? {} : { output }) };
}

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
  const options = parseArguments();
  const runRoot = options.output === undefined
    ? await mkdtemp(join(tmpdir(), "pdf-proofreader-fresh-codex-"))
    : resolve(options.output);
  if (options.output !== undefined) {
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

  if (options.scenario === "missing-synctex") {
    await unlink(join(sourceRoot, "paper.synctex.gz"));
  } else if (options.scenario === "build-failure") {
    const sourcePath = join(sourceRoot, "paper.tex");
    const source = await readFile(sourcePath, "utf8");
    await writeFile(
      sourcePath,
      source.replace(
        "\\end{document}",
        "\\input{intentionally-missing-required-fixture}\n\\end{document}",
      ),
    );
    await writeFile(
      join(sourceRoot, "BUILD-FAILURE.md"),
      "This acceptance fixture intentionally has a missing required input. Do not create, remove, or replace that input directive. Apply reviewable source edits, attempt the checked-in latexmk build, and report the resulting build failure exactly as the handoff protocol requires.\n",
    );
  }

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
  const report = {
    scenario: options.scenario,
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
  };
  console.log(JSON.stringify(report, null, 2));
  const expectedStatus = options.scenario === "build-failure" ? "Partial" : "Complete";
  if (checked.status !== expectedStatus || report.immutableEvidence !== true) {
    throw new Error(`Acceptance scenario ${options.scenario} expected ${expectedStatus}`);
  }
}

await main();
