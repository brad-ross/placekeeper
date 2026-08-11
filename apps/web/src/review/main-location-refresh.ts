export interface TrailingTaskScheduler {
  schedule(): void;
  cancel(): void;
}

/** Coalesces high-frequency viewer signals into one trailing semantic capture. */
export function createTrailingTaskScheduler(
  task: () => void,
  delayMs = 80,
): TrailingTaskScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    schedule() {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        task();
      }, delayMs);
    },
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
