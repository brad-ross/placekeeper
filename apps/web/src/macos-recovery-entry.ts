// Use the Chrome recovery presentation itself so the two hosts stay in sync.
import '../../chrome-extension/src/extension.css';
import { createRecoveryButtons } from '../../chrome-extension/src/handler-ui.js';

const target = window as typeof window & {
  webkit?: { messageHandlers?: { placekeeperRecovery?: {
    postMessage(message: { decision: string } | { ready: true }): void;
  } } };
};
const bridge = target.webkit?.messageHandlers?.placekeeperRecovery;

const actions = document.querySelector<HTMLElement>('#handler-actions')!;
const status = document.querySelector<HTMLElement>('#status')!;
const buttons = createRecoveryButtons(document);
const group = document.createElement('div');
group.className = 'handler-recovery-actions';
group.append(...buttons);
actions.append(group);

let settled = false;
function fail(): void {
  settled = true;
  buttons.forEach((button) => { button.disabled = true; });
  status.textContent = 'That recovery choice could not be completed. Close this window and try again.';
}

window.addEventListener('placekeeper-recovery-failed', fail);
for (const button of buttons) {
  button.addEventListener('click', () => {
    if (settled) return;
    settled = true;
    buttons.forEach((control) => { control.disabled = true; });
    status.textContent = 'Opening the protected review…';
    try {
      if (!bridge) { fail(); return; }
      bridge.postMessage({ decision: button.dataset.recoveryChoice! });
    } catch { fail(); }
  });
}
buttons.at(-1)!.focus({ preventScroll: true });

try { bridge?.postMessage({ ready: true }); } catch { fail(); }
