export function runtimeRoot(app: string, platform?: NodeJS.Platform): string;
export interface InstallationContext {
  lockPath?: string;
  lockToken?: string;
  backupRoot?: string;
  transactionRoot?: string;
}
export type InstallationCommand = (executable: string, args: string[], options: {
  env: NodeJS.ProcessEnv;
  timeout: number;
  maxBuffer: number;
}) => Promise<unknown>;
export function installBuiltApp(
  built: string,
  destination: string,
  readiness: string,
  port?: string,
  invoke?: InstallationCommand,
  isolatedRoot?: string,
  context?: InstallationContext,
): Promise<{ version: 1; attempt: string; destination: string; candidateIdentity: string; backupRoot: string; previous: string; failed: string; receipt: string; shellReceipt: string; phase: string }>;
