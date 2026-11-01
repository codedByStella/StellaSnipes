'use strict';

const { C } = require('./config');
const { getRegistry } = require('./registry');

// ── Drop Schedule Advisor ─────────────────────────────────────────────────────

class DropScheduleAdvisor {
  // Registry drop times use US Eastern wall-clock time.
  // Convert to UTC using the offset applicable on the supplied date.
  constructor(now = new Date()) {
    const reg = getRegistry();
    this._schedule = {};
    const offH = DropScheduleAdvisor._easternToUtcHours(now);

    for (const token of reg.getSet('drop_schedules')) {
      if (!token.includes(':')) continue;

      const [tld, tp] = token.split(':');
      const segs = tp.replace('est', '').split('-').filter(Boolean);
      if (segs.length < 2) continue;

      try {
        const sh = parseInt(segs[0].slice(0, 2));
        const sm = parseInt(segs[0].slice(2) || '0');
        const eh = parseInt(segs[1].slice(0, 2));
        const em = parseInt(segs[1].slice(2) || '0');

        this._schedule[tld.trim()] = [
          ((sh + offH) % 24) * 60 + sm,
          ((eh + offH) % 24) * 60 + em
        ];
      } catch {}
    }
  }

  static _easternToUtcHours(date) {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    const p = {};
    for (const part of dtf.formatToParts(date)) p[part.type] = part.value;

    const hour = p.hour === '24' ? 0 : +p.hour;
    const nyAsUtc = Date.UTC(
      +p.year,
      +p.month - 1,
      +p.day,
      hour,
      +p.minute,
      +p.second
    );

    return Math.round((date.getTime() - nyAsUtc) / 3600000);
  }

  _nowMins() {
    const n = new Date();
    return n.getUTCHours() * 60 + n.getUTCMinutes();
  }

  getStatus(tld) {
    const win = this._schedule[tld.toLowerCase()];
    if (!win) return { active: false, minsAway: -1 };

    const [start, end] = win;
    const nm = this._nowMins();

    if (start <= nm && nm <= end) {
      return { active: true, minsAway: 0 };
    }

    const away = nm < start ? start - nm : 1440 - nm + start;

    return {
      active: away <= C.DROP_ALERT_WINDOW_MIN,
      minsAway: away
    };
  }

  activeTlds() {
    const nm = this._nowMins();

    return Object.entries(this._schedule)
      .filter(([, [s, e]]) => s <= nm && nm <= e)
      .map(([tld]) => tld);
  }

  nextWindow() {
    const nm = this._nowMins();
    let best = null;
    let bestAway = Infinity;

    for (const [tld, [start]] of Object.entries(this._schedule)) {
      const away = nm < start ? start - nm : 1440 - nm + start;

      if (away < bestAway) {
        bestAway = away;
        best = tld;
      }
    }

    return {
      tld: best,
      minsAway: bestAway === Infinity ? -1 : bestAway
    };
  }

  allWindows() {
    const nm = this._nowMins();

    return Object.entries(this._schedule).map(([tld, [start, end]]) => {
      const active = start <= nm && nm <= end;
      const away = active
        ? 0
        : (nm < start ? start - nm : 1440 - nm + start);

      const toTime = m =>
        `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')} UTC`;

      return {
        tld,
        start: toTime(start),
        end: toTime(end),
        active,
        minsAway: away
      };
    }).sort((a, b) => a.minsAway - b.minsAway);
  }
}

// ── Cascade scoring ───────────────────────────────────────────────────────────

// [REDACTED] Proprietary signal ordering, decay weights, and score aggregation.

function cascade(hits) {
  // [REDACTED] Original cascade calculation.
}

// ── Tri-Sieve Engine ──────────────────────────────────────────────────────────

class TriSieveEngine {
  constructor() {
    this._reg = getRegistry();
  }

  _hits(name, text) {
    return this._reg.findAll(name, text);
  }

  // [REDACTED] Original service-token aggregation and matching context.

  _serviceTokens() {
    // [REDACTED] Proprietary token aggregation.
  }

  // [REDACTED] Original geographic token boundary and adjacency rules.

  _geoHits(name, core) {
    // [REDACTED] Proprietary geographic hit qualification.
  }

  microGeoHits(core) {
    return this._geoHits('micro_geo', core);
  }

  // [REDACTED] Original context-token aggregation and matching rules.

  _contextTokens() {
    // [REDACTED] Proprietary context-token aggregation.
  }

  // [REDACTED] Original service-token boundary and adjacency rules.

  _svcHits(name, core) {
    // [REDACTED] Proprietary service-token hit qualification.
  }

  evaluateLeadgen(domain) {
    // [REDACTED] Original lead-generation evaluation.
    // Included geographic, industry, buyer-intent, and linguistic
    // classification; category weighting; exclusions; penalties;
    // signal interactions; length scoring; confidence calculation;
    // and commercial-value multipliers.
  }
}

// ── Score single domain ───────────────────────────────────────────────────────

// [REDACTED] Original domain scoring and ranking calculation.
// Combined lead-generation evaluation, lifecycle timing, name quality,
// TLD weighting, geographic precision, and commercial-value adjustments.

function scoreDomain(domain, engine, advisor, mode = 'DEBLOAT') {
  // [REDACTED] Original scoring implementation.
}

// ── Name Quality Assessment ───────────────────────────────────────────────────

// [REDACTED] Original name-quality heuristics.
// Included character composition, digit and vowel analysis,
// consonant patterns, formatting penalties, and lexical rewards.

function assessNameQuality(core) {
  // [REDACTED] Original name-quality calculation.
}

// ── Near-duplicate deduplication ──────────────────────────────────────────────

function editDistance(a, b) {
  if (a.length < b.length) [a, b] = [b, a];

  let row = [...Array(b.length + 1).keys()];

  for (let i = 1; i <= a.length; i++) {
    const newRow = [i];

    for (let j = 1; j <= b.length; j++) {
      newRow.push(Math.min(
        row[j] + 1,
        newRow[j - 1] + 1,
        row[j - 1] + (a[i - 1] !== b[j - 1] ? 1 : 0)
      ));
    }

    row = newRow;
  }

  return row[b.length];
}

function sharedPrefix(a, b) {
  let i = 0;

  while (i < a.length && i < b.length && a[i] === b[i]) {
    i++;
  }

  return i;
}

// [REDACTED] Original duplicate-clustering decision rules.
// Included similarity thresholds and optional geographic separation
// checks used to avoid collapsing distinct market opportunities.

function isSameCluster(core, accepted, geoHitsOf) {
  // [REDACTED] Original duplicate-clustering implementation.
}

// Preserve the original interface and result structure.
function dedupeNearDuplicates(records, limit, geoHitsOf) {
  // [REDACTED] Original ordered deduplication and result selection.
}

module.exports = {
  DropScheduleAdvisor,
  TriSieveEngine,
  scoreDomain,
  dedupeNearDuplicates
};
