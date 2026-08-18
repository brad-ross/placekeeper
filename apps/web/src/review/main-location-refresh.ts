export interface TrailingTaskScheduler {
  schedule(): void;
  flush(): void;
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
    flush() {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
      task();
    },
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

export async function waitForReviewNavigationReady(input: {
  readonly isReady: () => boolean;
  readonly isCurrent: () => boolean;
  readonly wait?: () => Promise<void>;
}): Promise<boolean> {
  const wait = input.wait ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 100)));
  while (input.isCurrent() && !input.isReady()) await wait();
  return input.isCurrent() && input.isReady();
}
