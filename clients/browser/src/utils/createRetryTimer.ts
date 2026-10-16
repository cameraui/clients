const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;

export interface RetryTimer {
  schedule(fn: () => void): void;
  cancel(): void;
  reset(): void;
}

export function createRetryTimer(): RetryTimer {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delay = RETRY_MIN_MS;

  function schedule(fn: () => void): void {
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      fn();
    }, delay);
    delay = Math.min(delay * 2, RETRY_MAX_MS);
  }

  function cancel(): void {
    clearTimeout(timer);
    timer = undefined;
  }

  function reset(): void {
    delay = RETRY_MIN_MS;
  }

  return { schedule, cancel, reset };
}
