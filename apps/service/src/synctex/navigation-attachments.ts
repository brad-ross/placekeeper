import { randomUUID } from "node:crypto";

export interface NavigationOperation {
  readonly attachmentId: string;
  readonly sessionId: string;
  readonly sourceRoot?: string;
  readonly operationToken: string;
}

interface Attachment {
  readonly sessionId: string;
  readonly sourceRoot?: string;
  operation?: NavigationOperation;
}

/** Trusted hosts own these handles. They never come from a renderer or durable review state. */
export class NavigationAttachments {
  readonly #attachments = new Map<string, Attachment>();

  create(sessionId: string, sourceRoot?: string): string {
    const id = randomUUID();
    this.#attachments.set(id, { sessionId, ...(sourceRoot === undefined ? {} : { sourceRoot }) });
    return id;
  }

  owns(id: string, sessionId: string): boolean {
    return this.#attachments.get(id)?.sessionId === sessionId;
  }

  begin(id: string, sessionId: string, operationToken: string): NavigationOperation | undefined {
    const attachment = this.#attachments.get(id);
    if (attachment?.sessionId !== sessionId) return undefined;
    const operation: NavigationOperation = { attachmentId: id, sessionId, operationToken,
      ...(attachment.sourceRoot === undefined ? {} : { sourceRoot: attachment.sourceRoot }) };
    attachment.operation = operation;
    return operation;
  }

  isCurrent(operation: NavigationOperation): boolean {
    return this.#attachments.get(operation.attachmentId)?.operation === operation;
  }

  revoke(id: string): void {
    this.#attachments.delete(id);
  }

  revokeSession(sessionId: string): void {
    for (const [id, attachment] of this.#attachments) {
      if (attachment.sessionId === sessionId) this.#attachments.delete(id);
    }
  }

  clear(): void {
    this.#attachments.clear();
  }
}
