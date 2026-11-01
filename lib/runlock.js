'use strict';

// Shared state coordinates the background watch refresh and manual pipeline
// runs without introducing a circular dependency between their callers.
//
// Manual pipeline runs take priority. The background refresh pauses at its
// per-domain boundary while a manual run is active, then resumes afterward.

let _pipelineRunning = false;
let _bootRefreshRunning = false;

function setPipelineRunning(v) {
  _pipelineRunning = !!v;
}

function isPipelineRunning() {
  return _pipelineRunning;
}

function setBootRefreshRunning(v) {
  _bootRefreshRunning = !!v;
}

function isBootRefreshRunning() {
  return _bootRefreshRunning;
}

// Resolves immediately when no manual run is active.
// Otherwise waits until the current run finishes.

async function waitForPipelineIdle(pollMs = 500) {
  while (_pipelineRunning) {
    await new Promise(r => setTimeout(r, pollMs));
  }
}

module.exports = {
  setPipelineRunning,
  isPipelineRunning,
  setBootRefreshRunning,
  isBootRefreshRunning,
  waitForPipelineIdle,
};
