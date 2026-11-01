'use strict';

const { C, OUTPUT_DIR, env } = require('./config');
const { getRegistry } = require('./registry');
const { aggregateFeeds } = require('./feed');
const { fetchDrops: czdsDrops, zoneMembership } = require('./czds');
const { GatekeeperFilter } = require('./gatekeeper');
const {
  DropScheduleAdvisor,
  TriSieveEngine,
  scoreDomain,
  dedupeNearDuplicates
} = require('./scorer');
const { HealthAggregator, RdapVerifier } = require('./health');
const { Module3Valuator } = require('./valuator');
const { RegistrarIntegration } = require('./registrar');
const { sendEliteAlert } = require('./notifier');
const { enrichDomains } = require('./godaddy');
const { getStore } = require('./store');
const {
  enqueueExpirations,
  refreshWatchlist,
  reconcileRenewals
} = require('./dropwatch');
const { waitForPipelineIdle } = require('./runlock');
const fs = require('fs');
const path = require('path');

// Race a promise against a hard timeout.
// On timeout, resolves to `fallback` if provided, otherwise rejects.
function withTimeout(p, ms, fallback) {
  const timer = new Promise((res, rej) =>
    setTimeout(
      () => fallback !== undefined
        ? res(fallback)
        : rej(new Error(`timeout_${ms}ms`)),
      ms
    )
  );

  return Promise.race([p, timer]);
}

// Full health + valuation audit for a single domain.
// Shared by the main pipeline and deferred watchlist audits.
async function auditDomain(record, ctx, log) {
  const {
    agg,
    val,
    reg,
    store,
    timeoutMs = 25000
  } = ctx;

  log(`    [M2] ${record.domain}`);

  // A timeout means the result could not be verified.
  // It is kept distinct from a confirmed negative result.
  const budgetS = Math.round(timeoutMs / 1000);
  let h;

  try {
    h = await withTimeout(
      agg.evaluate(record.domain),
      timeoutMs
    );
  } catch {
    h = {
      domain: record.domain,
      health_score: 0,
      verdict_key: 'FLAGGED',
      timed_out: true,
      verdict: `⚠ FLAGGED — health check timed out (>${budgetS}s); could not verify. Needs retry.`,
      hard_fail: false,
      snapshot_count: 0,
      first_seen: null,
      last_seen: null,
      content_flags: [],
      dns_resolves: null,
      available: null,
      blacklisted_on: [],
      whois_created: null,
      age_years_whois: null,
      referring_domains: 0,
      trust_flow: null,
      citation_flow: null,
      safe_browsing_ok: true,
      audit_log: [
        `  !! Health check exceeded ${budgetS}s — timed out`
      ],
    };
  }

  const profit = record.profit_score;

  // Store access is asynchronous.
  const seen = await store.timesSeen(record.domain);

  if (seen > 0) {
    h.audit_log.push(`  ℹ Seen in ${seen} prior run(s)`);
  }

  const valuation = val
    ? await withTimeout(
        val.appraise(record.domain, h, record),
        10000,
        null
      ).catch(() => null)
    : null;

  if (['ELITE', 'CLEAN'].includes(h.verdict_key)) {
    try {
      const avail = await withTimeout(
        reg.checkAvailability(record.domain),
        10000
      );

      h.audit_log.push(`  🏷 Registrar: ${avail.sources}`);
    } catch {
      h.audit_log.push(`  🏷 Registrar: timeout`);
    }
  }

  // Preserve the marketplace enrichment result alongside the audit entry.
  const entry = [
    h,
    profit,
    valuation,
    record.gd ?? null
  ];

  log(richLine(h, valuation));

  return {
    entry,
    verdictKey: h.verdict_key
  };
}

async function runPipeline(opts = {}, log = console.log) {
  const {
    mode = 'DEBLOAT',
    quantity = C.DEFAULT_QUANTITY,
    skipModule2 = false,
    skipModule3 = false,
    screenContent = true,
    watchlistElites = false,
    fileInput = null,
    targetTlds = null,
  } = opts;

  const runTs = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .slice(0, 19);

  const startedAt = new Date().toISOString();
  const store = getStore();

  log(`${'='.repeat(60)}`);
  log(`[+] STELLASNIPER — pipeline start ${runTs}`);
  log(`    mode=${mode} quantity=${quantity}`);
  log(`${'='.repeat(60)}`);

  // ── Ingest ──────────────────────────────────────────────────────────

  getRegistry();

  const czdsPool = [];
  let czdsZoneDate = null;

  if (env.CZDS_USERNAME && env.CZDS_PASSWORD) {
    try {
      const tlds = (
        env.CZDS_TLDS || C.CZDS_TLDS_DEFAULT
      )
        .split(',')
        .map(t => t.trim())
        .filter(Boolean);

      log(`[+] CZDS: fetching zone drops for .${tlds.join(', .')}...`);

      const {
        drops,
        zoneDate
      } = await czdsDrops(
        env.CZDS_USERNAME,
        env.CZDS_PASSWORD,
        tlds,
        log
      );

      for (const d of drops) {
        czdsPool.push(d);
      }

      czdsZoneDate = zoneDate;

      log(
        `[+] CZDS: ${czdsPool.length.toLocaleString()} dropped domain(s)`
      );
    } catch (e) {
      log(`[-] CZDS failed: ${e.message} — continuing with file input only`);
    }
  }

  // Track the source of each record so lifecycle processing can use
  // the source observation date where one is available.
  const czdsSet = new Set(czdsPool);

  // ── Watchlist reconciliation ────────────────────────────────────────

  if (env.CZDS_USERNAME && env.CZDS_PASSWORD) {
    try {
      const watched = [
        ...await store.getWatch('watching', 5000),
        ...await store.getWatch('available', 5000)
      ].map(w => w.domain);

      if (watched.length) {
        const present = await zoneMembership(watched, log);
        const flagged = await reconcileRenewals(
          store,
          present,
          log
        );

        log(
          flagged.length
            ? `[+] WATCH RECONCILE: ${flagged.length} watched domain(s) reappeared — flagged for confirmation`
            : `[+] WATCH RECONCILE: ${watched.length} watched checked — none renewed`
        );
      }
    } catch (e) {
      log(`[-] watch reconcile failed: ${e.message}`);
    }
  }

  // File-import ingest.
  const filePool = await aggregateFeeds(fileInput, log);

  // Merge and deduplicate all input sources.
  const _mergeSet = new Set();

  for (const d of czdsPool) _mergeSet.add(d);
  for (const d of filePool) _mergeSet.add(d);

  const merged_input = Array.from(_mergeSet);

  log(
    `[+] Total pool after merge: ${merged_input.length.toLocaleString()} unique domain(s)`
  );

  const rawPool = merged_input;

  if (!rawPool.length) {
    log('[-] ABORT: empty pool.');
    return null;
  }

  // ── Gatekeeper ──────────────────────────────────────────────────────

  const gate = new GatekeeperFilter();
  const cleanPool = gate.purge(rawPool, targetTlds, log);

  if (!cleanPool.length) {
    log('[-] ABORT: nothing survived Gatekeeper.');
    return null;
  }

  // ── Module 1: Score ─────────────────────────────────────────────────

  const advisor = new DropScheduleAdvisor();
  const engine = new TriSieveEngine();

  log(`[+] Scoring ${cleanPool.length} domains...`);

  const allRecords = {};

  for (const d of cleanPool) {
    try {
      allRecords[d] = scoreDomain(
        d,
        engine,
        advisor,
        mode
      );
    } catch (e) {
      log(`    [-] ${d}: ${e.message}`);
    }
  }

  // Geographic qualification is supplied by the scoring engine.
  const lgPool = Object.values(allRecords)
    .filter(r => r.sort_key_lg > 0 && r.has_geo)
    .sort((a, b) => b.lg_profit - a.lg_profit);

  log(`[+] LG pool: ${lgPool.length} qualified domains`);

  // Reuse the scoring engine's geographic detection.
  const geoHitsOf = core => engine.microGeoHits(core);

  // Remove near-duplicate records before selecting the working pool.
  const {
    records: combinedPool,
    removed: lgRemoved
  } = dedupeNearDuplicates(
    lgPool,
    quantity,
    geoHitsOf
  );

  if (lgRemoved > 0) {
    log(
      `[+] LG near-dupe filter: ${lgRemoved} variant(s) removed before quantity cut.`
    );
  }

  log(
    `[+] LG pool: ${combinedPool.length} domain(s) selected`
  );

  // Retain the full ranked list for backfill.
  const {
    records: reservoir
  } = dedupeNearDuplicates(
    lgPool,
    lgPool.length,
    geoHitsOf
  );

  // Write Module 1 output.
  const m1Lines = buildM1Text(
    runTs,
    mode,
    combinedPool
  );

  writeOutput(
    runTs,
    'module1',
    '.txt',
    m1Lines.join('\n')
  );

  writeOutput(
    runTs,
    'module1',
    '.csv',
    buildM1Csv(combinedPool)
  );

  log(
    `[+] Module 1 complete. Top profit: ${combinedPool[0]?.domain || 'none'}`
  );

  // ── Availability triage ────────────────────────────────────────────

  if (skipModule2) {
    const enrichedM1 = await enrichDomains(
      combinedPool,
      log
    );

    return {
      runTs,
      m1: enrichedM1
    };
  }

  const rdap = await new RdapVerifier().init();
  const agg = new HealthAggregator(rdap);
  const val = skipModule3
    ? null
    : new Module3Valuator();

  const reg = new RegistrarIntegration();

  const auditCtx = {
    agg,
    val,
    reg,
    store,
    timeoutMs: C.DOMAIN_AUDIT_TIMEOUT_MS
  };

  // ── Backfill complete-data results ──────────────────────────────────

  log(`\n${'='.repeat(60)}`);
  log(
    `[+] MODULE 2+3 — backfill from ranked list of ${reservoir.length}`
  );
  log(`${'='.repeat(60)}`);

  const elite = [];
  const clean = [];
  const flagged = [];
  const nuked = [];

  const kept = [];
  const discarded = [];
  const entryByDomain = {};
  const recByDomain = {};

  let scanned = 0;

  const CONCURRENCY = C.M2_BATCH_CONCURRENCY;

  for (
    let i = 0;
    i < reservoir.length && kept.length < quantity;
    i += CONCURRENCY
  ) {
    const batch = reservoir.slice(
      i,
      i + CONCURRENCY
    );

    const results = await Promise.all(
      batch.map(async rec => {
        const [enr] = await enrichDomains(
          [rec],
          log
        );

        const record = enr || rec;

        let { entry } = await auditDomain(
          record,
          auditCtx,
          log
        );

        if (!auditComplete(entry[0])) {
          log(
            `    [retry] ${entry[0].domain} — incomplete`
          );

          ({ entry } = await auditDomain(
            record,
            auditCtx,
            log
          ));
        }

        await store.saveEvidence(
          entry[0].domain,
          runTs,
          {
            ...(entry[0].evidence || {}),
            valuation: entry[2] || null,
            marketplace: entry[3] || null
          }
        );

        return {
          entry,
          record
        };
      })
    );

    for (const { entry, record } of results) {
      const [h] = entry;

      if (auditComplete(h)) {
        entryByDomain[h.domain] = entry;
        recByDomain[h.domain] = record;
        kept.push(entry);

        ({
          ELITE: elite,
          CLEAN: clean,
          FLAGGED: flagged
        }[h.verdict_key] || nuked).push(entry);
      } else {
        discarded.push(entry);

        log(
          `    [discard] ${h.domain} — incomplete after retry`
        );
      }

      scanned++;

      log(
        `    [progress] kept ${kept.length}/${quantity} · ` +
        `discarded ${discarded.length} · ` +
        `scanned ${scanned}/${reservoir.length}`
      );
    }
  }

  // A concurrent batch can exceed the requested quantity.
  // Remove the lowest-ranked extras.
  while (kept.length > quantity) {
    const extra = kept.pop();
    const [h] = extra;

    for (const bucket of [
      elite,
      clean,
      flagged,
      nuked
    ]) {
      const k = bucket.indexOf(extra);

      if (k >= 0) {
        bucket.splice(k, 1);
      }
    }

    delete entryByDomain[h.domain];
    delete recByDomain[h.domain];
  }

  log(
    `[+] BACKFILL: kept ${kept.length} complete-data · discarded ${discarded.length} incomplete`
  );

  for (const bucket of [
    elite,
    clean,
    flagged,
    nuked
  ]) {
    bucket.sort(
      ([a], [b]) => b.health_score - a.health_score
    );
  }

  await store.saveM1(
    runTs,
    Object.values(recByDomain)
  );

  await store.updateHealth(
    runTs,
    [...elite, ...clean, ...flagged, ...nuked]
  );

  // Use one snapshot of the current selection cutoffs for the batch.
  const cutoffs = await store.getStarCutoffs();

  for (const [dom, rec] of Object.entries(recByDomain)) {
    await store.markResult(
      runTs,
      dom,
      {
        isWinner: isWatchWinner(rec) ? 1 : 0,
        isStar: isWatchStar(
          rec,
          entryByDomain[dom],
          cutoffs
        ) ? 1 : 0,
        lgProfit: rec.lg_profit ?? null
      }
    );
  }

  await store.saveMeta(runTs, {
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    domains_ingested: rawPool.length,
    domains_scored: combinedPool.length,
    elite_count: elite.length,
    clean_count: clean.length,
    flagged_count: flagged.length,
    nuked_count: nuked.length,
  });

  writeOutput(
    runTs,
    'module2',
    '.json',
    JSON.stringify(
      {
        elite,
        clean,
        flagged,
        nuked
      },
      null,
      2
    )
  );

  if (watchlistElites) {
    elite.forEach(([h]) =>
      store.addToWatchlist(h.domain, 'Auto — ELITE')
    );
  }

  await sendEliteAlert(elite, runTs);

  // ── Console summary ────────────────────────────────────────────────

  const auditedEntries = [
    ...elite,
    ...clean,
    ...flagged,
    ...nuked
  ];

  const actionable = auditedEntries.filter(
    ([h]) =>
      h.available === true &&
      ['ELITE', 'CLEAN'].includes(h.verdict_key)
  ).length;

  log(`\n${'='.repeat(60)}`);

  log(
    `[+] FUNNEL: ingested ${rawPool.length} → ` +
    `scored ${cleanPool.length} → ` +
    `reservoir ${reservoir.length} → ` +
    `kept ${kept.length} complete ` +
    `(discarded ${discarded.length}) → ` +
    `actionable-now ${actionable}`
  );

  log(
    `[+] VERDICTS: ELITE:${elite.length} CLEAN:${clean.length} ` +
    `FLAGGED:${flagged.length} NUKED:${nuked.length}`
  );

  log(summaryTable(auditedEntries));
  log(`\n[+] Full detail -> ${OUTPUT_DIR}`);

  // ── Watchlist enqueue ───────────────────────────────────────────────

  const winners = Object.values(recByDomain)
    .filter(isWatchWinner);

  const toWatch = winners.map(r => ({
    domain: r.domain,
    profit_score: r.profit_score,
    lg_profit: r.lg_profit,
    is_winner: 1,
    is_star: isWatchStar(
      r,
      entryByDomain[r.domain],
      cutoffs
    ) ? 1 : 0,
    zoneDate: czdsSet.has(r.domain)
      ? czdsZoneDate
      : null,
  }));

  const newlyQueued = await enqueueExpirations(
    store,
    toWatch
  );

  for (const r of winners) {
    const e = entryByDomain[r.domain];

    if (e && e[0].available === true) {
      const [h, , valuation] = e;

      await store.recordWatchCheck(
        r.domain,
        {
          checkedAt: new Date().toISOString(),
          available: true
        }
      );

      await store.recordWatchAudit(
        r.domain,
        {
          verdict: h.verdict_key,
          health: h.health_score,
          estMid: valuation?.est_mid ?? null
        }
      );
    }
  }

  const promotedAudited = [];

  const {
    promoted,
    checked
  } = await refreshWatchlist(
    store,
    rdap,
    {
      log,

      onPromote: async (domain, watchRow) => {
        // Re-enrich and audit when a watched record becomes available.
        const [enr] = await enrichDomains(
          [{
            domain,
            profit_score: watchRow.profit_score
          }],
          log
        );

        const rec = enr || {
          domain,
          profit_score: watchRow.profit_score
        };

        const { entry } = await auditDomain(
          rec,
          auditCtx,
          log
        );

        const [h, , valuation] = entry;

        await store.saveEvidence(
          domain,
          runTs,
          {
            ...(h.evidence || {}),
            valuation,
            marketplace: entry[3] || null
          }
        );

        await store.recordWatchAudit(
          domain,
          {
            verdict: h.verdict_key,
            health: h.health_score,
            estMid: valuation?.est_mid ?? null
          }
        );

        promotedAudited.push(entry);

        ({
          ELITE: elite,
          CLEAN: clean,
          FLAGGED: flagged
        }[h.verdict_key] || nuked).push(entry);
      },
    }
  );

  if (promotedAudited.length) {
    await store.updateHealth(
      runTs,
      promotedAudited
    );
  }

  // Render the persisted watchlist state.
  const m1Path = path.join(
    OUTPUT_DIR,
    `module1_${runTs}.txt`
  );

  for (
    const line of await renderRunStreams(
      store,
      {
        newlyQueued,
        promoted,
        checked,
        m1Path
      }
    )
  ) {
    log(line);
  }

  return {
    runTs,
    m1: combinedPool,
    elite,
    clean,
    flagged,
    nuked,
    watch: {
      newlyQueued,
      promoted,
      checked
    }
  };
}

// ── Helpers ───────────────────────────────────────────────────────────

function writeOutput(ts, prefix, ext, content) {
  try {
    fs.mkdirSync(
      OUTPUT_DIR,
      { recursive: true }
    );

    fs.writeFileSync(
      path.join(
        OUTPUT_DIR,
        `${prefix}_${ts}${ext}`
      ),
      content,
      'utf8'
    );
  } catch {}
}

// Compact money formatter.
function fmtMoney(n) {
  return n != null
    ? '$' + Math.round(n).toLocaleString()
    : '—';
}

// One-line summary for a single audited record.
function richLine(h, val) {
  const avail =
    h.available === true
      ? '✓avail'
      : h.available === false
        ? '✗reg'
        : '?unk';

  const sigs = (h.audit_log || [])
    .map(x => x.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(' · ');

  const valStr = val
    ? `${fmtMoney(val.est_monthly_recoup ?? val.est_mid)}/mo` +
      `${val.inputs ? ` (${val.inputs.est_calls} calls · pop ${val.inputs.population})` : ''}`
    : 'no valuation';

  const cov = h.coverage != null
    ? `${Math.round(h.coverage * 100)}%${h.unverified ? '!' : ''}`
    : '—';

  return (
    `    → ${String(h.verdict_key).padEnd(7)} ` +
    `H:${String(h.health_score).padStart(3)} ` +
    `cov:${String(cov).padStart(4)} ` +
    `${avail.padEnd(6)} ${h.domain} | ${valStr}` +
    `${sigs ? ' [' + sigs + ']' : ''}`
  );
}

// Final ranked output table.
function summaryTable(entries) {
  if (!entries.length) {
    return '  (no candidates)';
  }

  const disq = h =>
    h.verdict_key === 'NUKED' || h.hard_fail;

  const gate = h =>
    h.verdict_key === 'NUKED'
      ? 'FAIL'
      : h.verdict_key === 'FLAGGED'
        ? 'REVIEW'
        : 'PASS';

  const rk = h =>
    h.rankability_verified === true ? 'y' : 'n';

  const rows = entries
    .map(([h, profit, val]) => ({
      h,
      profit,
      val
    }))
    .sort((a, b) =>
      ((disq(a.h) ? 1 : 0) - (disq(b.h) ? 1 : 0))
      || ((b.profit ?? 0) - (a.profit ?? 0))
      || (b.val?.est_mid ?? -1) - (a.val?.est_mid ?? -1)
    );

  const avail = h =>
    h.available === true
      ? 'yes'
      : h.available === false
        ? 'no'
        : '?';

  const head =
    `   #  ${'DOMAIN'.padEnd(28)} ` +
    `${'GATE'.padEnd(6)} ${'HLTH'.padStart(4)} ` +
    `${'RANK?'.padStart(5)} ${'SCORE'.padStart(7)} ` +
    `${'EST'.padStart(9)} AVAIL`;

  const sep = '  ' + '─'.repeat(head.length - 2);

  const body = rows.map((r, i) =>
    `  ${String(i + 1).padStart(2)}  ` +
    `${r.h.domain.padEnd(28)} ` +
    `${gate(r.h).padEnd(6)} ` +
    `${String(r.h.health_score).padStart(4)} ` +
    `${rk(r.h).padStart(5)} ` +
    `${(r.profit != null ? r.profit.toFixed(1) : '—').padStart(7)} ` +
    `${fmtMoney(r.val?.est_mid).padStart(9)} ` +
    `${avail(r.h)}`
  );

  return [
    '',
    '  💰 RANKED BY LEAD-GEN VALUE',
    sep,
    head,
    sep,
    ...body,
    sep,
    '  GATE PASS=clean · REVIEW=manual review · FAIL=disqualified'
  ].join('\n');
}

function buildM1Csv(records) {
  const fields = [
    'domain',
    'profit_score',
    'lg_deb',
    'lg_blo',
    'lg_conf',
    'drop_active'
  ];

  return [
    fields.join(','),
    ...records.map(r =>
      fields.map(f => r[f] ?? '').join(',')
    )
  ].join('\n');
}

function buildM1Text(ts, mode, lg) {
  const S = '='.repeat(60);
  const s = '-'.repeat(60);

  const fmt = (i, r) => [
    `  [${i}] ${r.domain}${r.drop_active ? ' ⚡ DROP LIVE' : ''}`,
    `       LG: D=${r.lg_deb.toFixed(1)} B=${r.lg_blo.toFixed(1)} Conf=${r.lg_conf}`,
    `       SCORE: ${r.profit_score.toFixed(2)}`,
    ...r.lg_mods.map(m => `         • ${m}`),
    '',
  ].join('\n');

  return [
    S,
    `STELLASNIPER — MODULE 1 Run:${ts} Mode:${mode}`,
    S,
    '--- TOP LEADGEN ---',
    s,
    ...lg.map((r, i) => fmt(i + 1, r)),
    S,
  ];
}

// ── Watchlist classification + rendering ──────────────────────────────

// [REDACTED] Original winner qualification criteria.
// The implementation evaluated geographic and commercial scoring
// attributes against proprietary selection thresholds.
function isWatchWinner(r) {
  // [REDACTED] Original winner-selection expression.
}

// [REDACTED] Original high-conviction classification criteria.
// The implementation evaluated audit results and valuation data
// against proprietary pool-relative selection rules.
function isWatchStar(r, entry, cutoffs) {
  // [REDACTED] Original star-selection expression.
}

// Determine whether all applicable checks have completed successfully.
// Valid negative results and structurally unavailable checks are distinct
// from failed or unverified checks.
function auditComplete(h) {
  if (!h || h.timed_out) return false;
  if (h.unverified) return false;

  const cs = h.check_status || {};

  return !Object.values(cs).some(
    st => st === 'failed'
  );
}

// Render the persisted output streams.
async function renderRunStreams(store, ctx = {}) {
  const {
    newlyQueued = [],
    promoted = [],
    checked = 0,
    m1Path = null
  } = ctx;

  const bar = '='.repeat(64);
  const today = new Date().toISOString().slice(0, 10);

  const daysUntil = d =>
    d
      ? Math.round(
          (
            new Date(d).getTime() -
            new Date(today).getTime()
          ) / 86400000
        )
      : null;

  const lgv = w =>
    Number(w.lg_profit ?? w.profit_score ?? 0);

  const out = [];

  out.push(`\n${bar}`);
  out.push('  ▸ STREAM A — DEBUG');
  out.push(
    m1Path
      ? `     full breakdown → ${m1Path}`
      : '     (no M1 file this run)'
  );

  // Stream B — persisted watchlist.
  const watching = await store.getWatch(
    'watching',
    1000
  );

  watching.sort((a, b) =>
    (
      (daysUntil(a.est_drop_date) ?? 1e9) -
      (daysUntil(b.est_drop_date) ?? 1e9)
    ) || (lgv(b) - lgv(a))
  );

  const starCount = watching.filter(
    w => w.is_star
  ).length;

  out.push('');

  out.push(
    `  ▸ STREAM B — WATCH ROLODEX ` +
    `(${watching.length} records · ${starCount} ★ · ` +
    `+${newlyQueued.length} new this run)`
  );

  if (!watching.length) {
    out.push('     (empty)');
  } else {
    const topN = C.WATCH_ROLODEX_TOP_N ?? 25;

    out.push(
      `     ranked by estimated drop date, then lead-gen value — ` +
      `top ${Math.min(watching.length, topN)} of ${watching.length}`
    );

    out.push(
      `        ${'DOMAIN'.padEnd(28)} ` +
      `${'LG$'.padStart(8)} ` +
      `${'DROP (est)'.padEnd(12)} ` +
      `${'COUNTDOWN'.padStart(11)}`
    );

    for (const w of watching.slice(0, topN)) {
      const du = daysUntil(w.est_drop_date);

      const cd =
        du == null
          ? '?'
          : du < 0
            ? `${-du}d overdue`
            : du === 0
              ? 'today'
              : `in ${du}d`;

      out.push(
        `     ${w.is_star ? '★' : ' '} ` +
        `${String(w.domain).padEnd(28)} ` +
        `${lgv(w).toFixed(1).padStart(8)} ` +
        `${String(w.est_drop_date || '?').padEnd(12)} ` +
        `${cd.padStart(11)}`
      );
    }
  }

  // Stream C — records confirmed available and audited.
  const avail = await store.getWatch(
    'available',
    1000
  );

  avail.sort((a, b) => lgv(b) - lgv(a));

  const gate = v =>
    v === 'NUKED'
      ? 'FAIL'
      : v === 'FLAGGED'
        ? 'REVIEW'
        : v
          ? 'PASS'
          : '—';

  out.push('');

  out.push(
    `  ▸ STREAM C — ACTIONABLE NOW (${avail.length} records)`
  );

  if (!avail.length) {
    out.push('     (none yet)');
  } else {
    out.push(
      `        ${'DOMAIN'.padEnd(28)} ` +
      `${'GATE'.padEnd(6)} ` +
      `${'HLTH'.padStart(4)} ` +
      `${'EST'.padStart(8)} ` +
      `${'AVAIL SINCE'.padStart(12)}`
    );

    for (const w of avail.slice(0, 50)) {
      const since = daysUntil(
        w.became_available
          ? String(w.became_available).slice(0, 10)
          : null
      );

      const sinceStr =
        since == null
          ? '?'
          : `${-since}d ago`;

      out.push(
        `        ${String(w.domain).padEnd(28)} ` +
        `${gate(w.audit_verdict).padEnd(6)} ` +
        `${String(w.audit_health ?? '—').padStart(4)} ` +
        `${(w.audit_est_mid != null ? '$' + Math.round(w.audit_est_mid) : '—').padStart(8)} ` +
        `${sinceStr.padStart(12)}`
      );
    }
  }

  out.push('');

  out.push(
    `  changes this run: +${newlyQueued.length} queued · ` +
    `${checked} re-checked · ${promoted.length} promoted`
  );

  out.push(bar);

  return out;
}

// Re-audit a single record on demand.
// Cached checks are reused where available.
async function reauditOne(domain, log = () => {}) {
  const store = getStore();

  const engine = new TriSieveEngine();
  const advisor = new DropScheduleAdvisor();

  let rec;

  try {
    rec = scoreDomain(
      domain,
      engine,
      advisor,
      'DEBLOAT'
    );
  } catch {
    rec = {
      domain,
      profit_score: null
    };
  }

  const rdap = await new RdapVerifier().init();
  const agg = new HealthAggregator(rdap);
  const val = new Module3Valuator();
  const reg = new RegistrarIntegration();

  const [enr] = await enrichDomains(
    [rec],
    log
  );

  const record = enr || rec;

  const { entry } = await auditDomain(
    record,
    {
      agg,
      val,
      reg,
      store,
      timeoutMs: C.DOMAIN_AUDIT_TIMEOUT_MS
    },
    log
  );

  const [h, , valuation] = entry;

  const runTs = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .slice(0, 19);

  await store.saveM1(
    runTs,
    [record]
  );

  await store.updateHealth(
    runTs,
    [entry]
  );

  const cutoffs = await store.getStarCutoffs();

  await store.markResult(
    runTs,
    domain,
    {
      isWinner: isWatchWinner(record) ? 1 : 0,
      isStar: isWatchStar(
        record,
        entry,
        cutoffs
      ) ? 1 : 0,
      lgProfit: record.lg_profit ?? null
    }
  );

  await store.saveEvidence(
    domain,
    runTs,
    {
      ...(h.evidence || {}),
      valuation,
      marketplace: entry[3] || null
    }
  );

  await store.recordWatchAudit(
    domain,
    {
      verdict: h.verdict_key,
      health: h.health_score,
      estMid: valuation?.est_mid ?? null
    }
  );

  return {
    domain,
    verdict: h.verdict_key,
    health_score: h.health_score,
    coverage: h.coverage,
    rankability_verified: h.rankability_verified,
    available: h.available
  };
}

// Refresh audited data for persisted watchlist records.
async function refreshWatchAudits(log = () => {}) {
  const store = getStore();

  const rows = [
    ...await store.getWatch('watching', 500),
    ...await store.getWatch('available', 500)
  ];

  if (!rows.length) {
    log('[boot] watch refresh: queue empty');
    return 0;
  }

  log(
    `[boot] watch refresh: re-auditing ${rows.length} records`
  );

  let n = 0;

  for (const w of rows) {
    // Yield to an active pipeline run before starting another audit.
    await waitForPipelineIdle();

    try {
      await reauditOne(
        w.domain,
        () => {}
      );

      n++;
    } catch (e) {
      log(
        `[boot] watch refresh: ${w.domain} failed — ${e.message}`
      );
    }
  }

  log(
    `[boot] watch refresh: ${n}/${rows.length} refreshed`
  );

  return n;
}

module.exports = {
  runPipeline,
  summaryTable,
  renderRunStreams,
  isWatchWinner,
  isWatchStar,
  reauditOne,
  refreshWatchAudits,
  auditComplete
};
