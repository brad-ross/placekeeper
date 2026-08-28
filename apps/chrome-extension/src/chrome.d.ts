import type { ChromeApi } from "./chrome-api.js";

declare global {
  const chrome: ChromeApi;
}

export {};
