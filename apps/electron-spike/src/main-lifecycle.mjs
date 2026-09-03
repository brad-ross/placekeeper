export function createMainLifecycle({
  dispatchAction,
  focusWindow,
  now = () => performance.now(),
  parseRequestedPdfPath,
  presentFailure,
}) {
  let ready = false;
  let operationChain = Promise.resolve();
  const pendingActions = [];

  function createAction(kind, value, receivedAt = now()) {
    return { kind, receivedAt, value };
  }

  async function dispatchSafely(action) {
    try {
      await dispatchAction(action);
    } catch (error) {
      await presentFailure(error);
    }
  }

  function schedule(action) {
    operationChain = operationChain
      .catch(() => undefined)
      .then(() => dispatchSafely(action));
  }

  function enqueue(action) {
    if (!ready) {
      pendingActions.push(action);
      return;
    }
    schedule(action);
  }

  function receivePdf(pdfPath) {
    const action = createAction("pdf", pdfPath);
    enqueue(action);
    return action;
  }

  function receiveLink(link) {
    const action = createAction("link", link);
    enqueue(action);
    return action;
  }

  function markReady() {
    if (ready) return 0;
    ready = true;
    const actions = pendingActions.splice(0);
    for (const action of actions) schedule(action);
    return actions.length;
  }

  async function handleSecondInstance({ additionalData, argv }) {
    const receivedAt = now();
    try {
      const suppliedPath = typeof additionalData?.pdfPath === "string"
        ? parseRequestedPdfPath([additionalData.pdfPath])
        : parseRequestedPdfPath(argv);
      if (suppliedPath !== undefined) enqueue(createAction("pdf", suppliedPath, receivedAt));
    } catch (error) {
      await presentFailure(error);
    } finally {
      focusWindow();
    }
  }

  return {
    createPdfAction: (pdfPath, receivedAt) => createAction("pdf", pdfPath, receivedAt),
    enqueue,
    handleSecondInstance,
    markReady,
    pendingCount: () => pendingActions.length,
    receiveLink,
    receivePdf,
    waitForIdle: () => operationChain,
  };
}

export async function openLinkWithConfirmation({
  action,
  canonicalize,
  confirm,
  open,
  preflight,
  showReview,
}) {
  const canonicalLink = canonicalize(action.value);
  const result = await preflight(canonicalLink);
  let confirmed = false;
  if (result.confirmationRequired) {
    confirmed = await confirm(result.path);
    if (!confirmed) return false;
  }
  let opened = await open(canonicalLink, confirmed);
  let pdfPath = result.path;
  if (typeof opened !== "string") {
    if (confirmed) throw new Error("The Placekeeper link remained unconfirmed");
    pdfPath = opened.path;
    if (!await confirm(pdfPath)) return false;
    opened = await open(canonicalLink, true);
    if (typeof opened !== "string") throw new Error("The Placekeeper link remained unconfirmed");
  }
  await showReview(opened, pdfPath, action.receivedAt);
  return true;
}
