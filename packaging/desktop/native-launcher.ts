import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "native-launcher.c");
export async function buildNativeLaunchers(
  root: string,
  target: string,
  run: (command: string, args: string[]) => Promise<void>,
): Promise<void> {
  const [platform, arch] = target.split("-");
  if (platform !== process.platform) throw new Error("Native launchers require their target OS compiler");
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  for (const chrome of [false, true]) {
    const basename = chrome ? "placekeeper-chrome-native-host" : "placekeeper";
    const output = join(bin, `${basename}${platform === "win32" ? ".exe" : ""}`);
    if (platform === "win32") {
      await run("cl.exe", ["/nologo", "/W4", "/WX", "/O2", "/MT", ...(chrome ? ["/DCHROME_NATIVE_HOST=1"] : []), source, `/Fe:${output}`, `/Fo:${join(bin, `${basename}.obj`)}`]);
      await rm(join(bin, `${basename}.obj`));
    } else {
      await run(platform === "darwin" ? "clang" : "cc", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", ...(platform === "darwin" ? ["-arch", arch === "x64" ? "x86_64" : "arm64", "-mmacosx-version-min=13.0"] : []), ...(chrome ? ["-DCHROME_NATIVE_HOST=1"] : []), source, "-o", output]);
    }
  }
}
