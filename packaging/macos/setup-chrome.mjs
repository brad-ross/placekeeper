import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const owner = "com.placekeeper.chrome";
const marker = ".placekeeper-managed-extension";
const optionalStat = async (path) => lstat(path).catch((error) => {
  if (error.code === "ENOENT") return undefined;
  throw error;
});

async function secure(path, directory) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
      stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0) {
    throw new Error(`Refusing insecure Chrome path: ${path}`);
  }
}

async function directories(root, target, create = false) {
  const suffix = relative(root, target);
  if (suffix.startsWith("..") || isAbsolute(suffix)) throw new Error("Chrome path escaped its managed root");
  await secure(root, true);
  let current = root;
  for (const part of suffix.split("/").filter(Boolean)) {
    current = join(current, part);
    if (create && !(await optionalStat(current))) await mkdir(current, { mode: 0o700 });
    await secure(current, true);
  }
}

async function treeFingerprint(root) {
  const hash = createHash("sha256");
  async function visit(path, name) {
    const stat = await lstat(path);
    await secure(path, stat.isDirectory());
    hash.update(JSON.stringify([name, stat.isDirectory() ? "directory" : "file"]));
    if (stat.isDirectory()) {
      for (const entry of (await readdir(path)).sort()) await visit(join(path, entry), `${name}/${entry}`);
    } else {
      const bytes = await readFile(path);
      hash.update(String(bytes.length));
      hash.update(bytes);
    }
  }
  await visit(root, "");
  return hash.digest("hex");
}

function locations(app, home) {
  if (!isAbsolute(app) || resolve(app) !== app || !app.endsWith("/Placekeeper.app") ||
      !isAbsolute(home) || resolve(home) !== home) throw new Error("Chrome setup requires canonical absolute managed paths");
  return {
    app, home, extension: join(dirname(app), "Placekeeper Chrome Extension"),
    source: join(app, "Contents/Resources/integrations/chrome-extension"),
    support: join(home, "Library/Application Support/Placekeeper/installer"),
    receipt: join(home, "Library/Application Support/Placekeeper/installer/chrome-legacy-ownership.json"),
    manifests: join(home, "Library/Application Support/Google/Chrome/NativeMessagingHosts"),
  };
}

async function secureAppParent(paths) {
  // User-selected install roots may be outside HOME. Validate each existing
  // ancestor below its filesystem root without following symbolic links.
  let current = dirname(paths.app);
  while (current !== dirname(current)) {
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory() ||
        ((stat.mode & 0o022) !== 0 && !(stat.mode & 0o1000))) {
      throw new Error(`Refusing insecure Chrome install ancestor: ${current}`);
    }
    current = dirname(current);
  }
  await secure(dirname(paths.app), true);
}

/** Capture only the pre-marker release's complete tree, before the old bundle
 * disappears. This evidence is retained across skipped/failed optional stages. */
export async function captureLegacyChromeOwnership(app, home = process.env.PLACEKEEPER_USER_HOME ?? process.env.HOME) {
  const paths = locations(app, home);
  if (!(await optionalStat(paths.extension))) return;
  let fingerprint;
  try {
    await secureAppParent(paths);
    await secure(app, true);
    if (await optionalStat(join(paths.extension, marker))) return;
    fingerprint = await treeFingerprint(paths.extension);
    if (fingerprint !== await treeFingerprint(paths.source)) return;
  } catch (error) {
    process.stderr.write(`Chrome legacy ownership was not captured: ${error.message}\n`);
    return;
  }
  // Once a legacy tree is proven ours, do not discard the previous bundle
  // unless its narrowly scoped adoption receipt can be retained securely.
  await directories(home, paths.support, true);
  if (await optionalStat(paths.receipt)) {
    await secure(paths.receipt, false);
    const receipt = JSON.parse(await readFile(paths.receipt, "utf8"));
    if (receipt.version !== 1 || receipt.path !== paths.extension || receipt.fingerprint !== fingerprint) {
      throw new Error("Retained Chrome ownership proof does not match the legacy tree; keep the previous app and repair the receipt");
    }
    return;
  }
  await writeFile(paths.receipt, `${JSON.stringify({ version: 1, path: paths.extension, fingerprint })}\n`, {
    flag: "wx", mode: 0o600,
  });
}

async function owned(paths) {
  if (!(await optionalStat(paths.extension))) return;
  await treeFingerprint(paths.extension);
  const markerPath = join(paths.extension, marker);
  if (await optionalStat(markerPath)) {
    await secure(markerPath, false);
    if ((await readFile(markerPath, "utf8")).trim() === owner) return;
    throw new Error("Refusing unmanaged Chrome extension destination");
  }
  const fingerprint = await treeFingerprint(paths.extension);
  if (await optionalStat(paths.receipt)) {
    await directories(paths.home, paths.support);
    await secure(paths.receipt, false);
    const receipt = JSON.parse(await readFile(paths.receipt, "utf8"));
    if (receipt.version === 1 && receipt.path === paths.extension && receipt.fingerprint === fingerprint) return;
    throw new Error("The legacy Chrome tree changed; retained ownership proof does not authorize adoption");
  }
  if (fingerprint === await treeFingerprint(paths.source)) return;
  throw new Error("Refusing unmanaged Chrome extension destination");
}

export async function setupChrome(app, { userHome = process.env.PLACEKEEPER_USER_HOME ?? process.env.HOME,
  run = exec, checkpoint = async () => {} } = {}) {
  const paths = locations(app, userHome);
  await secureAppParent(paths);
  await directories(userHome, paths.manifests, true);
  await owned(paths);
  const manifest = join(paths.manifests, `${owner}.json`);
  if (await optionalStat(manifest)) await secure(manifest, false);
  const transaction = await mkdtemp(join(dirname(app), ".placekeeper-chrome-"));
  let registration;
  try { registration = await mkdtemp(join(paths.manifests, ".placekeeper-chrome-")); }
  catch (error) { await rm(transaction, { recursive: true, force: true }); throw error; }
  let previousExtension = false, extensionTouched = false, previousManifest = false, manifestTouched = false;
  let interrupted = false;
  const interrupt = () => { interrupted = true; };
  const check = async (stage) => { await checkpoint(stage); if (interrupted) throw new Error("Chrome setup interrupted"); };
  process.on("SIGTERM", interrupt); process.on("SIGINT", interrupt); process.on("SIGHUP", interrupt);
  try {
    await run(join(app, "Contents/Resources/node/bin/node"), [
      join(app, "Contents/Resources/service/main.js"), "chrome-registration", "render",
      "--candidate-app", app, "--installed-app", app, "--output", join(registration, "staged.json"),
    ]);
    await cp(paths.source, join(transaction, "staged"), { recursive: true, dereference: false });
    await treeFingerprint(join(transaction, "staged"));
    await writeFile(join(transaction, "staged", marker), `${owner}\n`, { mode: 0o600, flag: "wx" });
    await check("staged");
    // Recheck both ownership and receipt immediately before moving endpoints.
    await owned(paths);
    if (await optionalStat(paths.extension)) {
      await rename(paths.extension, join(transaction, "previous")); previousExtension = true;
    }
    await check("extension-backed-up");
    await rename(join(transaction, "staged"), paths.extension); extensionTouched = true;
    if (await optionalStat(manifest)) {
      await secure(manifest, false);
      await rename(manifest, join(registration, "previous.json")); previousManifest = true;
    }
    await check("registration-backed-up");
    await rename(join(registration, "staged.json"), manifest); manifestTouched = true;
    await chmod(manifest, 0o600);
    await check("registered");
    if (await optionalStat(paths.receipt)) {
      await directories(userHome, paths.support); await secure(paths.receipt, false);
      await rm(paths.receipt);
    }
  } catch (error) {
    // Restore only endpoints changed by this host transaction. The Mac bundle
    // and Chrome profile/preferences are never written here.
    if (manifestTouched) await rm(manifest);
    if (previousManifest) await rename(join(registration, "previous.json"), manifest);
    if (extensionTouched) await rm(paths.extension, { recursive: true });
    if (previousExtension) await rename(join(transaction, "previous"), paths.extension);
    throw error;
  } finally {
    process.off("SIGTERM", interrupt); process.off("SIGINT", interrupt); process.off("SIGHUP", interrupt);
    // Keep a failed rollback's previous endpoint available for manual recovery.
    if (!(await optionalStat(join(transaction, "previous"))) && !(await optionalStat(join(registration, "previous.json")))) {
      await rm(transaction, { recursive: true, force: true });
      await rm(registration, { recursive: true, force: true });
    }
  }
  // Committed backups are now disposable.
  await rm(transaction, { recursive: true, force: true });
  await rm(registration, { recursive: true, force: true });
  return { status: "pending", path: paths.extension,
    message: `Chrome prepared. Finish setup in Chrome:
  1. Open chrome://extensions and turn on Developer mode (top right).
  2. Click Load unpacked and select this folder:
     ${paths.extension}
     In the folder picker, press Command-Shift-G to paste the path.
     If Placekeeper is already listed from this folder, click its Reload button instead.
  3. Open Chrome's Extensions menu (puzzle icon), then click Placekeeper.
  4. Turn on "Open PDFs automatically" and accept any permission prompt if you want automatic opening.
  5. Open a PDF link to check that it opens in Placekeeper.
     Older incompatible extensions remain disabled until repaired.` };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    if (process.argv[2] === "--capture-legacy" && process.argv.length === 4) {
      await captureLegacyChromeOwnership(process.argv[3]);
    } else if (process.argv.length === 3) {
      if (!process.env.PLACEKEEPER_LIFECYCLE_LOCK_TOKEN) throw new Error("Chrome setup requires daemon coordinate-host");
      process.stdout.write(`${JSON.stringify(await setupChrome(process.argv[2]))}\n`);
    } else throw new Error("Usage: setup-chrome.mjs [--capture-legacy] <installed-app>");
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
