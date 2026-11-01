'use strict';

const dns = require('dns').promises;
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { C, env, BASE } = require('./config');
const { fetchWithRetry, fetchText, fetchJson, sleep } = require('./fetch');
const { getRegistry } = require('./registry');
const { createLimiter, retryAsync } = require('./limiter');

// ── Service limiters ───────────────────────────────────────────────────

const wbLimiter = createLimiter({
  concurrency: C.WAYBACK_CONCURRENCY,
  minGapMs: C.WAYBACK_MIN_GAP_MS
});

const whoisLimiter = createLimiter({
  concurrency: C.WHOIS_CONCURRENCY,
  minGapMs: C.WHOIS_MIN_GAP_MS
});

const rdapLimiter = createLimiter({
  concurrency: C.RDAP_CONCURRENCY,
  minGapMs: C.RDAP_MIN_GAP_MS
});

const majesticLimiter = createLimiter({
  concurrency: C.MAJESTIC_CONCURRENCY,
  minGapMs: C.MAJESTIC_MIN_GAP_MS
});

const sbLimiter = createLimiter({
  concurrency: C.SAFEBROWSING_CONCURRENCY,
  minGapMs: C.SAFEBROWSING_MIN_GAP_MS
});

// ── Timeout helper ─────────────────────────────────────────────────────

function raceTimeout(p, ms, onTimeout) {
  let t;

  const timer = new Promise(res => {
    t = setTimeout(() => res(onTimeout), ms);
  });

  const wrapped = Promise.resolve(p).then(
    v => {
      clearTimeout(t);
      return v;
    },
    () => {
      clearTimeout(t);
      return onTimeout;
    }
  );

  return Promise.race([wrapped, timer]);
}

// ── Wayback fact cache ─────────────────────────────────────────────────

const CACHE_ROOT =
  process.env.STELLA_CACHE_DIR || path.join(BASE, '.cache');

const WB_CACHE_DIR = path.join(CACHE_ROOT, 'wayback');

function _wbCachePath(domain) {
  return path.join(
    WB_CACHE_DIR,
    domain.replace(/[^a-z0-9.\-]/gi, '_') + '.json'
  );
}

function readWaybackCache(domain) {
  try {
    const raw = JSON.parse(
      fs.readFileSync(_wbCachePath(domain), 'utf8')
    );

    if (raw.version !== C.CACHE_SCHEMA_VERSION) return null;

    const ageDays = (Date.now() - raw.cached_at) / 86400000;

    if (ageDays <= C.WAYBACK_CACHE_TTL_DAYS) {
      return raw.facts;
    }
  } catch {}

  return null;
}

function writeWaybackCache(domain, facts) {
  try {
    fs.mkdirSync(WB_CACHE_DIR, { recursive: true });

    const target = _wbCachePath(domain);
    const tmp = target + '.tmp';

    fs.writeFileSync(
      tmp,
      JSON.stringify({
        version: C.CACHE_SCHEMA_VERSION,
        cached_at: Date.now(),
        facts
      }),
      'utf8'
    );

    fs.renameSync(tmp, target);
  } catch {}
}

// ── Per-check verified-fact cache ──────────────────────────────────────

function _checkCachePath(check, domain) {
  return path.join(
    CACHE_ROOT,
    'checks',
    check,
    domain.replace(/[^a-z0-9.\-]/gi, '_') + '.json'
  );
}

function readCheckCache(check, domain, ttlMs) {
  try {
    const raw = JSON.parse(
      fs.readFileSync(_checkCachePath(check, domain), 'utf8')
    );

    if (raw.version !== C.CACHE_SCHEMA_VERSION) return null;

    if (Date.now() - raw.cached_at <= ttlMs) {
      return raw.result;
    }
  } catch {}

  return null;
}

function writeCheckCache(check, domain, result) {
  try {
    const fp = _checkCachePath(check, domain);

    fs.mkdirSync(path.dirname(fp), { recursive: true });

    const tmp = fp + '.tmp';

    fs.writeFileSync(
      tmp,
      JSON.stringify({
        version: C.CACHE_SCHEMA_VERSION,
        cached_at: Date.now(),
        result
      }),
      'utf8'
    );

    fs.renameSync(tmp, fp);
  } catch {}
}

// ── Rate-limit exhaustion tracking ─────────────────────────────────────

function _rlSidecarPath(check, domain) {
  return path.join(
    CACHE_ROOT,
    'checks',
    check,
    domain.replace(/[^a-z0-9.\-]/gi, '_') + '.ratelimit.json'
  );
}

function clearRateLimitStreak(check, domain) {
  try {
    fs.unlinkSync(_rlSidecarPath(check, domain));
  } catch {}
}

function noteRateLimitedAndCheckExhausted(check, domain) {
  const fp = _rlSidecarPath(check, domain);

  let state = null;

  try {
    state = JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {}

  const now = Date.now();

  if (
    !state ||
    typeof state.first !== 'number' ||
    typeof state.count !== 'number'
  ) {
    state = { first: now, count: 0 };
  }

  state.count += 1;
  state.last = now;

  // [REDACTED] Exact rate-limit exhaustion count and time-window defaults.
  const exhaustCount = C.RATE_LIMIT_EXHAUST_COUNT;
  const exhaustWindow = C.RATE_LIMIT_EXHAUST_WINDOW_MS;

  const exhausted =
    state.count >= exhaustCount ||
    (now - state.first) >= exhaustWindow;

  try {
    if (exhausted) {
      fs.unlinkSync(fp);
    } else {
      fs.mkdirSync(path.dirname(fp), { recursive: true });

      const tmp = fp + '.tmp';

      fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
      fs.renameSync(tmp, fp);
    }
  } catch {}

  return exhausted;
}

async function cachedCheck(check, domain, producer) {
  const ttlMs =
    (C.HEALTH_CHECK_CACHE_TTL_MS || {})[check] || 0;

  if (ttlMs > 0) {
    const hit = readCheckCache(check, domain, ttlMs);

    if (hit) return { ...hit, cached: true };
  }

  let result = await producer();

  if (result && result.status === 'ok') {
    if (ttlMs > 0) {
      writeCheckCache(check, domain, result);
    }

    clearRateLimitStreak(check, domain);

  } else if (result && result.status === 'rate_limited') {
    if (noteRateLimitedAndCheckExhausted(check, domain)) {
      result = {
        ...result,
        status: 'failed',
        signals: (result.signals || []).map(([impact, note]) => [
          impact,
          '[REDACTED] Original rate-limit exhaustion explanation.'
        ])
      };
    }
  }

  return result;
}

// ── Content screening ──────────────────────────────────────────────────

// [REDACTED] Original content classification patterns and
// proprietary exclusion vocabulary.

function screenContent(text) {
  const flags = new Set();
  const toxic = getRegistry().getSet('toxic_waste');

  for (const t of toxic) {
    if (
      t.length >= 4 &&
      !t.includes('-') &&
      text.toLowerCase().includes(t)
    ) {
      flags.add(t);
    }
  }

  // [REDACTED] Original additional content-pattern matching rules.

  return [...flags];
}

// ── Wayback inspector ──────────────────────────────────────────────────

// [REDACTED] Original optional archive-service credential configuration.

function _archiveAuthHeaders() {
  // [REDACTED] Original credential-backed request headers.
  return {};
}

// Cheap: retrieve historical snapshot facts.
async function fetchWaybackHistoryFacts(domain) {
  const facts = {
    snapshot_count: 0,
    first_seen: null,
    last_seen: null,
    age_years: 0,
    history_status: 'ok',
    timestamps: []
  };

  const url =
    `http://web.archive.org/cdx/search/cdx?url=${domain}` +
    '&output=json&fl=timestamp&limit=500&collapse=digest';

  const rl = {};

  try {
    const res = await wbLimiter(() =>
      fetchWithRetry(url, {
        timeout: 12000,
        retries: C.WAYBACK_RETRIES,
        rateLimitTracker: rl,
        headers: _archiveAuthHeaders()
      })
    );

    if (!res || !res.ok) {
      facts.history_status = rl.hit ? 'rate_limited' : 'failed';
      return facts;
    }

    const text = await res.text();

    let data = null;

    if (text && text.trim()) {
      try {
        data = JSON.parse(text);
      } catch {
        facts.history_status = 'failed';
        return facts;
      }
    }

    // An empty capture response is a valid negative result.
    if (data && data.length > 1) {
      const ts = data
        .slice(1)
        .map(x => x[0])
        .filter(Boolean)
        .sort();

      facts.snapshot_count = ts.length;
      facts.timestamps = ts.slice(0, 500);

      if (ts.length) {
        const fd = new Date(
          `${ts[0].slice(0, 4)}-${ts[0].slice(4, 6)}-${ts[0].slice(6, 8)}`
        );

        const ld = new Date(
          `${ts.at(-1).slice(0, 4)}-${ts.at(-1).slice(4, 6)}-${ts.at(-1).slice(6, 8)}`
        );

        if (!isNaN(fd.getTime())) {
          facts.first_seen = fd.toISOString().slice(0, 10);

          facts.age_years = +(
            (Date.now() - fd.getTime()) /
            (365.25 * 86400000)
          ).toFixed(1);
        }

        if (!isNaN(ld.getTime())) {
          facts.last_seen = ld.toISOString().slice(0, 10);
        }
      }
    }

  } catch {
    facts.history_status = rl.hit ? 'rate_limited' : 'failed';
  }

  return facts;
}

// Expensive: retrieve and screen an archived page.
async function fetchWaybackContentFacts(domain) {
  const rl = {};

  try {
    const avail = await wbLimiter(() =>
      fetchJson(
        `https://archive.org/wayback/available?url=${domain}`,
        {
          timeout: 8000,
          retries: C.WAYBACK_RETRIES,
          rateLimitTracker: rl
        }
      )
    );

    const snapUrl = avail?.archived_snapshots?.closest?.url;

    if (!snapUrl) {
      return {
        content_flagged: false,
        content_flags: [],
        content_screen_status: rl.hit ? 'rate_limited' : 'no_snapshot'
      };
    }

    await sleep(C.WAYBACK_DELAY);

    const html = await wbLimiter(() =>
      fetchText(snapUrl, {
        timeout: 10000,
        retries: C.WAYBACK_RETRIES,
        rateLimitTracker: rl
      })
    );

    if (!html) {
      return {
        content_flagged: false,
        content_flags: [],
        content_screen_status: rl.hit ? 'rate_limited' : 'no_snapshot'
      };
    }

    const text = html.replace(/<[^>]+>/g, ' ').slice(0, 10000);
    const flags = screenContent(text);

    return flags.length
      ? {
          content_flagged: true,
          content_flags: flags.slice(0, 10),
          content_screen_status: 'screened',
          snapshot_url: snapUrl
        }
      : {
          content_flagged: false,
          content_flags: [],
          content_screen_status: 'screened',
          snapshot_url: snapUrl
        };

  } catch {
    return {
      content_flagged: false,
      content_flags: [],
      content_screen_status: rl.hit ? 'rate_limited' : 'failed'
    };
  }
}

// Derive signals from cached facts.
function computeWaybackSignals(facts) {
  const signals = [];

  const sc = facts.snapshot_count || 0;
  const age = facts.age_years || 0;

  // [REDACTED] Original proprietary snapshot-count and domain-age
  // scoring tiers, weights, and associated evaluation messages.

  if (facts.last_seen) {
    const y =
      (Date.now() - new Date(facts.last_seen).getTime()) /
      (365.25 * 86400000);

    // [REDACTED] Original abandonment threshold and scoring rule.
  }

  if (sc > 0) {
    if (facts.content_screen_status === 'screened') {
      if (facts.content_flagged) {
        signals.push([
          C.HEALTH_HARD_FAIL_SCORE,
          `Historical content contained flagged terms: ${(facts.content_flags || []).slice(0, 5).join(', ')}`
        ]);
      } else {
        signals.push([
          C.HEALTH_BONUS_CLEAN_CONTENT,
          'Past version of the site passed content screening'
        ]);
      }
    } else {
      signals.push([
        0,
        "Couldn't check the site's past content"
      ]);
    }
  }

  return signals;
}

async function inspectWayback(domain) {
  let facts = readWaybackCache(domain);

  if (!facts) {
    const history = await raceTimeout(
      fetchWaybackHistoryFacts(domain),
      C.WAYBACK_HISTORY_TIMEOUT_MS,
      {
        snapshot_count: 0,
        first_seen: null,
        last_seen: null,
        age_years: 0,
        history_status: 'rate_limited'
      }
    );

    const content = history.snapshot_count > 0
      ? await raceTimeout(
          fetchWaybackContentFacts(domain),
          C.WAYBACK_CONTENT_TIMEOUT_MS,
          {
            content_flagged: false,
            content_flags: [],
            content_screen_status: 'unscreened'
          }
        )
      : {
          content_flagged: false,
          content_flags: [],
          content_screen_status: 'no_history'
        };

    facts = { ...history, ...content };

    if (facts.history_status === 'ok') {
      writeWaybackCache(domain, facts);
    }
  }

  // [REDACTED] Original Wayback scoring-weight calculation.
  const wbWeight = 0;

  const evidence = {
    snapshot_count: facts.snapshot_count,
    first_seen: facts.first_seen,
    last_seen: facts.last_seen,
    timestamps: facts.timestamps || [],
    closest_snapshot_url: facts.snapshot_url || null,
    content_terms: facts.content_flags || [],
    content_screen_status: facts.content_screen_status
  };

  const wbStatus =
    facts.history_status === 'ok'
      ? 'ok'
      : facts.history_status === 'rate_limited'
        ? 'rate_limited'
        : 'failed';

  if (wbStatus === 'ok') {
    clearRateLimitStreak('wayback', domain);

  } else if (wbStatus === 'rate_limited') {
    if (noteRateLimitedAndCheckExhausted('wayback', domain)) {
      return {
        ...facts,
        status: 'failed',
        weight: wbWeight,
        evidence,
        signals: computeWaybackSignals(facts).map(([impact, note]) => [
          impact,
          '[REDACTED] Original rate-limit exhaustion explanation.'
        ])
      };
    }
  }

  return {
    ...facts,
    status: wbStatus,
    weight: wbWeight,
    evidence,
    signals: computeWaybackSignals(facts)
  };
}

// ── DNS probe ──────────────────────────────────────────────────────────

async function probeDns(domain) {
  try {
    await dns.lookup(domain);

    return {
      resolves: true,
      status: 'ok',
      weight: C.HEALTH_BONUS_DROPPED,
      evidence: { resolves: true },
      signals: [[
        C.HEALTH_PENALTY_STILL_LIVE,
        "This domain's website is still responding"
      ]]
    };

  } catch {
    let stillRegistered = false;

    try {
      const ns = await dns.resolveNs(domain);
      stillRegistered = Array.isArray(ns) && ns.length > 0;
    } catch {}

    if (!stillRegistered) {
      try {
        const soa = await dns.resolveSoa(domain);
        stillRegistered = !!soa;
      } catch {}
    }

    if (stillRegistered) {
      return {
        resolves: true,
        status: 'ok',
        weight: C.HEALTH_BONUS_DROPPED,
        evidence: {
          resolves: true,
          website_down: true
        },
        signals: [[
          C.HEALTH_PENALTY_STILL_LIVE,
          "The website isn't responding, but NS/SOA records show the domain is still registered"
        ]]
      };
    }

    return {
      resolves: false,
      status: 'ok',
      weight: C.HEALTH_BONUS_DROPPED,
      evidence: { resolves: false },
      signals: [[
        C.HEALTH_BONUS_DROPPED,
        'DNS records indicate the domain is no longer resolving'
      ]]
    };
  }
}

// ── DNS blacklist checker ───────────────────────────────────────────────

const _dnsblListed = (ip, thirdOctet, lo, hi) => {
  const m = /^127\.0\.(\d+)\.(\d+)$/.exec(ip);

  return !!m &&
    +m[1] === thirdOctet &&
    +m[2] >= lo &&
    +m[2] <= hi;
};

const DNSBL = {
  SURBL: {
    host: '{d}.multi.surbl.org',
    bonus: C.HEALTH_BONUS_CLEAN_SURBL,
    isListed: ip => _dnsblListed(ip, 0, 2, 255)
  },

  URIBL: {
    host: '{d}.multi.uribl.com',
    bonus: C.HEALTH_BONUS_CLEAN_URIBL,
    isListed: ip => _dnsblListed(ip, 0, 2, 255)
  },

  SpamhausDBL: {
    host: '{d}.dbl.spamhaus.org',
    bonus: C.HEALTH_BONUS_CLEAN_DBL,
    isListed: ip => _dnsblListed(ip, 1, 2, 99)
  }
};

async function checkBlacklists(domain) {
  const core = domain.split('.').slice(-2).join('.');

  const listed = [];
  const signals = [];
  const lists = [];

  await Promise.all(
    Object.entries(DNSBL).map(async ([name, { host, bonus, isListed }]) => {
      const q = host.replace('{d}', core);

      let addrs;

      try {
        addrs = await dns.resolve4(q);

      } catch (e) {
        // NXDOMAIN / NODATA is the expected negative response for an
        // unlisted domain. Timeouts and resolver failures are not clean.
        if (e.code === 'ENOTFOUND' || e.code === 'ENODATA') {
          signals.push([
            bonus,
            `Not on the ${name} spam blocklist`
          ]);

          lists.push({
            name,
            host: q,
            answer: null,
            state: 'clean'
          });
        } else {
          signals.push([
            0,
            `Couldn't verify ${name} spam blocklist status`
          ]);

          lists.push({
            name,
            host: q,
            answer: null,
            state: 'failed',
            error: e.code || 'resolver_error'
          });
        }

        return;
      }

      if (addrs.some(isListed)) {
        listed.push(name);

        signals.push([
          C.HEALTH_HARD_FAIL_SCORE,
          `Listed on the ${name} spam blocklist`
        ]);

        lists.push({
          name,
          host: q,
          answer: addrs,
          state: 'listed'
        });

      } else {
        signals.push([
          0,
          `Couldn't confirm ${name} blocklist status`
        ]);

        lists.push({
          name,
          host: q,
          answer: addrs,
          state: 'unverified'
        });
      }
    })
  );

  const hasListing = listed.length > 0;
  const hasFailure = lists.some(item => item.state === 'failed');

  return {
    listed_on: listed,
    status: hasListing || !hasFailure ? 'ok' : 'failed',
    weight: lists.reduce((sum, item) => {
      if (item.state !== 'clean') return sum;
      const config = DNSBL[item.name];
      return sum + (config?.bonus || 0);
    }, 0),
    evidence: { lists },
    signals
  };
}

// ── WHOIS checker ──────────────────────────────────────────────────────

async function checkWhois(domain) {
  try {
    const whoiser = require('whoiser');

    const result = await whoisLimiter(() =>
      retryAsync(
        () => whoiser.domain(domain, {
          timeout: 12000,
          raw: false
        }),
        {
          attempts: C.WHOIS_RETRIES,
          baseMs: C.WHOIS_BASE_RETRY_MS
        }
      )
    );

    const entry = Object.values(result)[0] || {};

    const raw =
      entry['Created Date'] ||
      entry['Creation Date'] ||
      entry['created'] ||
      '';

    if (!raw) {
      return {
        creation_date: null,
        age_years: null,
        status: 'ok',
        weight: C.HEALTH_BONUS_AGE_7,
        evidence: {
          created: null,
          raw: entry
        },
        signals: [[0, 'No registration date on file']]
      };
    }

    const cd = new Date(raw);

    if (isNaN(cd)) {
      return {
        creation_date: null,
        age_years: null,
        status: 'ok',
        weight: C.HEALTH_BONUS_AGE_7,
        evidence: {
          created: raw,
          raw: entry
        },
        signals: [[0, 'Registration date on file looks invalid']]
      };
    }

    const age = +(
      (Date.now() - cd.getTime()) /
      (365.25 * 86400000)
    ).toFixed(1);

    // [REDACTED] Original registration-age scoring tiers.

    return {
      creation_date: cd.toISOString().slice(0, 10),
      age_years: age,
      status: 'ok',
      weight: C.HEALTH_BONUS_AGE_7,
      evidence: {
        created: cd.toISOString().slice(0, 10),
        raw: entry
      },
      signals: []
    };

  } catch (e) {
    return {
      creation_date: null,
      age_years: null,
      status: 'failed',
      weight: C.HEALTH_BONUS_AGE_7,
      evidence: {
        created: null,
        error: String(e).slice(0, 120)
      },
      signals: [[
        0,
        "Couldn't pull the registration record right now"
      ]]
    };
  }
}

// ── RDAP verifier ──────────────────────────────────────────────────────

class RdapVerifier {
  constructor() {
    this._map = {};
  }

  async init() {
    try {
      const data = await fetchJson(
        'https://data.iana.org/rdap/dns.json',
        {
          headers: {
            Accept: 'application/rdap+json'
          },
          timeout: 10000,
          retries: 1
        }
      );

      if (data?.services) {
        for (const [tlds, servers] of data.services) {
          const server = servers[0].replace(/\/$/, '');

          for (const t of tlds) {
            this._map[t.toLowerCase()] = server;
          }
        }
      }

    } catch {}

    return this;
  }

  async check(domain) {
    const tld = domain.split('.').pop().toLowerCase();
    const server = this._map[tld];

    if (!server) {
      return {
        available: null,
        status: 'not_applicable',
        weight: 0,
        evidence: {
          tld,
          server: null,
          status_code: null,
          available: null
        },
        signals: [[
          0,
          `No official registry lookup available for .${tld} domains`
        ]]
      };
    }

    const rl = {};

    try {
      const res = await rdapLimiter(() =>
        fetchWithRetry(
          `${server}/domain/${domain}`,
          {
            headers: {
              Accept: 'application/rdap+json'
            },
            timeout: 10000,
            retries: 3,
            rateLimitTracker: rl
          }
        )
      );

      if (!res) {
        if (rl.hit) {
          return {
            available: null,
            status: 'rate_limited',
            weight: C.HEALTH_BONUS_CONFIRMED_AVAILABLE,
            evidence: {
              tld,
              server,
              status_code: null,
              available: null
            },
            signals: [[
              0,
              'Temporarily rate-limited by the registry'
            ]]
          };
        }

        return {
          available: null,
          status: 'failed',
          weight: C.HEALTH_BONUS_CONFIRMED_AVAILABLE,
          evidence: {
            tld,
            server,
            status_code: null,
            available: null
          },
          signals: [[
            0,
            "Couldn't reach the registry to confirm availability"
          ]]
        };
      }

      if (res.status === 404) {
        return {
          available: true,
          status: 'ok',
          weight: C.HEALTH_BONUS_CONFIRMED_AVAILABLE,
          evidence: {
            tld,
            server,
            status_code: 404,
            available: true
          },
          signals: [[
            C.HEALTH_BONUS_CONFIRMED_AVAILABLE,
            'Registry lookup confirms the domain is unregistered'
          ]]
        };
      }

      if (res.ok) {
        return {
          available: false,
          status: 'ok',
          weight: C.HEALTH_BONUS_CONFIRMED_AVAILABLE,
          evidence: {
            tld,
            server,
            status_code: res.status,
            available: false
          },
          signals: [[
            C.HEALTH_PENALTY_STILL_REGISTERED,
            'Domain is still registered'
          ]]
        };
      }

      return {
        available: null,
        status: 'failed',
        weight: C.HEALTH_BONUS_CONFIRMED_AVAILABLE,
        evidence: {
          tld,
          server,
          status_code: res.status,
          available: null
        },
        signals: [[
          0,
          'Registry lookup returned an unexpected response'
        ]]
      };

    } catch (e) {
      return {
        available: null,
        status: 'failed',
        weight: C.HEALTH_BONUS_CONFIRMED_AVAILABLE,
        evidence: {
          tld,
          server,
          status_code: null,
          available: null,
          error: String(e).slice(0, 120)
        },
        signals: [[
          0,
          "Couldn't reach the registry to confirm availability"
        ]]
      };
    }
  }
}

// ── Majestic ────────────────────────────────────────────────────────────

async function checkMajestic(domain) {
  const key = env.MAJESTIC_API_KEY;

  if (!key) {
    return {
      trust_flow: null,
      citation_flow: null,
      ref_domains: null,
      ext_backlinks: null,
      status: 'not_applicable',
      weight: 0,
      signals: [[0, 'No backlink-authority data source configured']]
    };
  }

  const rl = {};

  try {
    // [REDACTED] Original authenticated provider request construction.
    const url = '[REDACTED: authenticated API request]';

    const data = await majesticLimiter(() =>
      fetchJson(url, {
        timeout: 10000,
        retries: 3,
        rateLimitTracker: rl
      })
    );

    if (data == null) {
      if (rl.hit) {
        return {
          trust_flow: null,
          citation_flow: null,
          ref_domains: null,
          ext_backlinks: null,
          status: 'rate_limited',
          weight: C.HEALTH_BONUS_MAJESTIC_STRONG,
          signals: [[
            0,
            'Temporarily rate-limited by the authority data provider'
          ]]
        };
      }

      return {
        trust_flow: null,
        citation_flow: null,
        ref_domains: null,
        ext_backlinks: null,
        status: 'failed',
        weight: C.HEALTH_BONUS_MAJESTIC_STRONG,
        signals: [[
          0,
          "Couldn't check backlink authority right now"
        ]]
      };
    }

    const item = data?.DataTables?.Results?.Data?.[0] || {};

    const tf = parseInt(item.TrustFlow || '0');
    const cf = parseInt(item.CitationFlow || '0');

    const hasRefDomains =
      item.RefDomains !== undefined &&
      item.RefDomains !== null;

    const hasExtBackLinks =
      item.ExtBackLinks !== undefined &&
      item.ExtBackLinks !== null;

    if (!hasRefDomains && !hasExtBackLinks) {
      return {
        trust_flow: tf,
        citation_flow: cf,
        ref_domains: null,
        ext_backlinks: null,
        status: 'failed',
        weight: C.HEALTH_BONUS_MAJESTIC_STRONG,
        evidence: {
          trust_flow: tf,
          citation_flow: cf,
          raw_item: item
        },
        signals: [[
          0,
          'Authority response did not include backlink counts'
        ]]
      };
    }

    const refDomains = hasRefDomains
      ? parseInt(item.RefDomains || '0')
      : null;

    const extBacklinks = hasExtBackLinks
      ? parseInt(item.ExtBackLinks || '0')
      : null;

    // [REDACTED] Original proprietary authority scoring tiers.

    return {
      trust_flow: tf,
      citation_flow: cf,
      ref_domains: refDomains,
      ext_backlinks: extBacklinks,
      status: 'ok',
      weight: C.HEALTH_BONUS_MAJESTIC_STRONG,
      evidence: {
        trust_flow: tf,
        citation_flow: cf,
        ref_domains: refDomains,
        ext_backlinks: extBacklinks
      },
      signals: []
    };

  } catch {
    return {
      trust_flow: null,
      citation_flow: null,
      ref_domains: null,
      ext_backlinks: null,
      status: 'failed',
      weight: C.HEALTH_BONUS_MAJESTIC_STRONG,
      signals: [[
        0,
        "Couldn't check backlink authority right now"
      ]]
    };
  }
}

// ── Safe Browsing ──────────────────────────────────────────────────────

async function checkSafeBrowsing(domain) {
  const key = env.GOOGLE_SAFE_BROWSING_API_KEY;

  if (!key) {
    return {
      flagged: false,
      status: 'not_applicable',
      weight: 0,
      evidence: {
        checked: false,
        reason: 'no key'
      },
      signals: [[
        0,
        'No safety-check data source configured'
      ]]
    };
  }

  const rl = {};

  try {
    const url = `http://${domain}`;

    const digest = crypto
      .createHash('sha256')
      .update(url)
      .digest();

    const prefix = digest
      .slice(0, 4)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/,'');

    const data = await sbLimiter(() =>
      fetchJson(
        `[REDACTED: authenticated hash-prefix lookup endpoint]`,
        {
          headers: {
            Accept: 'application/json'
          },
          timeout: 10000,
          retries: 3,
          rateLimitTracker: rl
        }
      )
    );

    if (!data && rl.hit) {
      return {
        flagged: false,
        status: 'rate_limited',
        weight: C.HEALTH_BONUS_SAFEBROWSING_CLEAN,
        evidence: { checked: false },
        signals: [[
          0,
          'Temporarily rate-limited by the safety-check provider'
        ]]
      };
    }

    if (!data) {
      return {
        flagged: false,
        status: 'ok',
        weight: C.HEALTH_BONUS_SAFEBROWSING_CLEAN,
        evidence: {
          checked: true,
          matches: []
        },
        signals: [[
          C.HEALTH_BONUS_SAFEBROWSING_CLEAN,
          'No safety-check matches returned'
        ]]
      };
    }

    for (const match of (data.matches || [])) {
      const ret = Buffer.from(match.hash || '', 'base64');

      if (ret.equals(digest)) {
        return {
          flagged: true,
          status: 'ok',
          weight: C.HEALTH_BONUS_SAFEBROWSING_CLEAN,
          evidence: {
            checked: true,
            matches: [match.threatType || '?']
          },
          signals: [[
            C.HEALTH_HARD_FAIL_SCORE,
            `Safety-check match: ${match.threatType || '?'}`
          ]]
        };
      }
    }

    return {
      flagged: false,
      status: 'ok',
      weight: C.HEALTH_BONUS_SAFEBROWSING_CLEAN,
      evidence: {
        checked: true,
        matches: []
      },
      signals: [[
        C.HEALTH_BONUS_SAFEBROWSING_CLEAN,
        'No safety-check matches returned'
      ]]
    };

  } catch (e) {
    return {
      flagged: false,
      status: 'failed',
      weight: C.HEALTH_BONUS_SAFEBROWSING_CLEAN,
      evidence: {
        checked: false,
        error: String(e).slice(0, 120)
      },
      signals: [[
        0,
        "Couldn't run the safety check right now"
      ]]
    };
  }
}

// ── Health aggregator ──────────────────────────────────────────────────

const VERDICTS = {
  ELITE: 'ELITE',
  CLEAN: 'CLEAN',
  FLAGGED: 'FLAGGED',
  NUKED: 'NUKED'
};

class HealthAggregator {
  constructor(rdap) {
    this._rdap = rdap;
  }

  async evaluate(domain) {
    const [
      dnsR,
      blR,
      rdapR,
      whoisR,
      sbR,
      wbR,
      mjR
    ] = await Promise.all([
      cachedCheck('dns', domain, () => probeDns(domain)),
      cachedCheck('blacklists', domain, () => checkBlacklists(domain)),
      cachedCheck('rdap', domain, () => this._rdap.check(domain)),
      cachedCheck('whois', domain, () => checkWhois(domain)),
      cachedCheck('safebrowsing', domain, () => checkSafeBrowsing(domain)),
      inspectWayback(domain),
      cachedCheck('majestic', domain, () => checkMajestic(domain))
    ]);

    // A domain can stop resolving before its registration expires.
    // Avoid treating that intermediate state as contradictory evidence.
    const dnsDark = dnsR.resolves === false;

    if (dnsDark && rdapR.available === false) {
      rdapR.signals = rdapR.signals.map(([impact, note]) =>
        impact === C.HEALTH_PENALTY_STILL_REGISTERED
          ? [0, 'Domain is still registered but its website has gone offline']
          : [impact, note]
      );
    }

    const checks = [
      { name: 'dns', ...dnsR },
      { name: 'blacklists', ...blR },
      { name: 'rdap', ...rdapR },
      { name: 'whois', ...whoisR },
      { name: 'safebrowsing', ...sbR },
      { name: 'wayback', ...wbR },
      { name: 'majestic', ...mjR }
    ];

    const auditLog = [];
    const negativeSignals = [];

    let earned = 0;
    let possible = 0;
    let hardFail = false;

    for (const c of checks) {
      const ok = c.status === 'ok';

      for (const [impact, note] of (c.signals || [])) {
        if (impact === C.HEALTH_HARD_FAIL_SCORE) {
          if (ok) {
            hardFail = true;
            auditLog.push(`  !! ${note} [${c.name}:ok]`);
            negativeSignals.push(note);
          } else {
            auditLog.push(
              `  ··  ${note} [${c.name}:${c.status} — not counted]`
            );
          }

        } else if (ok) {
          earned += impact;

          auditLog.push(
            `  ${impact >= 0 ? '+' : ''}${impact}  ${note} [${c.name}:ok]`
          );

          if (impact < 0) {
            negativeSignals.push(note);
          }

        } else {
          auditLog.push(
            `  ··  ${note} [${c.name}:${c.status} — not counted]`
          );
        }
      }

      if (ok) {
        possible += c.weight || 0;
      }
    }

    const applicable = checks.filter(
      c => c.status !== 'not_applicable'
    );

    const succeeded = checks.filter(
      c => c.status === 'ok'
    );

    const coverage = applicable.length
      ? +(succeeded.length / applicable.length).toFixed(2)
      : 0;

    const covMin = C.HEALTH_COVERAGE_MIN;
    const coverageOK = coverage >= covMin;

    const checkStatus = Object.fromEntries(
      checks.map(c => [c.name, c.status])
    );

    const failedChecks = applicable
      .filter(c => c.status !== 'ok')
      .map(c => c.name);

    // [REDACTED] Original proprietary score normalization and
    // verdict thresholds. The score remains a separate result
    // from check coverage and hard-fail state.

    let score = 0;
    let vk;
    let unverified = false;

    // [REDACTED] Original verdict-selection implementation.

    // Availability remains a separate fact from health.
    // Rankability is independently verified through backlink authority.

    const tfFloor = C.HEALTH_TF_ELITE_MIN;
    const authorityAnswered = mjR.status === 'ok';

    const rankabilityVerified =
      authorityAnswered &&
      (mjR.trust_flow ?? 0) >= tfFloor;

    // [REDACTED] Original rankability cap and verdict adjustment.

    auditLog.push(
      `  Σ  Overall health score: ${score} out of 100, ` +
      `based on ${succeeded.length} of ${applicable.length} checks completed.`
    );

    const evidence = {
      dns: dnsR.evidence || null,
      blacklists: blR.evidence || null,
      rdap: rdapR.evidence || null,
      whois: whoisR.evidence || null,
      safebrowsing: sbR.evidence || null,
      wayback: wbR.evidence || null,
      majestic: mjR.evidence || null
    };

    return {
      domain,
      health_score: score,
      verdict_key: vk,
      verdict: unverified
        ? 'FLAGGED — unverified; retry'
        : VERDICTS[vk],

      hard_fail: hardFail,
      coverage,
      checks_succeeded: succeeded.length,
      checks_total: applicable.length,
      unverified,
      check_status: checkStatus,
      failed_checks: failedChecks,
      negative_signals: negativeSignals,
      rankability_verified: rankabilityVerified,
      evidence,

      snapshot_count: wbR.snapshot_count,
      first_seen: wbR.first_seen,
      last_seen: wbR.last_seen,
      content_flags: wbR.content_flags,
      wayback_history_status: wbR.history_status,
      content_screen_status: wbR.content_screen_status,

      dns_resolves: dnsR.resolves,
      available: rdapR.available,
      blacklisted_on: blR.listed_on,

      whois_created: whoisR.creation_date,
      age_years_whois: whoisR.age_years,
      age_years_wayback: wbR.age_years,

      trust_flow: mjR.trust_flow,
      citation_flow: mjR.citation_flow,
      ref_domains: mjR.ref_domains,
      ext_backlinks: mjR.ext_backlinks,

      safe_browsing_ok: !sbR.flagged,
      audit_log: auditLog
    };
  }
}

module.exports = {
  HealthAggregator,
  RdapVerifier,
  inspectWayback,
  computeWaybackSignals,
  fetchWaybackHistoryFacts,
  fetchWaybackContentFacts,
  cachedCheck,
  noteRateLimitedAndCheckExhausted,
  clearRateLimitStreak
};
