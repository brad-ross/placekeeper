export interface VscodeExternalLaunch {
  readonly registrationId: string;
  readonly outputPath: string;
}

export function parseVscodeExternalLaunchArguments(args: readonly string[]): VscodeExternalLaunch;
export function buildVscodeExternalRoute(launch: VscodeExternalLaunch): string;
export function launchVscodeExternalRoute(
  launch: VscodeExternalLaunch,
  invokeRoute?: (
    command: string,
    args: readonly string[],
    options: { readonly shell: false },
  ) => Promise<void>,
): Promise<void>;
