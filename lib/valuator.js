'use strict';

const fs = require('fs');
const path = require('path');
const { C, BASE } = require('./config');

const POP_FILE = path.join(BASE, 'registries', 'leadgen', 'geography', 'city_population.txt');

// Estimates monthly lead-generation recoup as a range, rather than a domain resale price.
// The model uses a population-derived search proxy, estimated capture, conversion,
// billable-call adjustment, and vertical-specific lead value.
//
// [REDACTED] Original commercial assumptions, calibration notes, and model rationale.

class Module3Valuator {
  constructor() {
    this._pop = null;
  }

  _population() {
    if (this._pop) return this._pop;

    this._pop = new Map();

    try {
      for (let line of fs.readFileSync(POP_FILE, 'utf8').split('\n')) {
        line = line.trim();

        if (!line || line.startsWith('#')) continue;

        const [city, pop] = line.split(/[|,\s]+/);
        const n = parseInt(pop, 10);

        if (city && n > 0) {
          this._pop.set(city.toLowerCase(), n);
        }
      }
    } catch {}

    return this._pop;
  }

  _tier(cpc) {
    const m = cpc == null ? C.CPC_MULT_NO_INDUSTRY : cpc;

    // [REDACTED] Proprietary commercial tier boundaries.
    if (m >= C.CPC_MULT_PREMIUM) return 'premium';
    if (m >= C.CPC_MULT_HIGH) return 'high';
    if (m >= C.CPC_MULT_MEDIUM) return 'medium';
    if (m >= C.CPC_MULT_LOW) return 'low';

    return 'none';
  }

  // Resolve city names against optional state-level population overrides.
  // If no state-qualified match exists, fall back to the base city entry and
  // expose ambiguity rather than presenting an uncertain match as confirmed.
  _bestCity(m1) {
    const mods = (m1 && m1.lg_mods) || [];

    const cities = mods
      .map(x => {
        const g = /Micro-Geo \(([^)]+)\)/.exec(x);
        return g ? g[1].toLowerCase() : null;
      })
      .filter(Boolean);

    const states = mods
      .map(x => {
        const g = /Macro-Geo \(([^)]+)\)/.exec(x);
        return g ? g[1].toLowerCase() : null;
      })
      .filter(Boolean);

    const pop = this._population();

    for (const c of cities) {
      for (const s of states) {
        const p = pop.get(`${c}@${s}`);

        if (p != null) {
          return {
            city: c,
            population: p,
            known: true,
            state: s,
            ambiguous: false
          };
        }
      }
    }

    let best = null;
    let bestPop = -1;

    for (const c of cities) {
      const p = pop.get(c);

      if (p != null && p > bestPop) {
        best = c;
        bestPop = p;
      }
    }

    if (best) {
      const isKnownCollision = [...pop.keys()]
        .some(k => k.startsWith(`${best}@`));

      return {
        city: best,
        population: bestPop,
        known: true,
        ambiguous: isKnownCollision
      };
    }

    if (cities.length) {
      return {
        city: cities[0],
        population: C.DEFAULT_CITY_POP,
        known: false,
        ambiguous: false
      };
    }

    return {
      city: null,
      population: C.DEFAULT_CITY_POP,
      known: false,
      ambiguous: false
    };
  }

  async appraise(domain, health = null, m1 = null) {
    const tld = domain.split('.').pop().toLowerCase();

    const regCost = C.TLD_REG_COST[tld] != null
      ? C.TLD_REG_COST[tld]
      : C.TLD_REG_COST_DEF;

    const tier = this._tier(m1 && m1.cpc_mult);

    const leadValue = C.LEAD_VALUE_BY_TIER[tier] != null
      ? C.LEAD_VALUE_BY_TIER[tier]
      : C.LEAD_VALUE_BY_TIER.none;

    const conv = C.CALL_CONV_BY_TIER[tier] != null
      ? C.CALL_CONV_BY_TIER[tier]
      : C.CALL_CONV_BY_TIER.none;

    const { city, population, known, ambiguous, state } = this._bestCity(m1);

    // [REDACTED] Population adjustment and commercial calibration parameters.
    const cappedPopulation = Math.min(
      population,
      C.SEARCH_POP_CAP ?? population
    );

    const monthlySearches = Math.round(
      cappedPopulation * C.SEARCH_PER_CAPITA
    );

    const junk = C.JUNK_CALL_DISCOUNT != null
      ? C.JUNK_CALL_DISCOUNT
      : 0.5;

    // Produce low, middle, and high scenarios using separate capture assumptions.
    // [REDACTED] Exact scenario defaults and calibration values.
    const ctrLow = C.RANK_CAPTURE_CTR_LOW;
    const ctrMid = C.RANK_CAPTURE_CTR;
    const ctrHigh = C.RANK_CAPTURE_CTR_HIGH;

    const scenario = (ctr) => {
      const visitors = monthlySearches * ctr;
      const rawCalls = visitors * conv;
      const billableCalls = rawCalls * junk;

      return {
        ctr,
        est_visitors: Math.round(visitors),
        est_calls_raw: +rawCalls.toFixed(1),
        est_calls_billable: +billableCalls.toFixed(1),
        recoup: Math.round(billableCalls * leadValue),
      };
    };

    const lo = scenario(ctrLow);
    const mid = scenario(ctrMid);
    const hi = scenario(ctrHigh);

    const inputs = {
      city,
      population,
      population_known: known,
      tier,
      monthly_searches: monthlySearches,
      est_visitors: mid.est_visitors,
      call_conv_rate: conv,
      est_calls: mid.est_calls_raw,
      est_calls_billable: mid.est_calls_billable,
      lead_value: leadValue,
      population_ambiguous: !!ambiguous,
      population_capped: population > cappedPopulation,
    };

    // Expose the inputs used to produce the estimate.
    const assumptions = {
      search_per_capita: C.SEARCH_PER_CAPITA,
      rank_capture_ctr: {
        low: ctrLow,
        mid: ctrMid,
        high: ctrHigh
      },
      call_conv_rate: conv,
      junk_call_discount: junk,
      lead_value: leadValue,
      population,
      population_known: known,
      population_ambiguous: !!ambiguous,
      population_capped: population > cappedPopulation,
      visitors_source: 'POPULATION_PROXY',

      note:
        'Visitors are derived from a population proxy, not measured keyword search volume. ' +
        'This is an order-of-magnitude estimate; accurate search volume requires an external ' +
        'keyword data source.'
        + (known
          ? ''
          : ' Population itself is a default fallback because the city was not found in the registry.')
        + (state
          ? ` Population resolved using the state named in the domain (${city}, ${state}).`
          : '')
        + (ambiguous
          ? ' The city name has multiple state-level matches. No state was resolved, so the base city entry was used.'
          : '')
        + (population > cappedPopulation
          ? ' The population input was capped before calculating the estimate.'
          : ''),
    };

    return {
      domain,
      model: 'monthly_recoup',
      est_monthly_recoup: mid.recoup,
      recoup_range: {
        low: lo.recoup,
        mid: mid.recoup,
        high: hi.recoup
      },
      is_estimate: true,
      inputs,
      assumptions,
      reg_cost: regCost,
      basis:
        'Lead-gen recoup range (population proxy x capture-CTR band x conversion ' +
        'x billable discount x lead value)',
      confidence: known ? (health ? 'medium' : 'low') : 'low',

      // Backward-compatible fields used by existing result and watchlist consumers.
      est_mid: mid.recoup,
      est_low: lo.recoup,
      est_high: hi.recoup,
      roi_low: null,
      roi_high: null,
    };
  }
}

module.exports = { Module3Valuator };
