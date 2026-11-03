import { readFile } from "node:fs/promises";
import { installMacCompatibility } from "../../packaging/desktop/macos-compatibility";
import { inventory } from "../../packaging/desktop/package-assets";
import { resolve } from "node:path";
import { MakerZIP } from "@electron-forge/maker-zip";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerDeb } from "@electron-forge/maker-deb";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { FuseV1Options, FuseVersion } from "@electron/fuses";

const repo = resolve(__dirname, "../..");
const target = process.env.PLACEKEEPER_DESKTOP_TARGET ?? `${process.platform}-${process.arch}`;
const executableName = "PlacekeeperDesktop";

export default {
  outDir: resolve(repo, "dist/desktop-artifacts"),
  packagerConfig: {
    name: "Placekeeper",
    icon: resolve(repo, "dist/desktop-icons/Placekeeper"),
    executableName,
    appBundleId: "local.placekeeper",
    appCategoryType: "public.app-category.productivity",
    extendInfo: {
      CFBundleURLTypes: [{ CFBundleURLName: "local.placekeeper.review-link", CFBundleTypeRole: "Viewer",
        CFBundleURLSchemes: ["placekeeper", "placekeeper-navigation"] }],
      CFBundleDocumentTypes: [{ CFBundleTypeName: "PDF document", CFBundleTypeRole: "Viewer",
        LSHandlerRank: "Alternate", LSItemContentTypes: ["com.adobe.pdf"] }],
    },
    asar: true,
    prune: false,
    ignore: (path: string) => path !== "" && !/^\/(?:package\.json$|dist(?:\/|$))/u.test(path),
    extraResource: [resolve(repo, "dist/desktop-runtime", target, "desktop")],
  },
  hooks: {
    packageAfterCopy: async (_config: unknown, buildPath: string, _electronVersion: string, platform: string) => {
      if (platform === "darwin") await installMacCompatibility(resolve(buildPath, ".."));
    },
    prePackage: async (_config: unknown, platform: string, arch: string) => {
      if (`${platform}-${arch}` !== target || platform !== process.platform) throw new Error("Prepare this exact target on its native build host before packaging");
      const runtime = resolve(repo, "dist/desktop-runtime", target, "desktop");
      const evidence = JSON.parse(await readFile(resolve(runtime, "build-evidence.json"), "utf8")) as {
        target: string; runtimeManifestSha256: string; resourceFiles: Array<{ path: string; sha256: string }>; shellFiles: Array<{ path: string; sha256: string }>;
      };
      const files = await inventory(runtime);
      const manifestHash = files.find(file => file.path === "runtime-manifest.json")?.sha256;
      const resources = files.filter(file => !["runtime-manifest.json", "build-evidence.json"].includes(file.path));
      if (evidence.target !== target || manifestHash !== evidence.runtimeManifestSha256 || JSON.stringify(resources) !== JSON.stringify(evidence.resourceFiles) ||
          JSON.stringify(await inventory(resolve(repo, "apps/electron/dist"))) !== JSON.stringify(evidence.shellFiles)) {
        throw new Error("Desktop build assets changed; rebuild the runtime before packaging");
      }
    },
  },
  makers: [
    new MakerZIP({}, ["darwin"]),
    new MakerSquirrel({ setupIcon: resolve(repo, "dist/desktop-icons/Placekeeper.ico"), noMsi: true, name: "Placekeeper", authors: "Brad Ross", description: "Placekeeper PDF review" }),
    new MakerDeb({ options: { bin: executableName, mimeType: ["application/pdf", "x-scheme-handler/placekeeper", "x-scheme-handler/placekeeper-navigation"], maintainer: "Brad Ross", homepage: "https://github.com/brad-ross/placekeeper", icon: resolve(repo, "dist/desktop-icons/Placekeeper.png") } }),
  ],
  plugins: [new FusesPlugin({
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  })],
};
