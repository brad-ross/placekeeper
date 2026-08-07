import { chmod, mkdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";

import type { LaunchRequest, LaunchResponse, ProofreaderHost } from "./proofreader-host.js";

const MAX_MESSAGE_BYTES = 64 * 1024;

export interface LaunchControlServer {
  readonly socketPath: string;
  close(): Promise<void>;
}

function writeResponse(socket: Socket, response: LaunchResponse): void {
  socket.end(`${JSON.stringify(response)}\n`);
}

export async function startLaunchControlServer(
  host: ProofreaderHost,
  socketPath: string,
): Promise<LaunchControlServer> {
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  const server = createServer((socket) => {
    let raw = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      raw += chunk;
      if (Buffer.byteLength(raw) > MAX_MESSAGE_BYTES) {
        socket.destroy();
        return;
      }
      const newline = raw.indexOf("\n");
      if (newline === -1) return;
      socket.pause();
      try {
        const request = JSON.parse(raw.slice(0, newline)) as LaunchRequest;
        void host.open(request).then(
          (response) => writeResponse(socket, response),
          () => writeResponse(socket, {
            ok: false,
            error: {
              kind: "input-unavailable",
              message: "The local proofreader could not open this PDF.",
              recoveryAction: "Choose one readable local PDF",
            },
          }),
        );
      } catch {
        writeResponse(socket, {
          ok: false,
          error: {
            kind: "input-unavailable",
            message: "The launch request was invalid.",
            recoveryAction: "Choose one readable local PDF",
          },
        });
      }
    });
  });
  await listen(server, socketPath);
  await chmod(socketPath, 0o600);
  return {
    socketPath,
    close: async () => {
      await closeServer(server);
      await unlink(socketPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    },
  };
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

export function requestLaunch(
  socketPath: string,
  request: LaunchRequest,
): Promise<LaunchResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let raw = "";
    socket.setEncoding("utf8");
    socket.setTimeout(5_000, () => socket.destroy(new Error("Launch service timed out")));
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      raw += chunk;
      if (Buffer.byteLength(raw) > MAX_MESSAGE_BYTES) {
        socket.destroy(new Error("Launch response exceeded its size limit"));
      }
    });
    socket.once("error", reject);
    socket.once("end", () => {
      try {
        resolve(JSON.parse(raw) as LaunchResponse);
      } catch {
        reject(new Error("Launch service returned an invalid response"));
      }
    });
  });
}
