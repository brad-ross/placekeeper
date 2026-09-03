const MINIMUM_OVERRUN_TOLERANCE_MS = 1_000;
const MAXIMUM_OVERRUN_TOLERANCE_MS = 5_000;

/**
 * Browser and service timers can all resume at once after the host wakes. A
 * substantially overdue callback is therefore not evidence that its peer was
 * idle; grant the peer one normal deadline to report liveness.
 */
export function deadlineWasSubstantiallyDelayed(
  armedAt: number,
  delayMs: number,
  observedAt: number,
): boolean {
  const tolerance = Math.min(
    MAXIMUM_OVERRUN_TOLERANCE_MS,
    Math.max(MINIMUM_OVERRUN_TOLERANCE_MS, delayMs * 0.1),
  );
  return observedAt - armedAt > delayMs + tolerance;
}
