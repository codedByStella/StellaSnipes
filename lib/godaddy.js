'use strict';

const { env } = require('./config');

const API_BASE = '[REDACTED: provider API base URL]';

function apiHeaders() {
  return {
    'Authorization': `[REDACTED: provider authentication header]`,
    'Accept': 'application/json',
  };
}

// Log the first authentication or service error once per process.
let _apiErrorWarned = false;

function warnApiErrorOnce(kind, status) {
  if (_apiErrorWarned) return;

  _apiErrorWarned = true;

  console.error(
    `[API] Service error first seen this run: ${kind} (HTTP ${status}). ` +
    `Affected results retain a distinct error state.`
  );
}

async function apiGet(path, timeout = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: apiHeaders(),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      // A not-found response represents a genuine absence of data.
      // Authentication, rate-limit, and server failures are different:
      // the request could not establish whether data exists.
      if ([401, 403, 429, 500, 502, 503, 504].includes(res.status)) {
        const kind =
          res.status === 429
            ? 'rate_limit'
            : [401, 403].includes(res.status)
              ? 'auth'
              : 'server_error';

        warnApiErrorOnce(kind, res.status);

        return {
          error: true,
          status: res.status,
          kind
        };
      }

      return null;
    }

    return await res.json();

  } catch {
    clearTimeout(timer);
    return null;
  }
}

// ── Listing lookup ─────────────────────────────────────────────────────

async function getAuctionDetails(domain) {
  const data = await apiGet(
    `[REDACTED: listing endpoint]`
  );

  if (data?.error) return data;
  if (!data) return null;

  return {
    in_auction: true,
    current_bid: data.currentPrice ?? null,
    min_bid: data.minimumPrice ?? null,
    bid_count: data.bidCount ?? 0,
    time_left: data.timeLeft ?? null,
    end_time: data.endTime ?? null,
    est_value: data.estimatedValue ?? null,
    traffic: data.pageViews ?? null,
    age_years: data.years ?? null,
    listing_type: data.type ?? null,
  };
}

// ── Appraisal lookup ───────────────────────────────────────────────────

async function getAppraisal(domain) {
  const data = await apiGet(
    `[REDACTED: appraisal endpoint]`
  );

  if (data?.error) return data;
  if (!data) return null;

  return {
    est_value: data.govalue ?? null,
    comparable_sales: (data.comparables ?? []).slice(0, 3).map(c => ({
      domain: c.domain,
      price: c.price,
      sold: c.soldDate,
    })),
  };
}

// ── Availability lookup ────────────────────────────────────────────────

async function checkAvailable(domain) {
  const data = await apiGet(
    `[REDACTED: availability endpoint and provider-specific parameters]`
  );

  if (data?.error) return data;
  if (!data) return null;

  return {
    available: data.available === true,
    definitive: data.definitive === true,
    price_usd: data.price
      ? +(data.price / 1e6).toFixed(2)
      : null,
  };
}

// ── Enrichment pass ────────────────────────────────────────────────────

async function enrichDomains(domains, log = console.log) {
  // [REDACTED] Original provider credential validation.

  log('[API] Enrichment credentials unavailable or not configured.');
  return domains.map(d => ({ ...d, gd: null }));
}

// [REDACTED] Original enrichment implementation:
// - Initial credential/service probe
// - Bounded concurrent batches with stable input ordering
// - Parallel listing, appraisal, and availability requests
// - Independent error-state extraction and normalization
// - Per-record diagnostic logging and failure isolation
// - Final enriched result assembly

module.exports = {
  enrichDomains,
  getAuctionDetails,
  getAppraisal,
  checkAvailable
};
