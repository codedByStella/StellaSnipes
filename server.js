'use strict';

// ── Boot self-check ────────────────────────────────────────────────────────
// Checks library files for null-byte corruption and verifies that each file
// can be parsed before the application starts.

(function bootSelfCheck() {
  const fs = require('fs'), path = require('path'), vm = require('vm');
  const libDir = path.join(__dirname, 'lib');

  for (const f of fs.readdirSync(libDir).filter(n => n.endsWith('.js'))) {
    const fp = path.join(libDir, f);
    let raw = fs.readFileSync(fp);

    if (raw.includes(0)) {
      console.error(`[startup] FATAL: lib/${f} contains null-byte corruption. Refusing to modify source files or boot.`);
      process.exit(1);
    }

    try {
      new vm.Script(raw.toString('utf8'), { filename: fp });
    } catch (e) {
      const bar = '!'.repeat(72);

      console.error('\n' + bar);
      console.error(`[startup] FATAL: lib/${f} is corrupt/truncated — ${String(e.message).split('\n')[0]}`);
      console.error(`[startup] Refusing to boot with invalid source.`);
      console.error(bar + '\n');

      // [REDACTED] Original local environment and filesystem diagnosis.
      process.exit(1);
    }
  }

  console.log('[startup] Library source checks passed.');
})();

const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

const { env, saveEnv, C } = require('./lib/config');
const { runPipeline } = require('./lib/pipeline');
const { getDaemon } = require('./lib/scheduler');
const { getStore } = require('./lib/store');
const { RegistrarIntegration } = require('./lib/registrar');
const { Module3Valuator } = require('./lib/valuator');
const { DropScheduleAdvisor } = require('./lib/scorer');
const runlock = require('./lib/runlock');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  verifyClient: ({ origin }) =>
    !origin ||
    origin === `http://127.0.0.1:${PORT}` ||
    origin === `http://localhost:${PORT}`
});
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('PORT must be a valid TCP port between 1 and 65535.');
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Reject cross-origin browser requests to the local control API.
app.use('/api', (req, res, next) => {
  const origin = req.get('origin');

  if (
    origin &&
    origin !== `http://127.0.0.1:${PORT}` &&
    origin !== `http://localhost:${PORT}`
  ) {
    return res.status(403).json({ error: 'Cross-origin requests are not allowed.' });
  }

  next();
});

// ── WebSocket broadcast ─────────────────────────────────────────────────────

function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload, ts: Date.now() });

  wss.clients.forEach(c => {
    if (c.readyState === 1) c.send(msg);
  });
}

function makeLogger() {
  return msg => {
    const ts = new Date().toTimeString().slice(0, 8);
    const line = `[${ts}] ${msg}`;

    console.log(line);
    broadcast('log', line);
  };
}

// ── Routes ──────────────────────────────────────────────────────────────────

// POST /api/run — start a pipeline run.

app.post('/api/run', async (req, res) => {
  if (runlock.isPipelineRunning()) {
    return res.status(409).json({ error: 'Run already in progress.' });
  }

  runlock.setPipelineRunning(true);
  broadcast('run_state', { running: true });
  res.json({ started: true });

  const log = makeLogger();

  try {
    const result = await runPipeline(req.body || {}, log);

    broadcast('run_complete', {
      runTs: result?.runTs,
      elite: result?.elite?.length ?? 0,
      clean: result?.clean?.length ?? 0,
      flagged: result?.flagged?.length ?? 0,
      nuked: result?.nuked?.length ?? 0,
    });
  } catch (e) {
    broadcast('log', `[!] Pipeline error: ${e.message}`);
    broadcast('run_error', { message: e.message });
  } finally {
    runlock.setPipelineRunning(false);
    broadcast('run_state', { running: false });
  }
});

// GET /api/run/status

app.get('/api/run/status', (_req, res) => res.json({
  running: runlock.isPipelineRunning(),
  bootRefreshRunning: runlock.isBootRefreshRunning(),
}));

// GET /api/stats

app.get('/api/stats', async (_req, res) => {
  try {
    res.json(await getStore().getStats());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/runs

app.get('/api/runs', async (_req, res) => {
  try {
    res.json(await getStore().getRuns());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/runs/:ts

app.get('/api/runs/:ts', async (req, res) => {
  try {
    res.json(await getStore().getRunDomains(req.params.ts));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/watchlist

app.get('/api/watchlist', async (_req, res) => {
  try {
    res.json(await getStore().getWatchlist());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/watchlist

app.post('/api/watchlist', async (req, res) => {
  try {
    await getStore().addToWatchlist(req.body.domain, req.body.notes || '');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/watchlist/:domain

app.delete('/api/watchlist/:domain', async (req, res) => {
  try {
    await getStore().removeFromWatchlist(
      decodeURIComponent(req.params.domain)
    );

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Automated drop-watch queue ──────────────────────────────────────────────

// GET /api/watch

app.get('/api/watch', async (_req, res) => {
  try {
    const store = getStore();

    res.json({
      watching: await store.getWatch('watching', 1000),
      available: await store.getWatch('available', 1000),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/watch/:domain

app.delete('/api/watch/:domain', async (req, res) => {
  try {
    const removed = await getStore().deleteWatch(
      decodeURIComponent(req.params.domain),
      'manual (UI)'
    );

    res.json({ ok: true, removed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/watch/:domain/keep

app.post('/api/watch/:domain/keep', async (req, res) => {
  try {
    await getStore().clearRenewalFlag(
      decodeURIComponent(req.params.domain)
    );

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/watch/rich

app.get('/api/watch/rich', async (_req, res) => {
  try {
    res.json(await getStore().getWatchRich(1000));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/watch/add

app.post('/api/watch/add', async (req, res) => {
  try {
    const domain = String(req.body.domain || '').trim().toLowerCase();

    if (!domain) {
      return res.status(400).json({ error: 'domain required' });
    }

    const { enqueueExpirations } = require('./lib/dropwatch');

    await enqueueExpirations(getStore(), [
      { domain, profit_score: null, is_winner: 1 }
    ]);

    const { reauditOne } = require('./lib/pipeline');
    const r = await reauditOne(domain);

    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/evidence/:domain

app.get('/api/evidence/:domain', async (req, res) => {
  try {
    const ev = await getStore().getEvidence(
      decodeURIComponent(req.params.domain)
    );

    res.json(
      ev || {
        domain: decodeURIComponent(req.params.domain),
        evidence: null
      }
    );
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/reaudit/:domain

app.post('/api/reaudit/:domain', async (req, res) => {
  try {
    const { reauditOne } = require('./lib/pipeline');

    res.json(
      await reauditOne(decodeURIComponent(req.params.domain))
    );
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/watch/reaudit-all

app.post('/api/watch/reaudit-all', async (req, res) => {
  try {
    const { refreshWatchAudits } = require('./lib/pipeline');
    const n = await refreshWatchAudits(() => {});

    res.json({ refreshed: n });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Scheduler ──────────────────────────────────────────────────────────────

// GET /api/scheduler/status

app.get('/api/scheduler/status', (_req, res) => {
  res.json(getDaemon().getStatus());
});

// GET /api/scheduler/windows

app.get('/api/scheduler/windows', (_req, res) => {
  const activeTlds = new Set(
    (env.CZDS_TLDS || C.CZDS_TLDS_DEFAULT)
      .split(',')
      .map(t => t.trim())
  );

  res.json(
    getDaemon().allWindows().filter(w => activeTlds.has(w.tld))
  );
});

// POST /api/scheduler/start

app.post('/api/scheduler/start', (req, res) => {
  getDaemon().start(req.body || {}, makeLogger());

  broadcast('scheduler_state', getDaemon().getStatus());
  res.json({ ok: true });
});

// POST /api/scheduler/stop

app.post('/api/scheduler/stop', (_req, res) => {
  getDaemon().stop();

  broadcast('scheduler_state', getDaemon().getStatus());
  res.json({ ok: true });
});

// GET /api/dropwindows

app.get('/api/dropwindows', (_req, res) => {
  const activeTlds = new Set(
    (env.CZDS_TLDS || C.CZDS_TLDS_DEFAULT)
      .split(',')
      .map(t => t.trim())
  );

  const advisor = new DropScheduleAdvisor();

  res.json(
    advisor.allWindows().filter(w => activeTlds.has(w.tld))
  );
});

// ── Settings ────────────────────────────────────────────────────────────────

// GET /api/settings

app.get('/api/settings', (_req, res) => {
  const mask = v => v ? '****' : '';

  res.json({
    CZDS_USERNAME: '',
    CZDS_PASSWORD: mask(env.CZDS_PASSWORD),
    CZDS_TLDS: env.CZDS_TLDS || C.CZDS_TLDS_DEFAULT,

    GOOGLE_SAFE_BROWSING_API_KEY: mask(env.GOOGLE_SAFE_BROWSING_API_KEY),
    MAJESTIC_API_KEY: mask(env.MAJESTIC_API_KEY),

    GODADDY_API_KEY: mask(env.GODADDY_API_KEY),
    GODADDY_API_SECRET: mask(env.GODADDY_API_SECRET),

    NAMECHEAP_API_KEY: mask(env.NAMECHEAP_API_KEY),
    NAMECHEAP_USERNAME: '',
    NAMECHEAP_CLIENT_IP: '',

    // [REDACTED] Optional archive-service authentication settings.
    ARCHIVE_ORG_S3_ACCESS_KEY: mask(env.ARCHIVE_ORG_S3_ACCESS_KEY),
    ARCHIVE_ORG_S3_SECRET_KEY: mask(env.ARCHIVE_ORG_S3_SECRET_KEY),

    SMTP_HOST: env.SMTP_HOST || 'smtp.gmail.com',
    SMTP_PORT: env.SMTP_PORT || '587',
    SMTP_USER: '',
    SMTP_PASS: mask(env.SMTP_PASS),
    ALERT_TO: '',

    WHOIS_PRIVACY: env.WHOIS_PRIVACY ?? 'true',

    _configured: {
      czds: !!(env.CZDS_USERNAME && env.CZDS_PASSWORD),
      safebrowsing: !!env.GOOGLE_SAFE_BROWSING_API_KEY,
      majestic: !!env.MAJESTIC_API_KEY,
      godaddy: !!(env.GODADDY_API_KEY && env.GODADDY_API_SECRET),
      namecheap: !!(env.NAMECHEAP_API_KEY && env.NAMECHEAP_USERNAME),
      email: !!(env.SMTP_USER && env.SMTP_PASS && env.ALERT_TO),
    }
  });
});

// POST /api/settings
// Only allowlisted settings can be written to the environment file.

const SETTINGS_KEYS = new Set([
  'CZDS_USERNAME',
  'CZDS_PASSWORD',
  'CZDS_TLDS',

  'GOOGLE_SAFE_BROWSING_API_KEY',
  'MAJESTIC_API_KEY',

  'GODADDY_API_KEY',
  'GODADDY_API_SECRET',

  'NAMECHEAP_API_KEY',
  'NAMECHEAP_USERNAME',
  'NAMECHEAP_CLIENT_IP',

  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'ALERT_TO',

  'WHOIS_PRIVACY',

  'ARCHIVE_ORG_S3_ACCESS_KEY',
  'ARCHIVE_ORG_S3_SECRET_KEY',
]);

app.post('/api/settings', (req, res) => {
  try {
    const updates = {};

    for (const [k, v] of Object.entries(req.body)) {
      if (!SETTINGS_KEYS.has(k)) continue;

      if (typeof v === 'string' && v && !v.includes('****')) {
        updates[k] = v;
      }
    }

    saveEnv(updates);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Valuation ───────────────────────────────────────────────────────────────

// POST /api/appraise

app.post('/api/appraise', async (req, res) => {
  try {
    const { domain } = req.body;

    if (!domain) {
      return res.status(400).json({ error: 'domain required' });
    }

    const val = await new Module3Valuator().appraise(domain);
    res.json(val);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Registrar integration ───────────────────────────────────────────────────

// POST /api/availability

app.post('/api/availability', async (req, res) => {
  try {
    const reg = new RegistrarIntegration();

    res.json(
      await reg.checkAvailability(req.body.domain)
    );
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/register

app.post('/api/register', async (_req, res) => {
  res.status(410).json({
    success: false,
    message: 'Automated registration is disabled. Complete the purchase through the registrar checkout.'
  });
});

// ── Start ───────────────────────────────────────────────────────────────────

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`  StellaSnipes running at http://127.0.0.1:${PORT}`);
  console.log(`${'='.repeat(50)}\n`);

  // Auto-open browser on Windows.
  try {
    require('child_process').exec(`start http://127.0.0.1:${PORT}`);
  } catch {}

  // Refresh audited data for the watch queue during startup.
  (async () => {
    runlock.setBootRefreshRunning(true);

    try {
      const { refreshWatchAudits } = require('./lib/pipeline');
      await refreshWatchAudits(makeLogger());
    } catch (e) {
      console.error('[boot] watch refresh failed:', e.message);
    } finally {
      runlock.setBootRefreshRunning(false);
    }
  })();
});
