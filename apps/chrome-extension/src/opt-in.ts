export const AUTO_OPEN_SENTINEL_KEY = "automaticOpenExplicitlyEnabled";
export const PDF_MIME_TYPE = "application/pdf";
export const AUTO_OPEN_OPERATION_TIMEOUT_MS = 2_000;

function boundedAutoOpenOperation<T>(operation: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Chrome PDF setting operation timed out"));
    }, AUTO_OPEN_OPERATION_TIMEOUT_MS);
    operation.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

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
    boundedAutoOpenOperation(ports.readSentinel()),
    boundedAutoOpenOperation(ports.readMimeEnabled()),
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
    await boundedAutoOpenOperation(ports.writeSentinel(false));
    await boundedAutoOpenOperation(ports.writeMimeEnabled(false));
    return;
  }

  await boundedAutoOpenOperation(ports.writeSentinel(true));
  try {
    await boundedAutoOpenOperation(ports.writeMimeEnabled(true));
  } catch (error) {
    await boundedAutoOpenOperation(ports.writeSentinel(false));
    throw error;
  }
}
