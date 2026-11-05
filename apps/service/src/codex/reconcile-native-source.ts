import type { SessionBroker } from "../sessions/session-broker.js";

/** Re-observe after canonical watcher supersession before granting another presentation. */
export async function reconcileNativeSource(broker: SessionBroker, sessionId: string, sourcePath: string): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const observed = await broker.observeLiveDocumentHint({ sessionId, outputPath: sourcePath, hostReason: "activation" });
    if (observed.status === "committed" || observed.status === "same-digest") return true;
    if (observed.status !== "superseded" && observed.status !== "generation-conflict") return false;
    // A newer watcher candidate may still be queued when the superseded check returns.
    // The broker owns its ordering and completion; a fresh check then verifies current bytes.
    await broker.settlePhysicalSaveBarrier(sessionId);
  }
  return false;
}
