import type { Duplex } from "node:stream";

export class SessionControlRegistry {
  readonly #sockets = new Map<string, Set<Duplex>>();
  readonly #writes = new Map<string, Set<AbortController>>();

  registerSocket(sessionId: string, socket: Duplex): () => void {
    const sockets = this.#sockets.get(sessionId) ?? new Set<Duplex>();
    sockets.add(socket);
    this.#sockets.set(sessionId, sockets);
    const unregister = (): void => {
      sockets.delete(socket);
      if (sockets.size === 0) this.#sockets.delete(sessionId);
    };
    socket.once("close", unregister);
    return unregister;
  }

  beginWrite(sessionId: string): { signal: AbortSignal; complete: () => void } {
    const controller = new AbortController();
    const writes = this.#writes.get(sessionId) ?? new Set<AbortController>();
    writes.add(controller);
    this.#writes.set(sessionId, writes);
    return {
      signal: controller.signal,
      complete: () => {
        writes.delete(controller);
        if (writes.size === 0) this.#writes.delete(sessionId);
      },
    };
  }

  cancel(sessionId: string): void {
    for (const controller of this.#writes.get(sessionId) ?? []) {
      controller.abort(new Error("Review session ended"));
    }
    this.#writes.delete(sessionId);
    for (const socket of this.#sockets.get(sessionId) ?? []) {
      socket.destroy();
    }
    this.#sockets.delete(sessionId);
  }

  closeAllSockets(): void {
    for (const sockets of this.#sockets.values()) {
      for (const socket of sockets) socket.destroy();
    }
    this.#sockets.clear();
  }
}
