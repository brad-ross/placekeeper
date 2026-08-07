import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const BOOTSTRAP_BYTES = 32;
const CREDENTIAL_BYTES = 32;

function digestSecret(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

function secretEquals(candidate: string, digest: Buffer): boolean {
  const candidateDigest = digestSecret(candidate);
  return candidateDigest.length === digest.length && timingSafeEqual(candidateDigest, digest);
}

export interface RequestSecurityContext {
  readonly method: string;
  readonly rawHeaders: readonly string[];
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly remoteAddress?: string;
  readonly mutates?: boolean;
  readonly expectsJson?: boolean;
  readonly bodyLength?: number;
}

export type RequestSecurityFailure =
  | "peer"
  | "host"
  | "forwarded"
  | "cross-site"
  | "origin"
  | "method"
  | "content-type"
  | "body-size";

export interface RequestSecurityPolicy {
  readonly host: string;
  readonly origin: string;
  readonly maxBodyBytes: number;
}

function headerValues(
  rawHeaders: readonly string[],
  target: string,
): string[] {
  const values: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === target) {
      values.push(rawHeaders[index + 1] ?? "");
    }
  }
  return values;
}

export function validateRequestSecurity(
  request: RequestSecurityContext,
  policy: RequestSecurityPolicy,
): RequestSecurityFailure | undefined {
  if (request.remoteAddress !== "127.0.0.1" && request.remoteAddress !== "::1") {
    return "peer";
  }

  const hosts = headerValues(request.rawHeaders, "host");
  if (hosts.length !== 1 || hosts[0] !== policy.host) {
    return "host";
  }

  const forbiddenForwardingHeaders = [
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-real-ip",
  ];
  if (
    forbiddenForwardingHeaders.some(
      (name) => request.headers[name] !== undefined,
    )
  ) {
    return "forwarded";
  }

  const fetchSite = request.headers["sec-fetch-site"];
  if (
    typeof fetchSite === "string" &&
    fetchSite !== "same-origin" &&
    fetchSite !== "none"
  ) {
    return "cross-site";
  }

  if (request.mutates) {
    if (request.method === "GET" || request.method === "HEAD") {
      return "method";
    }
    if (request.headers.origin !== policy.origin) {
      return "origin";
    }
  }

  if (request.expectsJson) {
    const contentType = request.headers["content-type"];
    if (
      typeof contentType !== "string" ||
      contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
    ) {
      return "content-type";
    }
  }

  if ((request.bodyLength ?? 0) > policy.maxBodyBytes) {
    return "body-size";
  }
  return undefined;
}

interface BootstrapRecord {
  readonly digest: Buffer;
  readonly expiresAt: number;
  used: boolean;
}

interface CredentialRecord {
  readonly digest: Buffer;
  readonly sessionId: string;
  revoked: boolean;
}

export class SessionCredentialStore {
  readonly #bootstraps = new Map<string, BootstrapRecord>();
  readonly #credentials = new Map<string, CredentialRecord>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  issueBootstrap(sessionId: string, ttlMs = 60_000): string {
    const capability = randomBytes(BOOTSTRAP_BYTES).toString("base64url");
    this.#bootstraps.set(sessionId, {
      digest: digestSecret(capability),
      expiresAt: this.#now() + ttlMs,
      used: false,
    });
    return capability;
  }

  exchangeBootstrap(sessionId: string, capability: string): string | undefined {
    const record = this.#bootstraps.get(sessionId);
    if (
      record === undefined ||
      record.used ||
      record.expiresAt <= this.#now() ||
      !secretEquals(capability, record.digest)
    ) {
      return undefined;
    }
    record.used = true;
    const credential = randomBytes(CREDENTIAL_BYTES).toString("base64url");
    this.#credentials.set(credential.slice(0, 12), {
      digest: digestSecret(credential),
      sessionId,
      revoked: false,
    });
    return credential;
  }

  authenticate(sessionId: string, credential: string): boolean {
    const record = this.#credentials.get(credential.slice(0, 12));
    return (
      record !== undefined &&
      !record.revoked &&
      record.sessionId === sessionId &&
      secretEquals(credential, record.digest)
    );
  }

  revokeSession(sessionId: string): void {
    this.#bootstraps.delete(sessionId);
    for (const record of this.#credentials.values()) {
      if (record.sessionId === sessionId) {
        record.revoked = true;
      }
    }
  }
}

export const RESTRICTIVE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' blob:",
  "font-src 'self'",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");
