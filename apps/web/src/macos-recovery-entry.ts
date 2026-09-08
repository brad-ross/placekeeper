// Share the current modal controls; only the Mac host omits the surrounding canvas.
import '../../chrome-extension/src/extension.css';
import './app/macos-recovery.css';
import { createRecoveryButtons } from '../../chrome-extension/src/handler-ui.js';

const target = window as typeof window & {
  webkit?: { messageHandlers?: { placekeeperRecovery?: {
    postMessage(message: { decision: string } | { ready: true } | { height: number }): void;
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

const dialog = document.querySelector<HTMLElement>('.handler-dialog')!;
let reportedHeight = 0;
const reportSize = () => {
  const height = Math.ceil(document.body.getBoundingClientRect().height);
  if (height === reportedHeight) return;
  reportedHeight = height;
  try { bridge?.postMessage({ height }); } catch { fail(); }
};
new ResizeObserver(reportSize).observe(dialog);
reportSize();
try { bridge?.postMessage({ ready: true }); } catch { fail(); }
