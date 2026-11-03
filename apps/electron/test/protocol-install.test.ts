import { describe, expect, it, vi } from "vitest";
import { DESKTOP_URL_SCHEMES, handleWindowsProtocolInstall } from "../src/protocol-install.js";
const executable = 'C:\\Users\\Reader\\AppData\\Local\\Placekeeper\\app-0.2.4\\PlacekeeperDesktop.exe';
function application(isPackaged = true) {
  return { isPackaged, setAsDefaultProtocolClient: vi.fn().mockReturnValue(true), removeAsDefaultProtocolClient: vi.fn().mockReturnValue(true) };
}
describe("Windows installer protocol registration", () => {
  it.each(["--squirrel-install", "--squirrel-updated"])("registers only Placekeeper URL schemes for explicit %s", event => {
    const app = application();
    expect(handleWindowsProtocolInstall(app, { platform: "win32", argv: [executable, event, "0.2.4"], executable })).toEqual({ handled: true, exitCode: 0 });
    expect(app.setAsDefaultProtocolClient.mock.calls).toEqual(DESKTOP_URL_SCHEMES.map(scheme => [scheme, executable, []]));
    expect(app.removeAsDefaultProtocolClient).not.toHaveBeenCalled();
  });
  it.each(["darwin", "linux"] as const)("does not register from %s launches even with a Windows event argument", platform => {
    const app = application();
    expect(handleWindowsProtocolInstall(app, { platform, argv: [executable, "--squirrel-install"], executable }).handled).toBe(false);
    expect(app.setAsDefaultProtocolClient).not.toHaveBeenCalled();
  });
  it("never registers during ordinary Windows or isolated test startup", () => {
    const app = application();
    expect(handleWindowsProtocolInstall(app, { platform: "win32", argv: [executable, "--isolated-installed-smoke", "--http-port", "43127"], executable }).handled).toBe(false);
    expect(app.setAsDefaultProtocolClient).not.toHaveBeenCalled();
    expect(app.removeAsDefaultProtocolClient).not.toHaveBeenCalled();
  });
  it.each([false, true])("does not register development or obsolete invocations (packaged %s)", isPackaged => {
    const app = application(isPackaged);
    handleWindowsProtocolInstall(app, { platform: "win32", argv: [executable, isPackaged ? "--squirrel-obsolete" : "--squirrel-install"], executable });
    expect(app.setAsDefaultProtocolClient).not.toHaveBeenCalled();
  });
  it("uses Electron's ownership-checking removal API on uninstall", () => {
    const app = application(); app.removeAsDefaultProtocolClient.mockReturnValue(false);
    expect(handleWindowsProtocolInstall(app, { platform: "win32", argv: [executable, "--squirrel-uninstall"], executable }).exitCode).toBe(0);
    expect(app.removeAsDefaultProtocolClient.mock.calls).toEqual(DESKTOP_URL_SCHEMES.map(scheme => [scheme, executable, []]));
    expect(app.setAsDefaultProtocolClient).not.toHaveBeenCalled();
  });
  it("reports registration failure to the installer", () => {
    const app = application(); app.setAsDefaultProtocolClient.mockReturnValue(false);
    expect(handleWindowsProtocolInstall(app, { platform: "win32", argv: [executable, "--squirrel-updated"], executable }).exitCode).toBe(1);
  });
});
