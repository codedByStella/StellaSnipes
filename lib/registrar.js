'use strict';

const { env } = require('./config');
const { fetchJson, fetchWithRetry } = require('./fetch');

class RegistrarIntegration {
  constructor() {
    this._gdHeaders = (
      env.GODADDY_API_KEY &&
      env.GODADDY_API_SECRET
    )
      ? {
          Authorization: `sso-key ${env.GODADDY_API_KEY}:${env.GODADDY_API_SECRET}`,
          Accept: 'application/json'
        }
      : null;

    this._ncReady = !!(
      env.NAMECHEAP_API_KEY &&
      env.NAMECHEAP_USERNAME &&
      env.NAMECHEAP_CLIENT_IP
    );
  }

  async _gdCheck(domain) {
    if (!this._gdHeaders) return null;

    try {
      const data = await fetchJson(
        `https://api.godaddy.com/v1/domains/available?domain=${domain}&checkType=FAST`,
        { headers: this._gdHeaders }
      );

      return data?.available ?? null;
    } catch {
      return null;
    }
  }

  async _ncCheck(domain) {
    if (!this._ncReady) return null;

    try {
      const url =
        `https://api.namecheap.com/xml.response?` +
        `ApiUser=${env.NAMECHEAP_USERNAME}` +
        `&ApiKey=${env.NAMECHEAP_API_KEY}` +
        `&UserName=${env.NAMECHEAP_USERNAME}` +
        `&Command=namecheap.domains.check` +
        `&ClientIp=${env.NAMECHEAP_CLIENT_IP}` +
        `&DomainList=${domain}`;

      const res = await fetchWithRetry(
        url,
        { timeout: 10000 }
      );

      if (!res?.ok) return null;

      const text = await res.text();

      return text.includes('Available="true"');
    } catch {
      return null;
    }
  }

  async checkAvailability(domain) {
    const [gd, nc] = await Promise.all([
      this._gdCheck(domain),
      this._ncCheck(domain)
    ]);

    const sources = [
      gd !== null
        ? `GoDaddy=${gd ? '✓' : '✗'}`
        : null,
      nc !== null
        ? `Namecheap=${nc ? '✓' : '✗'}`
        : null,
    ]
      .filter(Boolean)
      .join('  ');

    return {
      domain,
      available: !!(gd || nc),
      gd_says: gd,
      nc_says: nc,
      sources: sources || 'No registrar configured'
    };
  }

  // Purchase flow is intentionally incomplete.
  // The current request does not include the registrar's required
  // consent and contact records. A validation response requiring
  // those fields hands the user off to the registrar's checkout.

  async registerDomain(_domain) {
    return {
      success: false,
      message: 'Automated registration is disabled. Complete registration through the registrar checkout.'
    };
  }
}

module.exports = { RegistrarIntegration };
