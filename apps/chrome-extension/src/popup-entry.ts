import { chromeAutoOpenPorts } from "./chrome-api.js";
import { readAutoOpenState, setAutoOpenEnabled } from "./opt-in.js";

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`Missing extension element: ${selector}`);
  return element;
}

const control = requiredElement<HTMLButtonElement>("#automatic-open");
const stateLabel = requiredElement<HTMLElement>("#automatic-open-state");
const status = requiredElement<HTMLElement>("#status");

const ports = chromeAutoOpenPorts(chrome);
let enabled = false;
control.disabled = true;

function render(nextEnabled: boolean): void {
  enabled = nextEnabled;
  control.setAttribute("aria-checked", String(nextEnabled));
  control.classList.toggle("is-enabled", nextEnabled);
  stateLabel.textContent = nextEnabled ? "On" : "Paused";
}

async function refresh(): Promise<void> {
  const state = await readAutoOpenState(ports);
  if (!state.synchronized) {
    await setAutoOpenEnabled(ports, false);
    render(false);
    status.textContent = "Automatic opening is paused.";
    return;
  }
  render(state.enabled);
}

control.addEventListener("click", async () => {
  control.disabled = true;
  status.textContent = enabled ? "Pausing automatic opening…" : "Enabling automatic opening…";
  const nextEnabled = !enabled;
  try {
    await setAutoOpenEnabled(ports, nextEnabled);
    render(nextEnabled);
    status.textContent = enabled
      ? "PDFs will open automatically in Placekeeper."
      : "Automatic opening is paused.";
  } catch {
    await refresh().catch(() => render(false));
    status.textContent = "Chrome could not update the PDF setting. Try again.";
  } finally {
    control.disabled = false;
    control.focus();
  }
});

void refresh()
  .catch(() => {
    render(false);
    status.textContent = "The PDF setting is unavailable. Automatic opening remains paused.";
  })
  .finally(() => {
    control.disabled = false;
    control.focus();
  });
