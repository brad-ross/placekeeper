import { readFile } from "node:fs/promises";
import { createContext, compileFunction, type Context } from "node:vm";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function swiftScript(source: string, name: string): string {
  const match = source.match(new RegExp(
    `private static let ${name} = """\\n([\\s\\S]*?)\\n {8}"""`,
    "u",
  ));
  if (!match?.[1]) throw new Error(`Missing Swift JavaScript literal ${name}`);
  return match[1].replace(/^ {8}/gmu, "");
}

function runScript(
  context: Context,
  script: string,
  argumentsByName: Record<string, unknown>,
): unknown {
  const names = Object.keys(argumentsByName);
  return compileFunction(script, names, { parsingContext: context })(
    ...names.map((name) => argumentsByName[name]),
  );
}

describe("macOS native blob installation", () => {
  it("retries a partially accepted transfer without duplicating bytes or replacing the displayed predecessor early", async () => {
    const source = await readFile(resolve(
      "apps/macos/Sources/PlacekeeperMac/PlacekeeperWindowController.swift",
    ), "utf8");
    const begin = swiftScript(source, "blobTransferBeginScript");
    const append = swiftScript(source, "blobTransferAppendScript");
    const publish = swiftScript(source, "blobTransferPublishScript");
    const discard = swiftScript(source, "blobTransferDiscardScript");
    const created: Array<{ parts: Uint8Array[]; type: string }> = [];
    class CapturedBlob {
      parts: Uint8Array[];
      type: string;

      constructor(parts: Uint8Array[], options: { type: string }) {
        this.parts = parts;
        this.type = options.type;
      }
    }
    const predecessorSource = "placekeeper-resource://document/resource_test?generation=1&role=document";
    const successorSource = "placekeeper-resource://document/resource_test?generation=2&role=document";
    const predecessor = { source: predecessorSource, url: "blob:predecessor" };
    const page = createContext({
      atob,
      Blob: CapturedBlob,
      URL: {
        createObjectURL(blob: CapturedBlob) {
          created.push(blob);
          return `blob:successor-${created.length}`;
        },
      },
      __PLACEKEEPER_MAC_DOCUMENT_RESOURCES__: { [predecessorSource]: predecessor.url },
      __PLACEKEEPER_MAC_DOCUMENT_RESOURCE__: predecessor,
    });
    const role = "document-2";

    expect(runScript(page, begin, { role, transferId: "attempt-1" })).toBe(true);
    expect(runScript(page, append, {
      role,
      transferId: "attempt-1",
      base64: Buffer.from("partial-").toString("base64"),
    })).toBe(8);

    // A retry must replace an abandoned accumulator even if failure cleanup
    // could not run. A late callback from the old attempt must also be inert.
    expect(runScript(page, begin, { role, transferId: "attempt-2" })).toBe(true);
    expect(runScript(page, discard, { role, transferId: "attempt-1" })).toBe(true);
    expect(runScript(page, append, {
      role,
      transferId: "attempt-1",
      base64: Buffer.from("stale-").toString("base64"),
    })).toBe(false);
    for (const chunk of ["complete-", "document"]) {
      expect(runScript(page, append, {
        role,
        transferId: "attempt-2",
        base64: Buffer.from(chunk).toString("base64"),
      })).toBe(Buffer.byteLength(chunk));
    }

    expect(page.__PLACEKEEPER_MAC_DOCUMENT_RESOURCE__).toEqual(predecessor);
    expect(runScript(page, publish, {
      role,
      transferId: "attempt-2",
      mime: "application/pdf",
      source: successorSource,
    })).toBe(true);
    expect(Buffer.concat(created[0].parts.map((part) => Buffer.from(part))).toString()).toBe(
      "complete-document",
    );
    expect(page.__PLACEKEEPER_MAC_DOCUMENT_RESOURCES__[predecessorSource]).toBe(predecessor.url);
    expect(page.__PLACEKEEPER_MAC_DOCUMENT_RESOURCE__).toEqual({
      source: successorSource,
      url: "blob:successor-1",
    });
    expect(page.__PLACEKEEPER_MAC_BLOB_TRANSFERS__?.[role]).toBeUndefined();
  });
});
