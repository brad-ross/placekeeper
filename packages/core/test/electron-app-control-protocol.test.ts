import { expect, it } from "vitest";
import { parseElectronAppControlMessage } from "../src/electron-app-control-protocol.js";
it("accepts local Neovim sockets and Windows pipes while rejecting remote endpoints", () => {
  const message = { protocolVersion: 1, type: "associate-editor", appInstanceId: "app_instance_1234", helperId: "helper_instance_1234", profile: "nvim", sourceRoot: "C:\\Papers" };
  for (const socket of ["/tmp/nvim.sock", "\\\\.\\pipe\\nvim-test"]) expect(parseElectronAppControlMessage({ ...message, socket })).toBeDefined();
  for (const socket of ["\\\\server\\pipe\\nvim-test", "//server/socket", "localhost:1234", "C:\\not-a-pipe"]) expect(parseElectronAppControlMessage({ ...message, socket })).toBeUndefined();
});
