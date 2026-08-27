import { chromeAutoOpenPorts } from "./chrome-api.js";
import { initializeFreshInstall } from "./opt-in.js";

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason !== "install") return;
  void initializeFreshInstall(chromeAutoOpenPorts(chrome));
});
