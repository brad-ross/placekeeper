import { isAbsolute } from "node:path";

export const PLACEKEEPER_ORIGIN = "http://127.0.0.1:43179";

const BOOTSTRAP_PATH = /^\/s\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/bootstrap$/u;
const CAPABILITY_FRAGMENT = /^#cap=[A-Za-z0-9_-]{43}$/u;

export function requestedPdfPath(argv) {
  const candidates = argv.filter((argument) => (
    !argument.startsWith("-") &&
    isAbsolute(argument) &&
    argument.toLowerCase().endsWith(".pdf")
  ));
  if (candidates.length > 1) throw new Error("Open one PDF at a time");
  return candidates[0];
}

export function launcherArguments(pdfPath) {
  if (!isAbsolute(pdfPath) || !pdfPath.toLowerCase().endsWith(".pdf")) {
    throw new Error("The PDF path must be absolute");
  }
  return ["open", "--json", "--surface", "finder", "--pdf", pdfPath];
}

function assertPlacekeeperLink(link) {
  if (typeof link !== "string" || link.length > 16_384 || !link.startsWith("placekeeper:")) {
    throw new Error("A canonical Placekeeper link is required");
  }
}

export function canonicalPlacekeeperLink(link) {
  if (typeof link !== "string") throw new Error("A Placekeeper link is required");
  if (link.startsWith("placekeeper:")) return link;
  if (link.startsWith("placekeeper-electron-spike:")) {
    return `placekeeper:${link.slice("placekeeper-electron-spike:".length)}`;
  }
  throw new Error("A Placekeeper link is required");
}

export function linkPreflightArguments(link) {
  assertPlacekeeperLink(link);
  return ["open-link", "--json", "--preflight", "--link", link];
}

export function linkOpenArguments(link, confirmed = false) {
  assertPlacekeeperLink(link);
  return [
    "open-link",
    "--json",
    "--surface",
    "finder",
    ...(confirmed ? ["--confirmed"] : []),
    "--link",
    link,
  ];
}

export function launchResultUrl(result) {
  if (
    result?.ok !== true ||
    !["opened", "focused"].includes(result.kind) ||
    typeof result.url !== "string"
  ) {
    throw new Error("Invalid Placekeeper launch response");
  }

  let url;
  try {
    url = new URL(result.url);
  } catch {
    throw new Error("Invalid Placekeeper launch response");
  }
  if (
    url.origin !== PLACEKEEPER_ORIGIN ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    !BOOTSTRAP_PATH.test(url.pathname) ||
    !CAPABILITY_FRAGMENT.test(url.hash)
  ) {
    throw new Error("Invalid Placekeeper launch response");
  }
  return result.url;
}

export function shouldAllowNavigation(value) {
  try {
    const url = new URL(value);
    return url.origin === PLACEKEEPER_ORIGIN && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

export function isReviewReadyForProbe(snapshot) {
  if (
    snapshot?.hasProductionReview !== true ||
    snapshot.hasViewerFramingViewport !== true ||
    snapshot.hasPdfWorkspaceLoading !== false ||
    snapshot.hasViewerStatus !== false
  ) return false;
  try {
    const url = new URL(snapshot.url);
    return (
      url.origin === PLACEKEEPER_ORIGIN &&
      url.username === "" &&
      url.password === "" &&
      url.pathname.startsWith("/r/")
    );
  } catch {
    return false;
  }
}

export function createWindowOptions() {
  return {
    backgroundColor: "#f4f1ea",
    height: 900,
    minHeight: 600,
    minWidth: 800,
    show: false,
    title: "Placekeeper",
    width: 1280,
    webPreferences: {
      allowRunningInsecureContent: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  };
}
