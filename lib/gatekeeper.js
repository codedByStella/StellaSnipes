'use strict';

const { getRegistry } = require('./registry');

class GatekeeperFilter {
  constructor() {
    const reg = getRegistry();

    this.allowedTlds = reg.getTldSet();

    // [REDACTED] Original production exclusion-pattern registry mappings.
    this._toxic = reg.getPattern('registry_rule_1');
    this._trademark = reg.getPattern('registry_rule_2');
    this._blacklist = reg.getPattern('registry_rule_3');
    this._bots = reg.getPattern('registry_rule_4');
    this._anomaly = reg.getPattern('registry_rule_5');
  }

  _hit(rx, text) {
    return rx && rx.test(text);
  }

  // Content/media-oriented name detection.
  _isContentSite(core) {
    return /blog|news|press|media|magazine|journal|forum|community|directory|wiki|hub|portal|portfolio|digest/i.test(core);
  }

  // Detect likely malformed or low-quality character sequences.
  _likelyTypo(core) {
    if (/(.)\1{2,}/.test(core)) return true;
    if (/[aeiou]{4,}/i.test(core)) return true;
    return false;
  }

  purge(domains, targetTlds = null, log = console.log) {
    const clean = [];

    let tldNuked = 0;
    let tldFiltered = 0;
    let nuked = 0;
    let patternNuked = 0;

    for (const d of domains) {
      const core = d.split('.')[0];
      const tld = d.includes('.') ? d.split('.').pop() : '';

      if (targetTlds && !targetTlds.includes(tld)) {
        tldFiltered++;
        continue;
      }

      if (this.allowedTlds.size && !this.allowedTlds.has(tld)) {
        tldNuked++;
        continue;
      }

      // [REDACTED] Original proprietary name-shape rejection rule
      // and its associated classification rationale.

      if (this._hit(this._toxic, core)) {
        nuked++;
        continue;
      }

      if (this._hit(this._trademark, core)) {
        nuked++;
        continue;
      }

      if (this._hit(this._blacklist, core)) {
        nuked++;
        continue;
      }

      if (this._hit(this._bots, core)) {
        nuked++;
        continue;
      }

      if (this._hit(this._anomaly, core)) {
        nuked++;
        continue;
      }

      if (this._likelyTypo(core)) {
        nuked++;
        continue;
      }

      if (this._isContentSite(core)) {
        nuked++;
        continue;
      }

      clean.push(d);
    }

    const targeted = targetTlds
      ? `  tld_filtered=${tldFiltered}`
      : '';

    log(
      `[+] Gatekeeper: tld_nuked=${tldNuked}` +
      `${targeted}  pattern_nuked=${patternNuked}` +
      `  nuked=${nuked}  surviving=${clean.length}`
    );

    return clean;
  }
}

module.exports = { GatekeeperFilter };
