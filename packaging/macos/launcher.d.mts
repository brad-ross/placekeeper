export interface RecoveryRequest {
  readonly recovery: "resume" | "discard" | "fork";
  readonly recoveryOffer: { readonly id: string; readonly expiresAt: string };
  readonly recoveryOperationId: string;
}
export function finderServiceArgs(pdfPath: string, recovery?: RecoveryRequest): string[];
export function linkServiceArgs(link: string, options?: {
  readonly preflight?: boolean;
  readonly confirmed?: boolean;
  readonly recovery?: "resume" | "discard" | "fork";
  readonly recoveryOffer?: RecoveryRequest["recoveryOffer"];
  readonly recoveryOperationId?: string;
}): string[];
export function main(args?: string[]): Promise<void>;
