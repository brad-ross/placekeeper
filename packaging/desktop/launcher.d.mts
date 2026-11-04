export function resolveLauncherRuntime(root: string, target?: { platform: NodeJS.Platform; arch: string }): Promise<{ node: string; service: string; codexMcp?: string; environment: NodeJS.ProcessEnv }>;
export function main(args?: readonly string[], root?: string, invoke?: typeof import('node:child_process').spawn): Promise<number>;
export function desktopExecutable(root: string, platform?: NodeJS.Platform): string;
