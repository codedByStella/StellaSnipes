'use strict';

const path = require('path');
const fs   = require('fs');
const os   = require('os');
const { DB_PATH, C } = require('./config');

// sql.js is a pure-JS SQLite implementation.
const initSqlJs = require('sql.js');

let _db   = null;
let _dirty= false;
let _dbPath = null;
let _persistTimer = null;
let _hooksInstalled = false;

// Single-writer durability state.
let _lockFd   = null;
let _lockPath = null;
let _readOnly = false;

const LOCK_STALE_MS = 5 * 60 * 1000;

async function getDb(dbPath = DB_PATH) {
  if (_db) return _db;
  _dbPath = dbPath;

  const SQL = await initSqlJs();
  let data = null;

  try {
    data = fs.existsSync(dbPath) ? fs.readFileSync(dbPath) : null;
  } catch (e) {
    throw new Error(`[store] cannot read DB ${path.basename(dbPath)}: ${e.message}`);
  }

  try {
    _db = data ? new SQL.Database(data) : new SQL.Database();
    _init(_db);
  } catch (e) {
    if (e.message && /malformed|not a database|file is encrypted|disk image/i.test(e.message)) {
      // Preserve the original database if initialization detects corruption.
      let backup = dbPath + '.corrupt.' + Date.now();

      try {
        fs.copyFileSync(dbPath, backup);
      } catch {
        backup = '(copy failed)';
      }

      const msg = `[store] FATAL: database ${path.basename(dbPath)} is malformed/corrupt. Preserved a `
        + `copy at ${path.basename(backup)}; the original is untouched. Refusing to auto-wipe.`;

      console.error('\n' + '!'.repeat(76) + '\n' + msg + '\n' + '!'.repeat(76) + '\n');

      _db = null;
      throw new Error(msg);
    }

    throw e;
  }

  // Prevent concurrent processes from overwriting the same database.
  _readOnly = !_acquireLock(dbPath);

  if (_readOnly) {
    console.warn(`[store] another process holds the write lock on ${path.basename(dbPath)} — running `
      + `READ-ONLY; changes this run will NOT be saved. Close the other run to enable writes.`);
  }

  // Periodically persist changes when this process owns the write lock.
  _persistTimer = setInterval(() => {
    if (_dirty && !_readOnly && _persist(dbPath)) {
      _dirty = false;
    }
  }, 5000);

  if (_persistTimer.unref) _persistTimer.unref();

  _installShutdownHooks();
  return _db;
}

// Synchronously write pending changes to disk.
function flush() {
  if (_db && _dirty && !_readOnly) {
    if (_persist(_dbPath)) {
      _dirty = false;
    }
  }
}

// Ensure pending writes are flushed during normal shutdown.
function _installShutdownHooks() {
  if (_hooksInstalled) return;
  _hooksInstalled = true;

  process.on('beforeExit', () => {
    flush();
    _releaseLock();
  });

  const shutdown = () => {
    flush();
    _releaseLock();

    if (_persistTimer) clearInterval(_persistTimer);

    process.exit(0);
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

function _persist(dbPath) {
  if (!_db || _readOnly) return;

  const tmp = dbPath + '.tmp-' + process.pid;

  try {
    const data = _db.export();

    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    // Atomic write: write and sync a temporary file, then rename it.
    const fd = fs.openSync(tmp, 'w');

    try {
      fs.writeSync(fd, Buffer.from(data));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    fs.renameSync(tmp, dbPath);
    return true;
  } catch (e) {
    console.error('[store] persist error:', e.message);

    try {
      fs.unlinkSync(tmp);
    } catch {}

    return false;
  }
}

// Acquire an exclusive write lock. Returns false if another live writer holds it.
function _acquireLock(dbPath) {
  const lockPath = dbPath + '.lock';

  const isStale = () => {
    try {
      const raw = JSON.parse(fs.readFileSync(lockPath, 'utf8'));

      if (raw.host === os.hostname() && raw.pid) {
        try {
          process.kill(raw.pid, 0);
          return false;
        } catch (e) {
          if (e.code === 'EPERM') return false;
          if (e.code === 'ESRCH') return true;
        }
      }

      const lockTime = Number(raw.ts);
      const referenceTime = Number.isFinite(lockTime) && lockTime > 0
        ? lockTime
        : fs.statSync(lockPath).mtimeMs;

      return (Date.now() - referenceTime) > LOCK_STALE_MS;
    } catch (e) {
      // A newly-created lock can be observed before its JSON payload is fully
      // written. Do not steal that live lock just because parsing failed.
      if (e.code === 'ENOENT') return true;
      if (!(e instanceof SyntaxError)) return false;

      try {
        return (Date.now() - fs.statSync(lockPath).mtimeMs) > LOCK_STALE_MS;
      } catch (statError) {
        return statError.code === 'ENOENT';
      }
    }
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      _lockFd = fs.openSync(lockPath, 'wx');

      fs.writeSync(
        _lockFd,
        JSON.stringify({
          pid: process.pid,
          host: os.hostname(),
          ts: Date.now()
        })
      );

      _lockPath = lockPath;
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') {
        console.error('[store] lock error:', e.message);

        if (_lockFd != null) {
          try {
            fs.closeSync(_lockFd);
          } catch {}

          try {
            fs.unlinkSync(lockPath);
          } catch {}
        }

        _lockFd = null;
        _lockPath = null;
        return false;
      }

      if (isStale()) {
        try {
          fs.unlinkSync(lockPath);
        } catch {}

        continue;
      }

      return false;
    }
  }

  return false;
}

function _releaseLock() {
  try {
    if (_lockFd != null) fs.closeSync(_lockFd);
  } catch {}

  try {
    if (_lockPath) fs.unlinkSync(_lockPath);
  } catch {}

  _lockFd = null;
  _lockPath = null;
}

function _init(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS domain_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_ts TEXT, domain TEXT, profit_score REAL,
      health_score INTEGER, verdict TEXT, available INTEGER,
      referring_domains INTEGER, trust_flow INTEGER,
      first_seen TEXT, snapshot_count INTEGER, blacklisted INTEGER,
      est_mid REAL, timed_out INTEGER DEFAULT 0,
      est_low REAL, est_high REAL, roi_low REAL, roi_high REAL,
      dns_resolves INTEGER, last_seen TEXT, whois_created TEXT,
      age_years_whois REAL, age_years_wayback REAL,
      content_flagged INTEGER, safe_browsing_ok INTEGER, blacklisted_on TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_domain ON domain_runs(domain);
    CREATE INDEX IF NOT EXISTS idx_run_ts ON domain_runs(run_ts);

    CREATE TABLE IF NOT EXISTS watchlist (
      domain TEXT PRIMARY KEY, added_ts TEXT, notes TEXT
    );

    CREATE TABLE IF NOT EXISTS run_meta (
      run_ts TEXT PRIMARY KEY, started_at TEXT, finished_at TEXT,
      domains_ingested INTEGER, domains_scored INTEGER,
      elite_count INTEGER, clean_count INTEGER,
      flagged_count INTEGER, nuked_count INTEGER
    );

    CREATE TABLE IF NOT EXISTS drop_watch (
      domain TEXT PRIMARY KEY,
      first_seen_dark TEXT,
      est_drop_date TEXT,
      profit_score REAL,
      last_checked TEXT,
      available INTEGER,
      became_available TEXT,
      status TEXT DEFAULT 'watching',
      added_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_watch_status ON drop_watch(status);
    CREATE INDEX IF NOT EXISTS idx_watch_drop ON drop_watch(est_drop_date);

    CREATE TABLE IF NOT EXISTS audit_evidence (
      domain TEXT PRIMARY KEY,
      run_ts TEXT,
      captured_at TEXT,
      evidence TEXT
    );
  `);

  // Idempotent migrations for existing databases.
  const MIGRATIONS = [
    'ALTER TABLE domain_runs ADD COLUMN timed_out INTEGER DEFAULT 0',
    'ALTER TABLE domain_runs ADD COLUMN est_low REAL',
    'ALTER TABLE domain_runs ADD COLUMN est_high REAL',
    'ALTER TABLE domain_runs ADD COLUMN roi_low REAL',
    'ALTER TABLE domain_runs ADD COLUMN roi_high REAL',
    'ALTER TABLE domain_runs ADD COLUMN dns_resolves INTEGER',
    'ALTER TABLE domain_runs ADD COLUMN last_seen TEXT',
    'ALTER TABLE domain_runs ADD COLUMN whois_created TEXT',
    'ALTER TABLE domain_runs ADD COLUMN age_years_whois REAL',
    'ALTER TABLE domain_runs ADD COLUMN age_years_wayback REAL',
    'ALTER TABLE domain_runs ADD COLUMN content_flagged INTEGER',
    'ALTER TABLE domain_runs ADD COLUMN safe_browsing_ok INTEGER',
    'ALTER TABLE domain_runs ADD COLUMN blacklisted_on TEXT',
    'ALTER TABLE domain_runs ADD COLUMN valuation_json TEXT',
    'ALTER TABLE domain_runs ADD COLUMN audit_reason TEXT',
    'ALTER TABLE domain_runs ADD COLUMN lg_profit REAL',
    'ALTER TABLE domain_runs ADD COLUMN is_winner INTEGER DEFAULT 0',
    'ALTER TABLE domain_runs ADD COLUMN is_star INTEGER DEFAULT 0',
    'ALTER TABLE domain_runs ADD COLUMN check_status_json TEXT',
    'ALTER TABLE domain_runs ADD COLUMN ref_domains INTEGER',
    'ALTER TABLE domain_runs ADD COLUMN ext_backlinks INTEGER',
    'ALTER TABLE domain_runs ADD COLUMN marketplace_price REAL',
    'ALTER TABLE domain_runs ADD COLUMN marketplace_status TEXT',
    'ALTER TABLE domain_runs ADD COLUMN marketplace_source TEXT',
    'ALTER TABLE drop_watch ADD COLUMN lg_profit REAL',
    'ALTER TABLE drop_watch ADD COLUMN is_winner INTEGER DEFAULT 0',
    'ALTER TABLE drop_watch ADD COLUMN is_star INTEGER DEFAULT 0',
    'ALTER TABLE drop_watch ADD COLUMN audit_verdict TEXT',
    'ALTER TABLE drop_watch ADD COLUMN audit_health INTEGER',
    'ALTER TABLE drop_watch ADD COLUMN audit_est_mid REAL',
    'ALTER TABLE drop_watch ADD COLUMN delete_reason TEXT',
    'ALTER TABLE drop_watch ADD COLUMN deleted_at TEXT',
    'ALTER TABLE drop_watch ADD COLUMN renewal_flagged INTEGER DEFAULT 0',
    'ALTER TABLE drop_watch ADD COLUMN renewal_proof TEXT',
    'ALTER TABLE drop_watch ADD COLUMN renewal_flagged_at TEXT',
  ];

  for (const sql of MIGRATIONS) {
    try {
      db.run(sql);
    } catch (e) {
      if (!/duplicate column name/i.test(e && e.message || '')) throw e;
    }
  }
}

function _all(db, sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);

  const rows = [];

  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }

  stmt.free();
  return rows;
}

function _get(db, sql, params = []) {
  return _all(db, sql, params)[0] || null;
}

function _run(db, sql, params = []) {
  db.run(sql, params);
  _dirty = true;
}

const CHECK_LABELS = {
  dns: 'Website live/offline check',
  blacklists: 'Spam blocklist check',
  rdap: 'Registration status check',
  whois: 'Domain registration record',
  safebrowsing: 'Google safety check',
  wayback: 'Site history check',
  majestic: 'Backlink authority check',
};

const STATUS_LABELS = {
  failed: "couldn't complete — try again later",
  not_applicable: 'no data source available',
  timeout: 'timed out — try again later',
  rate_limited: 'temporarily rate-limited — will retry automatically',
};

class ResultStore {
  constructor(dbPath = DB_PATH) {
    this._path = dbPath;
    this._ready = getDb(dbPath).then(db => {
      this._db = db;
    });
  }

  async _ensure() {
    await this._ready;
  }

  async saveM1(runTs, records) {
    await this._ensure();

    for (const r of records) {
      _run(
        this._db,
        'INSERT INTO domain_runs(run_ts, domain, profit_score, lg_profit) VALUES(?,?,?,?)',
        [runTs, r.domain, r.profit_score, r.lg_profit ?? null]
      );
    }
  }

  async markResult(runTs, domain, {
    isWinner = 0,
    isStar = 0,
    lgProfit = null
  }) {
    await this._ensure();

    if (lgProfit != null) {
      _run(
        this._db,
        'UPDATE domain_runs SET is_winner=?, is_star=?, lg_profit=? WHERE run_ts=? AND domain=?',
        [isWinner ? 1 : 0, isStar ? 1 : 0, lgProfit, runTs, domain]
      );
    } else {
      _run(
        this._db,
        'UPDATE domain_runs SET is_winner=?, is_star=? WHERE run_ts=? AND domain=?',
        [isWinner ? 1 : 0, isStar ? 1 : 0, runTs, domain]
      );
    }
  }

  async updateHealth(runTs, entries) {
    await this._ensure();

    for (const [h, , val, gd] of entries) {
      let marketplacePrice = null;
      let marketplaceStatus = null;
      let marketplaceSource = null;

      if (gd) {
        marketplaceSource = 'godaddy';

        if (gd.error) {
          marketplaceStatus = 'error';
        } else if (gd.auction) {
          marketplaceStatus = 'auction';
          marketplacePrice = gd.auction.current_bid ?? null;
        } else if (gd.appraisal) {
          marketplaceStatus = 'appraised';
          marketplacePrice = gd.appraisal.est_value ?? null;
        } else {
          marketplaceStatus = 'no_listing';
        }
      }

      _run(this._db, `
        UPDATE domain_runs SET health_score=?,verdict=?,available=?,
          referring_domains=?,trust_flow=?,ref_domains=?,ext_backlinks=?,first_seen=?,snapshot_count=?,blacklisted=?,est_mid=?,timed_out=?,
          est_low=?,est_high=?,roi_low=?,roi_high=?,dns_resolves=?,last_seen=?,whois_created=?,
          age_years_whois=?,age_years_wayback=?,content_flagged=?,safe_browsing_ok=?,blacklisted_on=?,valuation_json=?,audit_reason=?,
          check_status_json=?,marketplace_price=?,marketplace_status=?,marketplace_source=?
        WHERE run_ts=? AND domain=?`,
        [
          h.health_score,
          h.verdict_key,
          (h.available === true ? 1 : h.available === false ? 0 : null),
          h.referring_domains || 0,
          h.trust_flow || null,
          h.ref_domains ?? null,
          h.ext_backlinks ?? null,
          h.first_seen || null,
          h.snapshot_count || 0,
          (h.blacklisted_on?.length ? 1 : 0),
          val?.est_mid ?? null,
          (h.timed_out ? 1 : 0),
          val?.est_low ?? null,
          val?.est_high ?? null,
          val?.roi_low ?? null,
          val?.roi_high ?? null,
          (h.dns_resolves === true ? 1 : h.dns_resolves === false ? 0 : null),
          h.last_seen || null,
          h.whois_created || null,
          h.age_years_whois ?? null,
          h.age_years_wayback ?? null,
          (h.content_flags?.length ? 1 : 0),
          (h.safe_browsing_ok === false ? 0 : h.safe_browsing_ok === true ? 1 : null),
          (h.blacklisted_on?.length ? h.blacklisted_on.join(', ') : null),
          (val ? JSON.stringify(val) : null),

          // [REDACTED] Original structured audit-reason assembly.
          // It combined audit log headlines, negative signals, missing-check
          // explanations, status details, and score summaries.

          JSON.stringify(h.check_status || {}),
          marketplacePrice,
          marketplaceStatus,
          marketplaceSource,
          runTs,
          h.domain
        ]
      );
    }
  }

  async saveMeta(runTs, meta) {
    await this._ensure();

    _run(this._db, `
      INSERT OR REPLACE INTO run_meta(run_ts,started_at,finished_at,domains_ingested,
        domains_scored,elite_count,clean_count,flagged_count,nuked_count)
      VALUES(?,?,?,?,?,?,?,?,?)`,
      [
        runTs,
        meta.started_at,
        meta.finished_at,
        meta.domains_ingested,
        meta.domains_scored,
        meta.elite_count,
        meta.clean_count,
        meta.flagged_count,
        meta.nuked_count
      ]
    );

    await this.pruneOldRuns();
  }

  async pruneOldRuns() {
    await this._ensure();

    const days = Math.max(1, Number(C.RETENTION_DAYS) || 90);
    const cutoff = new Date();

    cutoff.setDate(cutoff.getDate() - days);

    const cutoffTs = cutoff.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const before = _get(this._db, 'SELECT COUNT(*) AS c FROM domain_runs')?.c || 0;

    _run(this._db, 'DELETE FROM domain_runs WHERE run_ts < ?', [cutoffTs]);
    _run(this._db, 'DELETE FROM run_meta WHERE run_ts < ?', [cutoffTs]);

    const after = _get(this._db, 'SELECT COUNT(*) AS c FROM domain_runs')?.c || 0;

    return {
      cutoffTs,
      deleted: before - after
    };
  }

  async timesSeen(domain) {
    await this._ensure();

    return _get(
      this._db,
      'SELECT COUNT(*) as c FROM domain_runs WHERE domain=?',
      [domain]
    )?.c || 0;
  }

  async addToWatchlist(domain, notes = '') {
    await this._ensure();

    _run(
      this._db,
      'INSERT OR REPLACE INTO watchlist VALUES(?,?,?)',
      [domain, new Date().toISOString(), notes]
    );
  }

  async getWatchlist() {
    await this._ensure();

    return _all(
      this._db,
      'SELECT * FROM watchlist ORDER BY added_ts DESC'
    );
  }

  async removeFromWatchlist(domain) {
    await this._ensure();

    _run(
      this._db,
      'DELETE FROM watchlist WHERE domain=?',
      [domain]
    );
  }

  // ── Drop-availability watch queue ─────────────────────────────────────

  async addToWatch(domain, {
    firstSeenDark,
    estDropDate,
    profitScore = null,
    lgProfit = null,
    isWinner = 0,
    isStar = 0
  }) {
    await this._ensure();

    const before = _get(
      this._db,
      'SELECT COUNT(*) AS c FROM drop_watch WHERE domain=?',
      [domain]
    )?.c || 0;

    _run(this._db, `INSERT OR IGNORE INTO drop_watch
        (domain, first_seen_dark, est_drop_date, profit_score, lg_profit, is_winner, is_star, status)
        VALUES(?,?,?,?,?,?,?,'watching')`,
      [
        domain,
        firstSeenDark,
        estDropDate,
        profitScore,
        lgProfit,
        isWinner ? 1 : 0,
        isStar ? 1 : 0
      ]
    );

    const after = _get(
      this._db,
      'SELECT COUNT(*) AS c FROM drop_watch WHERE domain=?',
      [domain]
    )?.c || 0;

    return after > before;
  }

  async recordWatchAudit(domain, {
    verdict = null,
    health = null,
    estMid = null
  }) {
    await this._ensure();

    _run(
      this._db,
      'UPDATE drop_watch SET audit_verdict=?, audit_health=?, audit_est_mid=? WHERE domain=?',
      [verdict, health, estMid, domain]
    );
  }

  async saveEvidence(domain, runTs, evidence) {
    await this._ensure();

    _run(this._db, `INSERT OR REPLACE INTO audit_evidence(domain, run_ts, captured_at, evidence)
        VALUES(?,?,?,?)`,
      [
        domain,
        runTs,
        new Date().toISOString(),
        JSON.stringify(evidence || {})
      ]
    );
  }

  async getEvidence(domain) {
    await this._ensure();

    const row = _get(
      this._db,
      'SELECT * FROM audit_evidence WHERE domain=?',
      [domain]
    );

    if (!row) return null;

    let evidence = {};

    try {
      evidence = JSON.parse(row.evidence || '{}');
    } catch {}

    return {
      domain: row.domain,
      run_ts: row.run_ts,
      captured_at: row.captured_at,
      evidence
    };
  }

  async deleteWatch(domain, reason = 'manual') {
    await this._ensure();

    const row = _get(
      this._db,
      'SELECT status FROM drop_watch WHERE domain=?',
      [domain]
    );

    if (!row || row.status === 'deleted') return false;

    _run(
      this._db,
      "UPDATE drop_watch SET status='deleted', delete_reason=?, deleted_at=? WHERE domain=?",
      [reason, new Date().toISOString(), domain]
    );

    return true;
  }

  async flagRenewal(domain, proof = {}) {
    await this._ensure();

    const row = _get(
      this._db,
      'SELECT status, renewal_flagged FROM drop_watch WHERE domain=?',
      [domain]
    );

    if (!row || row.status === 'deleted') return false;

    const proofJson = JSON.stringify({
      zone_date: proof.zoneDate ?? null,
      zone_file: proof.zoneFile ?? null,
      matched_line: proof.matchedLine ?? null,
      note: 'Reappeared in the registry dataset. Confirm before removing.'
    });

    const wasFlagged = row.renewal_flagged === 1;

    _run(
      this._db,
      'UPDATE drop_watch SET renewal_flagged=1, renewal_proof=?, renewal_flagged_at=? WHERE domain=?',
      [proofJson, new Date().toISOString(), domain]
    );

    return !wasFlagged;
  }

  async clearRenewalFlag(domain) {
    await this._ensure();

    _run(
      this._db,
      'UPDATE drop_watch SET renewal_flagged=0, renewal_proof=NULL, renewal_flagged_at=NULL WHERE domain=?',
      [domain]
    );

    return true;
  }

  async watchDueForCheck(today, leadDays, limit) {
    await this._ensure();

    const cutoff = new Date(today);
    cutoff.setDate(cutoff.getDate() + leadDays);

    const cutoffStr = cutoff.toISOString().slice(0, 10);

    return _all(this._db, `SELECT * FROM drop_watch
        WHERE status='watching' AND est_drop_date <= ?
        ORDER BY est_drop_date ASC, is_star DESC, lg_profit DESC, profit_score DESC LIMIT ?`,
      [cutoffStr, limit]
    );
  }

  async recordWatchCheck(domain, {
    checkedAt,
    available
  }) {
    await this._ensure();

    const avail = available === true ? 1 : available === false ? 0 : null;

    _run(
      this._db,
      'UPDATE drop_watch SET last_checked=?, available=? WHERE domain=?',
      [checkedAt, avail, domain]
    );

    if (available === true) {
      _run(this._db, `UPDATE drop_watch
          SET status='available', became_available=COALESCE(became_available, ?)
          WHERE domain=?`,
        [checkedAt, domain]
      );
    }
  }

  async getWatch(status = null, limit = 500) {
    await this._ensure();

    return status
      ? _all(this._db,
          'SELECT * FROM drop_watch WHERE status=? ORDER BY est_drop_date ASC, profit_score DESC LIMIT ?',
          [status, limit])
      : _all(this._db,
          'SELECT * FROM drop_watch ORDER BY est_drop_date ASC, profit_score DESC LIMIT ?',
          [limit]);
  }

  async getWatchRich(limit = 500) {
    await this._ensure();

    return _all(this._db, `
      SELECT dr.*,
             dw.domain AS domain,
             dw.status AS watch_status,
             dw.est_drop_date AS est_drop_date,
             dw.became_available AS became_available,
             COALESCE(dr.is_star, dw.is_star) AS is_star,
             COALESCE(dr.is_winner, dw.is_winner) AS is_winner,
             COALESCE(dr.lg_profit, dw.lg_profit) AS lg_profit,
             dw.audit_verdict AS audit_verdict,
             dw.audit_health AS audit_health,
             dw.renewal_flagged AS renewal_flagged,
             dw.renewal_proof AS renewal_proof,
             dw.renewal_flagged_at AS renewal_flagged_at
      FROM drop_watch dw
      LEFT JOIN domain_runs dr ON dr.domain = dw.domain
        AND dr.id = (
          SELECT id FROM domain_runs d2
          WHERE d2.domain = dw.domain
          ORDER BY run_ts DESC, id DESC
          LIMIT 1
        )
      WHERE dw.status IN ('watching','available')
      ORDER BY COALESCE(dr.is_star, dw.is_star) DESC,
               COALESCE(dr.lg_profit, dw.lg_profit) DESC
      LIMIT ?`,
      [limit]
    );
  }

  async getStarCutoffs() {
    await this._ensure();

    const rows = _all(this._db, `
      SELECT dr.health_score AS health_score, dr.est_mid AS est_mid
      FROM drop_watch dw
      LEFT JOIN domain_runs dr ON dr.domain = dw.domain
        AND dr.id = (
          SELECT id FROM domain_runs d2
          WHERE d2.domain = dw.domain
          ORDER BY run_ts DESC, id DESC
          LIMIT 1
        )
      WHERE dw.status IN ('watching','available')`,
      []
    );

    if (rows.length < 5) {
      return {
        healthP90: C.HEALTH_CLEAN_THRESHOLD,
        estMidP90: Infinity
      };
    }

    const healths = rows
      .map(r => r.health_score)
      .filter(v => v != null)
      .sort((a, b) => a - b);

    const estMids = rows
      .map(r => r.est_mid)
      .filter(v => v != null)
      .sort((a, b) => a - b);

    const pIdx = arr => Math.max(0, Math.ceil(0.9 * arr.length) - 1);

    return {
      healthP90: healths.length
        ? healths[pIdx(healths)]
        : C.HEALTH_CLEAN_THRESHOLD,

      estMidP90: estMids.length
        ? estMids[pIdx(estMids)]
        : Infinity
    };
  }

  async getRuns(limit = 50) {
    await this._ensure();

    return _all(this._db, `
      SELECT m.*,
        (SELECT COUNT(*) FROM domain_runs d WHERE d.run_ts=m.run_ts) as total_domains
      FROM run_meta m
      ORDER BY m.run_ts DESC
      LIMIT ?`,
      [limit]
    );
  }

  async getRunDomains(runTs) {
    await this._ensure();

    return _all(this._db, `
      SELECT latest.*
      FROM (SELECT DISTINCT domain FROM domain_runs WHERE run_ts = ?) base
      JOIN domain_runs latest ON latest.domain = base.domain
        AND latest.id = (
          SELECT id FROM domain_runs d2
          WHERE d2.domain = base.domain
          ORDER BY run_ts DESC, id DESC
          LIMIT 1
        )
      ORDER BY latest.profit_score DESC`,
      [runTs]
    );
  }

  async getStats() {
    await this._ensure();

    return {
      total_runs: _get(
        this._db,
        'SELECT COUNT(DISTINCT run_ts) as c FROM domain_runs'
      )?.c || 0,

      total_domains: _get(
        this._db,
        'SELECT COUNT(*) as c FROM domain_runs'
      )?.c || 0,

      elite_found: _get(
        this._db,
        "SELECT COUNT(*) as c FROM domain_runs WHERE verdict='ELITE'"
      )?.c || 0,

      avg_health: +(
        _get(
          this._db,
          'SELECT AVG(health_score) as a FROM domain_runs WHERE health_score IS NOT NULL'
        )?.a || 0
      ).toFixed(1),

      watchlist_count: _get(
        this._db,
        'SELECT COUNT(*) as c FROM watchlist'
      )?.c || 0,
    };
  }
}

let _instance = null;

function getStore() {
  if (!_instance) _instance = new ResultStore();
  return _instance;
}

module.exports = {
  ResultStore,
  getStore,
  flush
};
