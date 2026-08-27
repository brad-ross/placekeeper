import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface DestinationPicker {
  chooseFolder(defaultFolder?: string): Promise<string | undefined>;
  locatePdf(defaultFolder: string): Promise<string | undefined>;
}

async function osascript(script: string, argument?: string): Promise<string | undefined> {
  try {
    const args = argument === undefined ? ["-e", script] : ["-e", script, "--", argument];
    const { stdout } = await execFileAsync("/usr/bin/osascript", args, {
      timeout: 5 * 60_000,
      maxBuffer: 16 * 1024,
    });
    const selected = stdout.trim();
    return selected === "" ? undefined : selected;
  } catch (error) {
    if ((error as { stderr?: string }).stderr?.includes("-128")) return undefined;
    throw error;
  }
}

export class MacOsDestinationPicker implements DestinationPicker {
  chooseFolder(defaultFolder?: string): Promise<string | undefined> {
    return osascript(
      defaultFolder === undefined
        ? 'set chosen to choose folder with prompt "Choose where to save the annotated PDF"\nreturn POSIX path of chosen'
        : 'on run argv\nset chosen to choose folder with prompt "Choose where to save the annotated PDF" default location POSIX file (item 1 of argv)\nreturn POSIX path of chosen\nend run',
      defaultFolder,
    );
  }

  locatePdf(defaultFolder: string): Promise<string | undefined> {
    return osascript(
      'on run argv\nset chosen to choose file with prompt "Locate the annotated PDF" of type {"com.adobe.pdf"} default location POSIX file (item 1 of argv)\nreturn POSIX path of chosen\nend run',
      defaultFolder,
    );
  }
}
