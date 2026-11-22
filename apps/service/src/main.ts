import { join } from "node:path";
import { homedir } from "node:os";
import { startHttpServer, type LocalHttpServer } from "./server/http-server.js";
import {
  SessionBroker,
  type OpenDocumentRequest,
  type SessionLaunch,
} from "./sessions/session-broker.js";

export interface RunningLocalService {
  readonly broker: SessionBroker;
  readonly server: LocalHttpServer;
  readonly launch: SessionLaunch;
  readonly launchUrl: string;
  close(): Promise<void>;
}

export async function startLocalService(
  request: OpenDocumentRequest,
  recoveryRoot = join(
    homedir(),
    "Library",
    "Application Support",
    "Placekeeper",
    "recovery",
  ),
): Promise<RunningLocalService> {
  const broker = new SessionBroker({ recoveryRoot });
  await broker.initialize();
  const opened = await broker.openDocument(request);
  if (opened.kind === "recovery-offered") {
    throw new Error("A recovery decision is required before opening the document");
  }
  const server = await startHttpServer(broker);
  const launchUrl = `${server.origin}${opened.launch.launchPath}${opened.launch.fragment}`;
  return {
    broker,
    server,
    launch: opened.launch,
    launchUrl,
    close: async () => {
      try {
        await server.close();
      } finally {
        await broker.quiesceForShutdown();
      }
    },
  };
}
