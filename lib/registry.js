'use strict';

const fs = require('fs');
const { REGISTRY_FILES } = require('./config');

class RegistryLoader {
  constructor() {
    this._sets     = {};
    this._patterns = {};
    this._load();
    this._compile();
  }

  _load() {
    for (const [name, filePath] of Object.entries(REGISTRY_FILES)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf8');

        const tokens = new Set(
          raw.replace(/\n/g, '|').split('|')
            .map(t => t.trim().toLowerCase())
            .filter(Boolean)
        );

        this._sets[name] = tokens;
      } catch {
        this._sets[name] = new Set();
      }
    }
  }

  // Full-word substring matching skips short tokens to reduce
  // false positives. Short acronyms are covered by compound entries
  // in the source registries.

  static MIN_MATCH_LEN = 5;

  _compile() {
    for (const [name, tokens] of Object.entries(this._sets)) {
      if (!tokens.size) {
        this._patterns[name] = null;
        continue;
      }

      const eligible = [
        ...tokens
      ].filter(t => t.length >= (name === 'toxic_waste' ? 4 : RegistryLoader.MIN_MATCH_LEN));

      if (!eligible.length) {
        this._patterns[name] = null;
        continue;
      }

      const sorted = eligible.sort((a, b) => b.length - a.length);

      try {
        this._patterns[name] = new RegExp(
          '(' +
            sorted.map(t =>
              t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            ).join('|') +
          ')',
          'i'
        );
      } catch {
        this._patterns[name] = null;
      }
    }
  }

  getSet(name) {
    return this._sets[name] || new Set();
  }

  getPattern(name) {
    return this._patterns[name] || null;
  }

  getTldSet() {
    return new Set(
      [...this.getSet('tld_tiers')]
        .filter(t => /^[a-z0-9]{2,10}$/.test(t))
    );
  }

  findAll(name, text) {
    const rx = this.getPattern(name);
    if (!rx) return [];

    const global = new RegExp(rx.source, 'gi');

    return [...text.matchAll(global)]
      .map(m => m[0].toLowerCase());
  }
}

// Singleton
let _instance = null;

function getRegistry() {
  if (!_instance) _instance = new RegistryLoader();
  return _instance;
}

module.exports = {
  RegistryLoader,
  getRegistry
};
