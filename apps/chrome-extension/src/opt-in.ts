export const AUTO_OPEN_SENTINEL_KEY = "automaticOpenExplicitlyEnabled";
export const PDF_MIME_TYPE = "application/pdf";

export interface AutoOpenPorts {
  readSentinel(): Promise<boolean | undefined>;
  writeSentinel(enabled: boolean): Promise<void>;
  readMimeEnabled(): Promise<boolean>;
  writeMimeEnabled(enabled: boolean): Promise<void>;
}

export interface AutoOpenState {
  readonly enabled: boolean;
  readonly synchronized: boolean;
}

export async function readAutoOpenState(ports: AutoOpenPorts): Promise<AutoOpenState> {
  const [sentinel, mimeEnabled] = await Promise.all([
    ports.readSentinel(),
    ports.readMimeEnabled(),
  ]);
  return {
    enabled: sentinel === true && mimeEnabled,
    synchronized: sentinel !== undefined && sentinel === mimeEnabled,
  };
}

export async function initializeFreshInstall(ports: AutoOpenPorts): Promise<void> {
  await ports.writeSentinel(false);
  await ports.writeMimeEnabled(false);
}

export async function setAutoOpenEnabled(ports: AutoOpenPorts, enabled: boolean): Promise<void> {
  if (!enabled) {
    await ports.writeSentinel(false);
    await ports.writeMimeEnabled(false);
    return;
  }

  await ports.writeSentinel(true);
  try {
    await ports.writeMimeEnabled(true);
  } catch (error) {
    await ports.writeSentinel(false);
    throw error;
  }
}
