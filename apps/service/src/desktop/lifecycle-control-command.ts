import {
  parseNativeAppControlMessage,
  type NativeAppControlMessage,
  type NativeAppControlResponse,
} from "../../../../packages/core/src/native-app-control-protocol.js";
import { encodeNativeHelperFrame } from "../../../../packages/core/src/native-helper-protocol.js";
import { readNativeFrames } from "./framed-input.js";

const ID = /^[A-Za-z0-9_-]{8,128}$/u;

export interface NativeLifecycleDiagnostic {
  readonly stage: string;
  readonly cause?: string;
  readonly errorClass?: string;
  readonly code?: string;
  readonly reason?: string;
  readonly nativeCode?: number;
  readonly exceptionKind?: string;
  readonly hresult?: number;
}

/** Report fixed classifications only; errors may contain paths, proofs or document data. */
export function lifecycleDiagnostic(stage: string, error?: unknown): NativeLifecycleDiagnostic {
  if (!(error instanceof Error)) return { stage, cause: 'unclassified' };
  const detail = error as Error & { code?: unknown; reason?: unknown; nativeCode?: unknown; diagnostic?: { exceptionKind?: unknown; hresult?: unknown } };
  const errorClass = ['Error', 'TypeError', 'SyntaxError', 'RangeError', 'WindowsNativeWorkerError', 'PrivateControlError', 'PlacekeeperControlProtocolError', 'PlacekeeperControlTimeoutError', 'DaemonUpgradeRequiredError', 'LifecycleLockTimeoutError'].includes(error.name) ? error.name : 'Error';
  const knownCauses = [
    ['Placekeeper lifecycle coordination is busy', 'lifecycle-lock-busy'],
    ['The local placekeeper service did not become ready', 'daemon-not-ready'],
    ['The placekeeper launcher entry point is unavailable', 'launcher-entry-unavailable'],
    ['The local placekeeper service exited before becoming ready', 'daemon-exited-before-ready'],
    ['Browser source root must be a secure directory', 'browser-source-private-root'],
    ['Windows system directory is unavailable', 'windows-system-directory-unavailable'],
  ] as const;
  const cause = knownCauses.find(([message]) => error.message === message)?.[1]
    ?? (/^(?:Packaged |Invalid packaged |Unidentified packaged |The packaged )/u.test(error.message) ? 'packaged-runtime-validation'
      : /^(?:Private storage|Windows private storage)/u.test(error.message) ? 'private-storage'
      : error.message.startsWith('Windows native worker') ? 'windows-native-worker' : 'unclassified');
  const code = typeof detail.code === 'string' && ['ENOENT', 'EACCES', 'EPERM', 'EEXIST', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTDIR', 'ENOSPC', 'ERR_INVALID_URL', 'ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'ERR_DLOPEN_FAILED', 'ERR_REQUIRE_ESM', 'ERR_INVALID_ARG_TYPE'].includes(detail.code) ? detail.code : undefined;
  const reason = typeof detail.reason === 'string' && ['malformed', 'oversized', 'early-close', 'timeout', 'incompatible', 'uninspectable', 'transient-busy', 'review-presence', 'codex-task', 'operation-failed', 'reparse-point', 'owner-mismatch', 'rule-count', 'principal-mismatch', 'denied-access', 'rights-mismatch'].includes(detail.reason) ? detail.reason : undefined;
  const native = detail.diagnostic;
  const exceptionKind = typeof native?.exceptionKind === 'string' && ['UnauthorizedAccessException', 'PrivilegeNotHeldException', 'Win32Exception', 'IdentityNotMappedException', 'ArgumentException', 'InvalidOperationException', 'Other'].includes(native.exceptionKind) ? native.exceptionKind : undefined;
  return { stage, cause, errorClass, ...(code ? { code } : {}), ...(reason ? { reason } : {}),
    ...(Number.isSafeInteger(detail.nativeCode) ? { nativeCode: detail.nativeCode as number } : {}),
    ...(exceptionKind ? { exceptionKind } : {}), ...(Number.isInteger(native?.hresult) ? { hresult: native!.hresult as number } : {}) };
}

export interface NativeLifecycleControlCommandOptions {
  readonly diagnostic?: (value: NativeLifecycleDiagnostic) => void;
  readonly input: AsyncIterable<Uint8Array>;
  readonly write: (frame: Buffer) => Promise<void>;
  readonly appInstanceId: string;
  readonly exchange: (message: NativeAppControlMessage) => Promise<NativeAppControlResponse>;
}

export async function runNativeLifecycleControlCommand(
  options: NativeLifecycleControlCommandOptions,
): Promise<number> {
  const report = (stage: string, error?: unknown) => { try { options.diagnostic?.(lifecycleDiagnostic(stage, error)); } catch { /* Diagnostics must not alter control lifetime. */ } };
  if (!ID.test(options.appInstanceId)) { report('app-identity'); return 2; }
  const exchange = options.exchange;
  let registered = false;
  let detached = false;
  let stage = 'read-input';
  try {
    for await (const raw of readNativeFrames(options.input)) {
      const message = parseNativeAppControlMessage(raw);
      if (message === undefined || message.appInstanceId !== options.appInstanceId
        || (!registered && message.type !== "register-app")
        || (registered && message.type === "register-app")) { report('message-validation'); return 2; }
      stage = `exchange-${message.type}`;
      const response = await exchange(message);
      if (response.type !== "failure") registered = true;
      stage = 'write-response';
      await options.write(encodeNativeHelperFrame(response));
      if (response.type === 'failure') { report(`service-refused-${response.code}`); return 2; }
      stage = 'read-input';
      if (message.type === "detach") {
        detached = true;
        return 0;
      }
    }
    return 0;
  } catch (error) {
    report(stage, error);
    return 2;
  } finally {
    if (registered && !detached) {
      await exchange({
        protocolVersion: 1,
        type: "detach",
        appInstanceId: options.appInstanceId,
        reason: "eof",
      }).catch(error => report('detach-eof', error));
    }
  }
}

