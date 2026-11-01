'use strict';

// Concurrency + min-gap limiter.

function createLimiter({ concurrency = 1, minGapMs = 0 } = {}) {
  let active = 0;
  let nextAllowed = 0;
  const queue = [];

  function schedule() {
    if (active >= concurrency || queue.length === 0) return;

    const now = Date.now();
    const wait = Math.max(0, nextAllowed - now);
    const job = queue.shift();

    active++;
    nextAllowed = Math.max(now, nextAllowed) + minGapMs;

    setTimeout(async () => {
      try {
        job.resolve(await job.fn());
      } catch (e) {
        job.reject(e);
      } finally {
        active--;
        schedule();
      }
    }, wait);

    schedule();
  }

  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    schedule();
  });
}

// Retry an async function with exponential backoff.
// Returned values, including valid negative results, pass through immediately.
// Rejection occurs only after all attempts fail.

async function retryAsync(fn, { attempts = 3, baseMs = 500 } = {}) {
  let lastErr;

  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;

      if (i < attempts - 1) {
        await new Promise(r =>
          setTimeout(r, baseMs * Math.pow(2, i))
        );
      }
    }
  }

  throw lastErr;
}

module.exports = { createLimiter, retryAsync };
