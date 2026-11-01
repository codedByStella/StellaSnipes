'use strict';

const fs = require('fs');
const path = require('path');

const BASE         = path.join(__dirname, '..');
const REGISTRY_DIR = path.join(BASE, 'registries');
const OUTPUT_DIR   = path.join(BASE, 'outputs', 'runs');
const DB_PATH      = path.join(BASE, 'sniper_history.db');
const ENV_PATH     = path.join(BASE, '.env');

// ── Environment loader ────────────────────────────────────────────────────

const env = {};

try {
  fs.readFileSync(ENV_PATH, 'utf8').split('\n').forEach(line => {
    line = line.trim();

    if (line && line.includes('=') && !line.startsWith('#')) {
      const [k, ...rest] = line.split('=');

      // Strip a trailing inline comment, but only when `#` follows
      // whitespace, so a `#` inside a value is preserved.
      env[k.trim()] = rest.join('=').replace(/\s+#.*$/, '').trim();
    }
  });
} catch {}

function saveEnv(updates) {
  let text = '';

  try {
    text = fs.readFileSync(ENV_PATH, 'utf8');
  } catch {}

  const lines = text.split('\n');
  const written = new Set();

  const out = lines.map(line => {
    const trim = line.trim();

    if (!trim || trim.startsWith('#') || !trim.includes('=')) {
      return line;
    }

    const k = trim.split('=')[0].trim();

    if (updates[k] !== undefined) {
      written.add(k);
      return `${k}=${updates[k]}`;
    }

    return line;
  });

  Object.entries(updates).forEach(([k, v]) => {
    if (!written.has(k)) {
      out.push(`${k}=${v}`);
    }
  });

  fs.writeFileSync(ENV_PATH, out.join('\n'), 'utf8');
  Object.assign(env, updates);
}

// ── Application configuration ────────────────────────────────────────────

// [REDACTED] Original scoring configuration.
// Included lead-generation weights, geographic and industry bonuses,
// penalties, eligibility rules, and classification multipliers.

// [REDACTED] Original domain-health evaluation model.
// Included availability, historical data, domain age, blacklist,
// authority, and verification scoring rules.

// [REDACTED] Original commercial valuation model.
// Included search-volume assumptions, traffic capture estimates,
// conversion rates, lead values, market adjustments, and TLD pricing.

// [REDACTED] Original external-service execution configuration.
// Included individual service concurrency, request spacing, retry
// policies, timeout budgets, and batch scheduling.

// [REDACTED] Original cache and verification policies.
// Included schema versions, per-check expiration periods,
// successful-result caching, and rate-limit exhaustion handling.

// [REDACTED] Original domain lifecycle and monitoring configuration.
// Included retention periods, redemption timing, polling schedules,
// monitoring limits, and watchlist selection criteria.

// [REDACTED] Original production configuration object retained here.
// Exact properties and values omitted because they expose the
// application's proprietary evaluation and acquisition strategy.
const C = {};

// ── Registry definitions ──────────────────────────────────────────────────

// [REDACTED] Original registry mapping.
// Included exclusion datasets, classification sources, geographic
// datasets, commercial categories, and domain filtering inputs.
const REGISTRY_FILES = {};

module.exports = {
  env,
  saveEnv,
  C,
  REGISTRY_FILES,
  BASE,
  OUTPUT_DIR,
  DB_PATH
};
