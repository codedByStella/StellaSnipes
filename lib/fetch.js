'use strict';

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
};

async function fetchWithRetry(url, opts = {}, maxRetries = 3) {
  const {
    headers = {},
    method = 'GET',
    body,
    timeout = 15000,
    retries,
    rateLimitTracker
  } = opts;

  // Allow callers to cap attempts independently of the shared default.
  // This prevents best-effort requests from consuming an excessive
  // portion of a larger operation's time budget.
  const attempts = retries != null ? retries : maxRetries;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      timeout
    );

    try {
      const res = await fetch(url, {
        method,
        headers: {
          ...DEFAULT_HEADERS,
          ...headers
        },
        body,
        signal: controller.signal,
      });

      clearTimeout(timer);

      if ([429, 500, 502, 503, 504].includes(res.status)) {
        // Optional out-parameter allows callers to distinguish
        // rate-limit/server responses from transport failures.
        if (rateLimitTracker) {
          rateLimitTracker.hit = true;
        }

        await sleep(Math.pow(2, attempt) * 1000);
        continue;
      }

      return res;

    } catch (e) {
      clearTimeout(timer);

      // A timeout is distinguishable from a DNS or network failure.
      if (e.name === 'AbortError' && rateLimitTracker) {
        rateLimitTracker.hit = true;
      }

      if (attempt === attempts - 1) {
        throw e;
      }

      await sleep(Math.pow(2, attempt) * 1000);
    }
  }

  return null;
}

async function fetchText(url, opts) {
  try {
    const res = await fetchWithRetry(url, opts);

    if (!res || !res.ok) return null;

    return await res.text();
  } catch {
    return null;
  }
}

async function fetchJson(url, opts) {
  try {
    const res = await fetchWithRetry(url, opts);

    if (!res || !res.ok) return null;

    const text = await res.text();

    if (!text || !text.trim()) return null;

    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = {
  fetchWithRetry,
  fetchText,
  fetchJson,
  sleep
};
