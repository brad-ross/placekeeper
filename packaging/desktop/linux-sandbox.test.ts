import { describe, expect, it, vi } from "vitest";
import { assertLinuxUserSandbox } from "./linux-sandbox.mjs";
const apparmor = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";
const clone = "/proc/sys/kernel/unprivileged_userns_clone";
const limit = "/proc/sys/user/max_user_namespaces";
const read = (values: Record<string, string | undefined>) => async (path: string) => values[path];
describe("Linux user-local source-install sandbox prerequisite", () => {
  it("rejects Ubuntu's AppArmor restriction even when a generic unshare probe could succeed", async () => {
    const probe = vi.fn().mockResolvedValue(undefined);
    await expect(assertLinuxUserSandbox({ uid: 1000, readControl: read({ [apparmor]: "1", [clone]: "1", [limit]: "15411" }), probe })).rejects.toThrow("AppArmor restricts");
    expect(probe).not.toHaveBeenCalled();
  });
  it.each([{ [clone]: "0", [limit]: "15411" }, { [clone]: "1", [limit]: "0" }])("rejects disabled namespace controls before trying an installation", async values => {
    const probe = vi.fn();
    await expect(assertLinuxUserSandbox({ uid: 1000, readControl: read(values), probe })).rejects.toThrow("namespaces are disabled");
    expect(probe).not.toHaveBeenCalled();
  });
  it("accepts an ordinary user only after unrestricted controls and a successful namespace probe", async () => {
    const probe = vi.fn().mockResolvedValue(undefined);
    await expect(assertLinuxUserSandbox({ uid: 1000, readControl: read({ [apparmor]: "0", [clone]: "1", [limit]: "15411" }), probe })).resolves.toBeUndefined();
    expect(probe).toHaveBeenCalledOnce();
  });
  it("supports kernels without distribution-specific controls when the actual namespace probe succeeds", async () => {
    const probe = vi.fn().mockResolvedValue(undefined);
    await expect(assertLinuxUserSandbox({ uid: 1000, readControl: read({}), probe })).resolves.toBeUndefined();
    expect(probe).toHaveBeenCalledOnce();
  });
  it.each(["EPERM", "ENOENT"])("rejects a blocked or missing namespace probe (%s)", async code => {
    await expect(assertLinuxUserSandbox({ uid: 1000, readControl: read({ [clone]: "1", [limit]: "15411" }), probe: vi.fn().mockRejectedValue(Object.assign(new Error(code), { code })) })).rejects.toThrow("probe is unavailable or blocked");
  });
  it("does not report unknown kernel controls as verified", async () => {
    await expect(assertLinuxUserSandbox({ uid: 1000, readControl: read({ [clone]: "unexpected" }), probe: vi.fn() })).rejects.toThrow("Cannot verify");
  });
  it("rejects running the user-local Electron installer as root", async () => {
    await expect(assertLinuxUserSandbox({ uid: 0, readControl: vi.fn(), probe: vi.fn() })).rejects.toThrow("ordinary user");
  });
});
