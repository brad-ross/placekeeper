import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const sourceRoot = resolve("../../dist/web");
const destinationRoot = resolve("dist/web");
const manifest = JSON.parse(await readFile(resolve(sourceRoot, "asset-manifest.json"), "utf8"));
const assetNames = [manifest.app, manifest.stylesheet, manifest.pdfiumWasm];
if (
  manifest.schemaVersion !== 2 ||
  assetNames.some((name) => typeof name !== "string" || !/^[A-Za-z0-9._-]+$/u.test(name)) ||
  new Set(assetNames).size !== assetNames.length ||
  manifest.worker?.kind !== "inline-blob" || manifest.worker?.container !== manifest.app ||
  typeof manifest.integrity !== "object" || manifest.integrity === null ||
  Object.keys(manifest.integrity).sort().join("\n") !== [...assetNames].sort().join("\n")
) throw new Error("The shared production asset manifest is invalid");

const expectedSourceFiles = ["asset-manifest.json", ...assetNames].sort();
const sourceFiles = (await readdir(sourceRoot)).sort();
if (sourceFiles.join("\n") !== expectedSourceFiles.join("\n")) {
  throw new Error("The shared production assets contain missing or stale files");
}
for (const name of assetNames) {
  const path = resolve(sourceRoot, name);
  if (!(await lstat(path)).isFile()) throw new Error(`The shared production asset is not a file: ${name}`);
  const digest = createHash("sha256").update(await readFile(path)).digest("hex");
  if (manifest.integrity[name] !== digest) throw new Error(`The shared production asset is stale: ${name}`);
}

await rm(destinationRoot, { recursive: true, force: true });
await mkdir(destinationRoot, { recursive: true });
for (const name of ["asset-manifest.json", ...assetNames]) {
  await cp(resolve(sourceRoot, name), resolve(destinationRoot, name), {
    dereference: false,
    errorOnExist: true,
  });
}
