import { chromeAutoOpenPorts } from "./chrome-api.js";
import { readAutoOpenState, setAutoOpenEnabled } from "./opt-in.js";

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`Missing extension element: ${selector}`);
  return element;
}

const control = requiredElement<HTMLButtonElement>("#automatic-open");
const status = requiredElement<HTMLElement>("#status");
const title = requiredElement<HTMLElement>("#title");
let keyboardInteraction = false;
document.addEventListener("keydown", () => { keyboardInteraction = true; });

const ports = chromeAutoOpenPorts(chrome);
let enabled = false;
control.disabled = true;

function render(nextEnabled: boolean): void {
  enabled = nextEnabled;
  control.setAttribute("aria-checked", String(nextEnabled));
  control.classList.toggle("is-enabled", nextEnabled);
}

async function refresh(): Promise<void> {
  const state = await readAutoOpenState(ports);
  if (!state.synchronized) {
    await setAutoOpenEnabled(ports, false);
    render(false);
    status.textContent = "Automatic opening paused.";
    return;
  }
  render(state.enabled);
}

control.addEventListener("click", async (event) => {
  const restoreKeyboardFocus = event.detail === 0;
  control.disabled = true;
  status.textContent = enabled ? "Pausing…" : "Enabling…";
  const nextEnabled = !enabled;
  try {
    await setAutoOpenEnabled(ports, nextEnabled);
    render(nextEnabled);
    status.textContent = enabled
      ? "PDFs open in Placekeeper."
      : "Automatic opening paused.";
  } catch {
    await refresh().catch(() => render(false));
    status.textContent = "Couldn’t update Chrome’s PDF setting. Try again.";
  } finally {
    control.disabled = false;
    if (restoreKeyboardFocus) control.focus({ preventScroll: true });
  }
});

void refresh()
  .catch(() => {
    render(false);
    status.textContent = "Chrome’s PDF setting is unavailable.";
  })
  .finally(() => {
    control.disabled = false;
    if (!keyboardInteraction) title.focus({ preventScroll: true });
  });
