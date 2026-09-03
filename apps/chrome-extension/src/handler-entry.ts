import { chromeAutoOpenPorts, connectPlacekeeper } from "./chrome-api.js";
import { createHandlerController } from "./handler-controller.js";
import { createNativeHandoff } from "./native-handoff.js";
import { readAutoOpenState } from "./opt-in.js";
import {
  platformProofEnabled,
  platformProofFailureCode,
  runInstalledPlatformProof,
} from "./platform-proof.js";

const bypass = document.querySelector<HTMLButtonElement>("#bypass");
const status = document.querySelector<HTMLElement>("#status");
const proofOutput = document.querySelector<HTMLElement>("#platform-proof");
if (bypass === null || status === null || proofOutput === null) {
  throw new Error("Incomplete Placekeeper handler page");
}

const autoOpen = chromeAutoOpenPorts(chrome);
const handoff = createNativeHandoff({
  connectNative: () => connectPlacekeeper(chrome),
  fetchStream: async (url, signal) => signal === undefined ? fetch(url) : fetch(url, { signal }),
  createTransferId: () => crypto.randomUUID(),
});
const controller = createHandlerController({
  isOptedIn: async () => (await readAutoOpenState(autoOpen)).enabled,
  getStreamInfo: async () => chrome.mimeHandler.getStreamInfo(),
  handoff,
  fallback: () => {
    void chrome.mimeHandler.abortAndFallbackToNativeHandler();
  },
  replace: async (tabId, destination) => {
    await chrome.tabs.update(tabId, { url: destination });
  },
  status: (message) => {
    status.textContent = message;
  },
});

void (async () => {
  const proofEnabled = await platformProofEnabled(chrome);
  if (proofEnabled) {
    bypass.addEventListener("click", () => {
      void chrome.mimeHandler.abortAndFallbackToNativeHandler();
    }, { once: true });
    try {
      await runInstalledPlatformProof({ api: chrome, status, output: proofOutput });
    } catch (error) {
      status.textContent = "Platform proof failed — stop the embedded-viewer rollout.";
      proofOutput.hidden = false;
      proofOutput.textContent = JSON.stringify({
        failureCode: platformProofFailureCode(error),
      }, null, 2);
    }
  } else {
    bypass.addEventListener("click", () => controller.bypass());
    void controller.run();
  }
  bypass.focus();
})();
