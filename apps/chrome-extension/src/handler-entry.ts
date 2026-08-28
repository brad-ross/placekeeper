import { chromeAutoOpenPorts, connectPlacekeeper } from "./chrome-api.js";
import { createHandlerController } from "./handler-controller.js";
import { createNativeHandoff } from "./native-handoff.js";
import { readAutoOpenState } from "./opt-in.js";

const bypass = document.querySelector<HTMLButtonElement>("#bypass");
const status = document.querySelector<HTMLElement>("#status");
if (bypass === null || status === null) throw new Error("Incomplete Placekeeper handler page");

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
  replace: (destination) => window.location.replace(destination),
  status: (message) => {
    status.textContent = message;
  },
});

bypass.addEventListener("click", () => controller.bypass());
bypass.focus();
void controller.run();
