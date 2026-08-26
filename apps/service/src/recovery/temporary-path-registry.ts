const activeRecoveryTemporaryPaths = new Set<string>();

export function trackRecoveryTemporaryPath(path: string): () => void {
  activeRecoveryTemporaryPaths.add(path);
  return () => activeRecoveryTemporaryPaths.delete(path);
}

export function isRecoveryTemporaryPathActive(path: string): boolean {
  return activeRecoveryTemporaryPaths.has(path);
}
