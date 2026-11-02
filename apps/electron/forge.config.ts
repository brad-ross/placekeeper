import { resolve } from "node:path";
import { MakerZIP } from "@electron-forge/maker-zip";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerDeb } from "@electron-forge/maker-deb";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { FuseV1Options, FuseVersion } from "@electron/fuses";

const repo = resolve(__dirname, "../..");
const target = process.env.PLACEKEEPER_DESKTOP_TARGET ?? `${process.platform}-${process.arch}`;

export default {
  outDir: resolve(repo, "dist/desktop-artifacts"),
  packagerConfig: {
    name: "Placekeeper Candidate",
    executableName: "PlacekeeperCandidate",
    appBundleId: "local.placekeeper.electron-candidate",
    appCategoryType: "public.app-category.productivity",
    asar: true,
    prune: false,
    ignore: (path: string) => path !== "" && !/^\/(?:package\.json$|dist(?:\/|$))/u.test(path),
    extraResource: [resolve(repo, "dist/desktop-runtime", target, "desktop")],
  },
  makers: [
    new MakerZIP({}, ["darwin"]),
    new MakerSquirrel({ name: "PlacekeeperCandidate", authors: "Brad Ross", description: "Placekeeper desktop personal test candidate" }),
    new MakerDeb({ options: { maintainer: "Brad Ross", homepage: "https://github.com/brad-ross/placekeeper" } }),
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
