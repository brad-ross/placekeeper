import { resolve } from "node:path";

const SAFE_ID = /^[A-Za-z0-9_-]{16,128}$/u;

export interface ExternalLaunchRegistration {
  readonly registrationId: string;
  readonly canonicalOutputPath: string;
  readonly windowId: string;
}

/** Exact in-host routing table. Cross-process registration is intentionally
 * fail-closed until a unique registration is presented by the launcher. */
export class ScopedExternalLaunchRegistrations {
  readonly #byId = new Map<string, ExternalLaunchRegistration>();
  readonly #byOutput = new Map<string, ExternalLaunchRegistration>();

  register(input: ExternalLaunchRegistration): ExternalLaunchRegistration {
    if (!SAFE_ID.test(input.registrationId) || !SAFE_ID.test(input.windowId)) {
      throw new Error("External launch registration identity is invalid");
    }
    const canonicalOutputPath = resolve(input.canonicalOutputPath);
    const existingId = this.#byId.get(input.registrationId);
    if (existingId !== undefined) return existingId;
    const existingOutput = this.#byOutput.get(canonicalOutputPath);
    if (existingOutput !== undefined && existingOutput.windowId !== input.windowId) {
      throw new Error("Multiple VS Code windows registered the same canonical output");
    }
    const registration = Object.freeze({ ...input, canonicalOutputPath });
    this.#byId.set(registration.registrationId, registration);
    this.#byOutput.set(canonicalOutputPath, registration);
    return registration;
  }

  resolve(input: { readonly registrationId?: string; readonly outputPath: string }): ExternalLaunchRegistration {
    if (input.registrationId === undefined) throw new Error("A scoped registration is required");
    const registration = this.#byId.get(input.registrationId);
    if (registration === undefined) throw new Error("External launch registration is missing or stale");
    if (resolve(input.outputPath) !== registration.canonicalOutputPath) {
      throw new Error("External launch output does not match its registration");
    }
    return registration;
  }

  unregister(registrationId: string): void {
    const registration = this.#byId.get(registrationId);
    if (registration === undefined) return;
    this.#byId.delete(registrationId);
    if (this.#byOutput.get(registration.canonicalOutputPath) === registration) {
      this.#byOutput.delete(registration.canonicalOutputPath);
    }
  }
}
