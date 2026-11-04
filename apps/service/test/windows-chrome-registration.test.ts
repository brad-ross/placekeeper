import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { closeWindowsNativeWorker, requestWindowsNative } from "../src/platform/windows-native-worker.js";

// Native qualification uses a fixed test namespace and fresh ID. It never
// queries or writes Chrome's actual user registration.
it.skipIf(process.platform !== "win32")("creates an exclusive HKCU native host registration and refuses another owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "pk-chrome-registry-"));
  const path = join(root, "host.json"); await writeFile(path, "{}");
  const fields = { path, owner: `${"a".repeat(64)}:${randomUUID()}`, sha256: "b".repeat(64), testRegistryId: randomUUID() };
  try {
    expect(await requestWindowsNative({ operation: "registerChromeHost", ...fields })).toEqual({ status: "ok" });
    expect(await requestWindowsNative({ operation: "matchChromeHost", ...fields })).toEqual({ status: "ok" });
    expect(await requestWindowsNative({ operation: "matchChromeHost", ...fields, sha256: "c".repeat(64) })).toEqual({ status: "failed", nativeCode: 183 });
    expect(await requestWindowsNative({ operation: "registerChromeHost", ...fields })).toEqual({ status: "failed", nativeCode: 183 });
    expect(await requestWindowsNative({ operation: "unregisterChromeHost", ...fields, owner: `${"c".repeat(64)}:${randomUUID()}` })).toEqual({ status: "failed", nativeCode: 183 });
    expect(await requestWindowsNative({ operation: "unregisterChromeHost", ...fields })).toEqual({ status: "ok" });
  } finally {
    await requestWindowsNative({ operation: "unregisterChromeHost", ...fields }).catch(() => undefined);
    await closeWindowsNativeWorker();
  }
});
