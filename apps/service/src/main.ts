import { join } from "node:path";
import { homedir } from "node:os";
import { startHttpServer, type LocalHttpServer } from "./server/http-server.js";
import {
  SessionBroker,
  type OpenReviewRequest,
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
  request: OpenReviewRequest,
  recoveryRoot = join(
    homedir(),
    "Library",
    "Application Support",
    "PDF Proofreader",
    "recovery",
  ),
): Promise<RunningLocalService> {
  const broker = new SessionBroker({ recoveryRoot });
  await broker.initialize();
  const opened = await broker.openReview(request);
  if (opened.kind === "recovery-offered") {
    throw new Error("A recovery decision is required before launching the review");
  }
  const server = await startHttpServer(broker);
  const launchUrl = `${server.origin}${opened.launch.launchPath}${opened.launch.fragment}`;
  return {
    broker,
    server,
    launch: opened.launch,
    launchUrl,
    close: () => server.close(),
  };
}
