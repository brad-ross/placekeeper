/** Presentation-only upgrade state. Installer and participant credentials stay in the service. */
export interface UpgradeDocumentStatus {
  readonly phase: 'none' | 'preview' | 'preparing' | 'ready' | 'committed' | 'canceled';
  readonly attemptId?: string;
  readonly settlementRequired?: boolean;
  readonly reason?: string;
}
export interface UpgradeDocumentSettlement { readonly attemptId: string; readonly error?: string }
export function isUpgradeDocumentSettlement(value: unknown): value is UpgradeDocumentSettlement {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return Object.keys(input).every(key => key === 'attemptId' || key === 'error') &&
    typeof input.attemptId === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(input.attemptId) &&
    (input.error === undefined || (typeof input.error === 'string' && input.error.length <= 1024));
}
export function upgradeDocumentStatus(value: unknown): UpgradeDocumentStatus | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['phase', 'attemptId', 'reason', 'settlementRequired'].includes(key)) ||
    !['none', 'preview', 'preparing', 'ready', 'committed', 'canceled'].includes(String(input.phase)) ||
    (input.phase !== 'none' && (typeof input.attemptId !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(input.attemptId))) ||
    (input.settlementRequired !== undefined && typeof input.settlementRequired !== 'boolean') ||
    (input.reason !== undefined && (typeof input.reason !== 'string' || input.reason.length > 1024))) return undefined;
  return input as unknown as UpgradeDocumentStatus;
}
