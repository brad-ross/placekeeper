import {
  NATIVE_HOST_NAME,
  type ChromeRuntimeExtensionMessage,
  type ExtensionMessage,
} from "./native-protocol.js";
import {
  AUTO_OPEN_SENTINEL_KEY,
  PDF_MIME_TYPE,
  type AutoOpenPorts,
} from "./opt-in.js";

export interface ChromeApi {
  readonly storage: {
    readonly local: {
      get(key: string): Promise<Record<string, unknown>>;
      set(values: Record<string, unknown>): Promise<void>;
    };
  };
  readonly mimeHandler: {
    getMimeHandlerOptions(mimeType: string): Promise<{ enabled: boolean }>;
    setMimeHandlerOptions(mimeType: string, options: { enabled: boolean }): Promise<void>;
    getStreamInfo(): Promise<{
      originalUrl: string;
      streamUrl: string;
      tabId: number;
      embedded: boolean;
    } | undefined>;
    abortAndFallbackToNativeHandler(): Promise<void>;
  };
  readonly runtime: {
    connectNative(application: string): NativePort;
    getURL(path: string): string;
    readonly onInstalled: {
      addListener(listener: (details: { reason: string }) => void): void;
    };
  };
}

interface NativeEvent<T> {
  addListener(listener: (value: T) => void): void;
  removeListener(listener: (value: T) => void): void;
}

export interface NativePort {
  postMessage(message: ExtensionMessage | ChromeRuntimeExtensionMessage): void;
  disconnect(): void;
  readonly onMessage: NativeEvent<unknown>;
  readonly onDisconnect: NativeEvent<void>;
}

export function chromeAutoOpenPorts(api: ChromeApi): AutoOpenPorts {
  return {
    async readSentinel() {
      const stored = await api.storage.local.get(AUTO_OPEN_SENTINEL_KEY);
      const value = stored[AUTO_OPEN_SENTINEL_KEY];
      return typeof value === "boolean" ? value : undefined;
    },
    writeSentinel: async (enabled) => api.storage.local.set({ [AUTO_OPEN_SENTINEL_KEY]: enabled }),
    readMimeEnabled: async () => (await api.mimeHandler.getMimeHandlerOptions(PDF_MIME_TYPE)).enabled,
    writeMimeEnabled: async (enabled) => {
      await api.mimeHandler.setMimeHandlerOptions(PDF_MIME_TYPE, { enabled });
    },
  };
}

export function connectPlacekeeper(api: ChromeApi): NativePort {
  return api.runtime.connectNative(NATIVE_HOST_NAME);
}
