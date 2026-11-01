'use strict';

const { DropScheduleAdvisor } = require('./scorer');
const { runPipeline } = require('./pipeline');
const runlock = require('./runlock');

class SchedulerDaemon {
  constructor() {
    this._timer   = null;
    this._fired   = new Set();   // "YYYY-MM-DD-tld" keys
    this._advisor = new DropScheduleAdvisor();
    this._running = false;
    this._ticking = false;
    this._opts    = {};
    this._log     = console.log;
    this._status  = {
      state: 'idle',
      lastFired: null,
      nextWindow: null
    };
  }

  start(opts = {}, log = console.log) {
    if (this._timer) return;

    this._opts = opts;
    this._log = log;
    this._running = true;

    log('[SCHEDULER] Daemon started.');

    this._tick();
    this._timer = setInterval(() => this._tick(), 60_000);
    this._updateStatus();
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }

    this._running = false;
    this._status.state = 'idle';
    this._log('[SCHEDULER] Daemon stopped.');
  }

  _today() {
    return new Date().toISOString().slice(0, 10);
  }

  _windowKey(tld) {
    return `${this._today()}-${tld}`;
  }

  async _tick() {
    if (this._ticking || !this._running) return;
    this._ticking = true;

    try {
      // Purge keys from previous days.
      const today = this._today();

      for (const k of this._fired) {
        if (!k.startsWith(today)) {
          this._fired.delete(k);
        }
      }

      const activeTlds = this._advisor.activeTlds();

      for (const tld of activeTlds) {
        const key = this._windowKey(tld);

        if (this._fired.has(key)) continue;

        const ts = new Date().toUTCString();

        this._log(
          `\n[SCHEDULER] .${tld} drop window active at ${ts} — firing pipeline...`
        );

        this._status = {
          state: 'running',
          lastFired: tld,
          nextWindow: this._advisor.nextWindow()
        };

        try {
          await runlock.waitForPipelineIdle();

          if (!this._running) return;

          this._fired.add(key);
          runlock.setPipelineRunning(true);
          try {
            await runPipeline(
              { ...this._opts, targetTlds: [tld] },
              this._log
            );
          } finally {
            runlock.setPipelineRunning(false);
          }
        } catch (e) {
          this._log(`[SCHEDULER] Pipeline error: ${e.message}`);
        }

        this._status.state = 'watching';
      }

      this._updateStatus();
    } finally {
      this._ticking = false;
    }
  }

  _updateStatus() {
    const next = this._advisor.nextWindow();

    this._status = {
      state: this._timer
        ? (this._status.state === 'running' ? 'running' : 'watching')
        : 'idle',
      lastFired: this._status.lastFired,
      nextWindow: next,
      activeTlds: this._advisor.activeTlds(),
    };
  }

  getStatus() {
    this._updateStatus();
    return {
      ...this._status,
      running: !!this._timer
    };
  }

  allWindows() {
    return this._advisor.allWindows();
  }
}

// Singleton
let _instance = null;

function getDaemon() {
  if (!_instance) _instance = new SchedulerDaemon();
  return _instance;
}

module.exports = {
  SchedulerDaemon,
  getDaemon
};
