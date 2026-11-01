'use strict';

const { C } = require('./config');

// ── Lifecycle watchlist ───────────────────────────────────────────────────

// [REDACTED] Original domain lifecycle timing and acquisition-window
// configuration.

// Estimate a lifecycle transition date from the initial observation.
function estimateDropDate(firstSeenDark) {
  const d = new Date(firstSeenDark);

  // [REDACTED] Original lifecycle interval calculation.
  return d.toISOString().slice(0, 10);
}

// Queue records that have entered the monitored lifecycle.
// Existing entries are left untouched.
// Returns only newly added records.
//
// Source records may carry their own observation date. Records without
// one fall back to the supplied execution time.
async function enqueueExpirations(store, records, now = new Date()) {
  const added = [];

  for (const rec of records) {
    const firstSeenDark = rec.zoneDate
      ? `${rec.zoneDate}T00:00:00.000Z`
      : now.toISOString();

    const estDropDate = estimateDropDate(firstSeenDark);

    const isNew = await store.addToWatch(rec.domain, {
      firstSeenDark,
      estDropDate,
      profitScore: rec.profit_score ?? null,
      lgProfit: rec.lg_profit ?? null,
      isWinner: rec.is_winner ? 1 : 0,
      isStar: rec.is_star ? 1 : 0,
    });

    if (isNew) {
      added.push({
        domain: rec.domain,
        estDropDate,
        profitScore: rec.profit_score ?? null,
        isStar: !!rec.is_star
      });
    }
  }

  return added;
}

// Re-check monitored records that have reached their scheduled review window.
//
// The expensive downstream evaluation is deferred until the external
// availability check confirms the required state. Callers inject that
// work through opts.onPromote().
//
// Returns { promoted, checked, stillWatching }.
async function refreshWatchlist(store, rdap, opts = {}, now = new Date()) {
  const { onPromote = null, log = console.log } = opts;

  const today = now.toISOString().slice(0, 10);

  // [REDACTED] Original polling lead time and per-refresh limit.
  const due = await store.watchDueForCheck(
    today,
    C.WATCH_CHECK_LEAD_DAYS ?? 3,
    C.WATCH_CHECK_LIMIT ?? 200
  );

  const promoted = [];
  let stillWatching = 0;

  for (const w of due) {
    let available = null;

    try {
      const r = await rdap.check(w.domain);
      available = r.available;
    } catch {
      available = null;
    }

    const checkedAt = now.toISOString();

    await store.recordWatchCheck(w.domain, {
      checkedAt,
      available
    });

    if (available === true) {
      // Deferred evaluation occurs at the state transition.
      // A failure must not abort the remaining refresh sweep.
      // It is logged rather than silently swallowed.
      if (onPromote) {
        try {
          await onPromote(w.domain, w);
        } catch (e) {
          log(
            `    [-] Deferred evaluation failed for ${w.domain}: ` +
            `${e.message}`
          );
        }
      }

      promoted.push({
        domain: w.domain,
        profitScore: w.profit_score,
        becameAvailable: checkedAt
      });
    } else {
      stillWatching++;
    }
  }

  return {
    promoted,
    checked: due.length,
    stillWatching
  };
}

// ── State reconciliation ─────────────────────────────────────────────────

// Reconcile monitored records against an externally supplied membership map.
//
// Membership evidence is attached to the record. Reconciliation flags
// entries for review rather than automatically deleting persistent state.
// The user retains control over removal.

async function reconcileRenewals(store, present, log = () => {}) {
  if (!present || !present.size) return [];

  const watching = await store.getWatch('watching', 5000);
  const available = await store.getWatch('available', 5000);

  const flagged = [];

  for (const w of [...watching, ...available]) {
    if (present.has(w.domain)) {
      const proof = present.get(w.domain) || {};

      const isNew = await store.flagRenewal(w.domain, proof);

      if (isNew) {
        flagged.push(w.domain);

        log(
          `    [reconcile] ${w.domain} matched current membership ` +
          `(${proof.zoneDate || 'current'}) — flagged for confirmation. ` +
          `Evidence: "${(proof.matchedLine || '').trim().slice(0, 80)}"`
        );
      }
    }
  }

  return flagged;
}

module.exports = {
  estimateDropDate,
  enqueueExpirations,
  refreshWatchlist,
  reconcileRenewals
};
