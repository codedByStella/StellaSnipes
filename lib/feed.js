'use strict';

const fs = require('fs');
const path = require('path');
const { BASE, env } = require('./config');

// Matches domain-like tokens (labels + TLD).
const DOMAIN_RE = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\b/gi;

// Restrict filesystem input to plain domain-list files inside an allowed root.
// The root can be configured through the environment.
const INPUT_ROOT = path.resolve(env.INPUT_DIR || BASE);
const ALLOWED_EXT = new Set(['.txt', '.csv']);

// Returns the validated absolute path, or null if the input is not allowed.
function resolveInputPath(filePath) {
  if (
    typeof filePath !== 'string' ||
    !filePath ||
    filePath.includes('\0')
  ) {
    return null;
  }

  if (!ALLOWED_EXT.has(path.extname(filePath).toLowerCase())) {
    return null;
  }

  const resolved = path.resolve(INPUT_ROOT, filePath);

  if (
    resolved !== INPUT_ROOT &&
    !resolved.startsWith(INPUT_ROOT + path.sep)
  ) {
    return null;
  }

  return resolved;
}

async function loadFromFile(filePath) {
  const found = new Set();
  const safe = resolveInputPath(filePath);

  if (
    !safe ||
    !fs.existsSync(safe) ||
    !fs.statSync(safe).isFile()
  ) {
    return found;
  }

  const text = fs.readFileSync(safe, 'utf8');

  for (const m of text.matchAll(DOMAIN_RE)) {
    found.add(m[0].toLowerCase());
  }

  return found;
}

// File-based ingestion. Returns a sorted, deduplicated domain list.
async function aggregateFeeds(filePath, log = console.log) {
  // No file input is a normal case. Avoid reporting an empty ingestion
  // as a failed operation when no file was supplied.
  if (!filePath) return [];

  const unique = new Set();

  if (!resolveInputPath(filePath)) {
    log(
      `[!] File input rejected: unsupported extension or path outside allowed root.`
    );
  } else {
    const file = await loadFromFile(filePath);

    log(`[~] File: ${file.size} domains`);

    for (const d of file) {
      unique.add(d);
    }
  }

  const list = [...unique].sort();

  log(`[+] File ingestion: unique=${list.length}`);

  return list;
}

module.exports = {
  aggregateFeeds,
  loadFromFile,
  resolveInputPath
};
