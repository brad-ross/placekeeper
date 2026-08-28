import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";

const sourceRoot = resolve("../../dist/web");
const destinationRoot = resolve("dist/web");
const manifest = JSON.parse(await readFile(resolve(sourceRoot, "asset-manifest.json"), "utf8"));
const assetNames = [manifest.app, manifest.stylesheet, manifest.pdfiumWasm];
if (
  manifest.schemaVersion !== 1 ||
  assetNames.some((name) => typeof name !== "string" || !/^[A-Za-z0-9._-]+$/u.test(name))
) throw new Error("The shared production asset manifest is invalid");

await rm(destinationRoot, { recursive: true, force: true });
await mkdir(destinationRoot, { recursive: true });
for (const name of ["asset-manifest.json", ...assetNames]) {
  await cp(resolve(sourceRoot, name), resolve(destinationRoot, name), {
    dereference: false,
    errorOnExist: true,
  });
}
