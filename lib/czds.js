'use strict';

/**
 * External zone-data integration.
 *
 * Retrieves approved registry datasets, maintains dated local caches,
 * identifies records removed between snapshots, and checks current
 * membership against cached datasets.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { fetchWithRetry } = require('./fetch');
const { BASE } = require('./config');

const CACHE_DIR = path.join(BASE, '.cache', 'registry');

// [REDACTED] External service endpoint definitions and authentication
// configuration.

// Cache retention is intentionally longer than the immediately required
// snapshots. The cutoff uses timestamps while cached dates represent
// midnight UTC, so a shorter retention period can remove a required
// previous snapshot before the next comparison cycle.
const KEEP_DAYS = 3;

// ── Helpers ───────────────────────────────────────────────────────────────

// The source dataset is published on a schedule. Before its publication
// hour, the latest available snapshot represents the previous calendar day.
const ZONE_PUBLISH_HOUR_UTC = 19;

function zoneDate() {
  const now = new Date();

  if (now.getUTCHours() < ZONE_PUBLISH_HOUR_UTC) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  }

  return now.toISOString().slice(0, 10);
}

function prevZoneDate() {
  const now = new Date();
  const d = new Date(now);

  d.setUTCDate(
    d.getUTCDate() -
    (now.getUTCHours() < ZONE_PUBLISH_HOUR_UTC ? 2 : 1)
  );

  return d.toISOString().slice(0, 10);
}

function cachePath(tld, date) {
  return path.join(CACHE_DIR, `${tld}_${date}.txt`);
}

function ensureCache() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

// ── External API request helper ──────────────────────────────────────────

async function apiCall(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    opts.timeout || 20000
  );

  try {
    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(opts.headers || {})
      },
      body: opts.body,
      signal: controller.signal
    });

    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

// [REDACTED] External service authentication, token handling,
// response validation, and authorized dataset discovery.

// ── Dataset download and processing ──────────────────────────────────────

async function downloadZone(url, token, tld, outPath, log) {
  ensureCache();

  const script = path.join(__dirname, 'czds_download.py');

  // Delegate large dataset processing to Python to avoid loading
  // the complete source dataset into Node.js memory.
  await new Promise((resolve, reject) => {
    const py = require('child_process').spawn(
      'python3',
      [script, token, url, tld, outPath],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );

    py.stdout.on('data', d =>
      d.toString().split('\n').filter(Boolean).forEach(l => log(l))
    );

    py.stderr.on('data', d =>
      d.toString().split('\n').filter(Boolean)
        .forEach(l => log(`[processing err] ${l}`))
    );

    py.on('close', code =>
      code === 0
        ? resolve()
        : reject(new Error(`dataset processor exited ${code}`))
    );
  });

  // The original implementation deliberately avoids a second full-file
  // counting pass because the caller does not consume that result.
}

// ── Prune old cache files ────────────────────────────────────────────────

function pruneCache(tld) {
  if (!fs.existsSync(CACHE_DIR)) return;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - KEEP_DAYS);

  for (const f of fs.readdirSync(CACHE_DIR)) {
    if (!f.startsWith(`${tld}_`) || !f.endsWith('.txt')) continue;

    // Handles both ordinary snapshot files and dated diff files.
    // Extracting the trailing date prevents diff files from escaping
    // cleanup due to an optional filename infix.
    const m = /_(\d{4}-\d{2}-\d{2})\.txt$/.exec(f);

    if (!m) continue;

    if (new Date(m[1]) < cutoff) {
      fs.unlinkSync(path.join(CACHE_DIR, f));
    }
  }
}

// ── Main entry point ─────────────────────────────────────────────────────

/**
 * Fetch records removed between consecutive snapshots.
 *
 * Returns the records together with the date represented by the
 * comparison, rather than the wall-clock time of later processing.
 *
 * @param {string} username
 * @param {string} password
 * @param {string[]} tlds
 * @param {Function} log
 * @returns {Promise<{drops: string[], zoneDate: string}>}
 */
async function fetchDrops(username, password, tlds, log = () => {}) {
  ensureCache();

  const todayStr = zoneDate();
  const yesterdayStr = prevZoneDate();

  // [REDACTED] External service authentication and authorized
  // snapshot discovery.

  const drops = [];

  // [REDACTED] Original approved-dataset selection and lookup.

  for (const tld of tlds) {
    // [REDACTED] Original validation that the requested dataset
    // is available to the configured account.

    const todayFile = cachePath(tld, todayStr);
    const yesterdayFile = cachePath(tld, yesterdayStr);

    // Download today's snapshot only when it is not already cached.
    if (!fs.existsSync(todayFile)) {
      let downloaded = false;

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          if (attempt > 1) {
            log(`[DATA] retry ${attempt}/3...`);
          }

          // [REDACTED] Original authenticated download invocation
          // and service-specific request parameters.
          await downloadZone(link.url, token, tld, todayFile, log);

          downloaded = true;
          break;
        } catch (e) {
          log(`[DATA] attempt ${attempt} failed: ${e.message}`);

          if (attempt < 3) {
            await new Promise(r => setTimeout(r, 5000 * attempt));
          }
        }
      }

      if (!downloaded) {
        continue;
      }
    } else {
      log(`[DATA] using cached snapshot for ${todayStr}`);
    }

    // A first snapshot establishes the baseline. A comparison is only
    // possible once the preceding snapshot is available.
    if (!fs.existsSync(yesterdayFile)) {
      log(
        `[DATA] no previous snapshot (${yesterdayStr}); ` +
        `using current snapshot as baseline`
      );

      pruneCache(tld);
      continue;
    }

    const diffOut = path.join(
      CACHE_DIR,
      `${tld}_diff_${todayStr}.txt`
    );

    const diffScript = path.join(__dirname, 'czds_diff.py');

    // A comparison between two fixed snapshots is immutable.
    // Reuse an existing result rather than repeating expensive work.
    if (fs.existsSync(diffOut)) {
      log(`[DATA] using cached diff for ${todayStr}`);
    } else {
      log('[DATA] comparing snapshots...');

      await new Promise((resolve, reject) => {
        const py = require('child_process').spawn(
          'python3',
          [diffScript, yesterdayFile, todayFile, diffOut],
          { stdio: ['ignore', 'pipe', 'pipe'] }
        );

        py.stdout.on('data', d =>
          d.toString().split('\n').filter(Boolean).forEach(l => log(l))
        );

        py.stderr.on('data', d =>
          d.toString().split('\n').filter(Boolean)
            .forEach(l => log(`[DIFF err] ${l}`))
        );

        py.on('close', code =>
          code === 0
            ? resolve()
            : reject(new Error(`diff processor exited ${code}`))
        );
      });
    }

    // Stream the diff output into the result collection.
    // The generated file remains on disk for post-run analysis.
    const diffRl = readline.createInterface({
      input: fs.createReadStream(diffOut),
      crlfDelay: Infinity
    });

    let count = 0;

    for await (const line of diffRl) {
      const d = line.trim();

      if (d) {
        drops.push(d);
        count++;
      }
    }

    log(
      `[DATA] ${count.toLocaleString()} removed records; ` +
      `diff saved to ${path.basename(diffOut)}`
    );

    pruneCache(tld);
  }

  return { drops, zoneDate: todayStr };
}

// ── Snapshot membership ──────────────────────────────────────────────────

// Checks a small set of watched records against a large sorted snapshot.
// Returns evidence for each match rather than only a boolean result.

async function zoneMembership(domains, log = () => {}) {
  const byTld = {};

  for (const d of domains) {
    const tld = String(d).split('.').pop().toLowerCase();
    (byTld[tld] ||= new Set()).add(d);
  }

  const present = new Map();

  for (const [tld, want] of Object.entries(byTld)) {
    const zf = cachePath(tld, zoneDate());

    if (!fs.existsSync(zf)) {
      log(
        `[reconcile] no snapshot for dataset (${zoneDate()}) - ` +
        `skipping membership check`
      );
      continue;
    }

    let remaining = want.size;

    const rl = readline.createInterface({
      input: fs.createReadStream(zf),
      crlfDelay: Infinity
    });

    for await (const line of rl) {
      const d = line.trim();

      if (d && want.has(d)) {
        present.set(d, {
          zoneDate: zoneDate(),
          zoneFile: zf,
          matchedLine: line
        });

        if (--remaining === 0) break;
      }
    }

    rl.close();
  }

  return present;
}

module.exports = {
  fetchDrops,
  zoneMembership,
  zoneDate,
  zoneCachePath: (tld) => cachePath(tld, zoneDate())
};
