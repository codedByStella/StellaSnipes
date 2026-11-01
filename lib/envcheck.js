'use strict';

// ── Run-location / cloud-sync self-check ──────────────────────────────────

const fs = require('fs');
const path = require('path');

// Folder-name markers for common cloud-sync clients.
const SYNC_MARKERS = [
  /onedrive/i,
  /dropbox/i,
  /google[ \_-]?drive/i,
  /[\\/ ]box[\\/ ]/i,
  /icloud/i,
  /pcloud/i,
  /creative cloud files/i,
  /megasync/i,
];

// Return the sync-client name if `p` looks like it sits inside one,
// otherwise null.
function syncMarkerFor(p) {
  if (!p) return null;

  for (const rx of SYNC_MARKERS) {
    const m = rx.exec(p);
    if (m) return m[0];
  }

  return null;
}

// Resolve the real absolute path, following Windows junctions and
// symlinks. realpathSync exposes targets that are not apparent from
// the declared path.
function realDir(dir) {
  try {
    return fs.realpathSync.native(dir);
  } catch {
    try {
      return fs.realpathSync(dir);
    } catch {
      return path.resolve(dir);
    }
  }
}

// Classify a run location.
// Pure with respect to path strings; realpath does touch the filesystem.
//
// Returns:
// { declared, real, viaJunction, synced, marker }
function classifyLocation(dir) {
  const declared = path.resolve(dir);
  const real = realDir(declared);

  const viaJunction =
    real.toLowerCase() !== declared.toLowerCase();

  const marker =
    syncMarkerFor(declared) || syncMarkerFor(real);

  return {
    declared,
    real,
    viaJunction,
    synced: !!marker,
    marker: marker || null
  };
}

// Generate human-readable diagnosis lines without side effects.
function diagnosisLines(c, corruptedFiles = []) {
  const bar = '!'.repeat(72);
  const out = [];

  out.push(
    `[startup] running from: ${c.declared}` +
    (c.viaJunction ? `  →(junction)→  ${c.real}` : '')
  );

  if (c.synced) {
    out.push('', bar);
    out.push(
      `[startup] ⚠ Location appears to be inside a cloud-sync folder ("${c.marker}").`
    );

    if (c.viaJunction) {
      out.push(
        `[startup]   The declared path resolves through a junction or symlink to: ${c.real}`
      );
    }

    // [REDACTED] Original incident-specific corruption explanation,
    // personal filesystem paths, and remediation commands.

    out.push(bar, '');

  } else if (corruptedFiles.length) {
    out.push('', bar);

    out.push(
      '[startup] ⚠ Files were reported corrupted, but this path does not match a known sync folder.'
    );

    out.push(
      '[startup]   A parent directory or filesystem link may still require inspection.'
    );

    out.push(`[startup]   Resolved path: ${c.real}`);

    // [REDACTED] Original Windows-specific troubleshooting commands.

    out.push(bar, '');

  } else {
    out.push(
      '[startup] ✓ Run location is not inside a known cloud-sync folder.'
    );
  }

  return out;
}

module.exports = {
  SYNC_MARKERS,
  syncMarkerFor,
  realDir,
  classifyLocation,
  diagnosisLines
};
