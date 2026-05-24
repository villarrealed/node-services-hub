/**
 * Salesforce REST API client with OAuth refresh token authentication.
 * 
 * Port of salesforce_client.py — uses axios for HTTP, auto-refreshes tokens on 401.
 */

import axios from 'axios';

class SalesforceClient {
  constructor() {
    this.loginUrl = process.env.SF_LOGIN_URL || 'https://login.salesforce.com';
    this.instanceUrl = process.env.SF_INSTANCE_URL || '';
    this.clientId = process.env.SF_CLIENT_ID || '';
    this.clientSecret = process.env.SF_CLIENT_SECRET || '';
    this.refreshToken = process.env.SF_REFRESH_TOKEN || '';
    this.apiVersion = process.env.SF_API_VERSION || 'v62.0';
    this.accessToken = null;

    if (!this.clientId || !this.clientSecret || !this.refreshToken) {
      console.error('[salesforce-client] ⚠️  Missing required env vars: SF_CLIENT_ID, SF_CLIENT_SECRET, SF_REFRESH_TOKEN');
    }
  }

  /**
   * Exchange the refresh token for a new access token.
   */
  async _refreshAccessToken() {
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: this.refreshToken,
    });

    const response = await axios.post(
      `${this.loginUrl}/services/oauth2/token`,
      params.toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }
    );

    this.accessToken = response.data.access_token;
    if (response.data.instance_url) {
      this.instanceUrl = response.data.instance_url;
    }
    console.log('[salesforce-client] Access token refreshed successfully');
  }

  /**
   * Make an authenticated Salesforce API request.
   * Automatically refreshes the access token on a 401 response.
   */
  async _request(method, path, opts = {}) {
    if (!this.accessToken) {
      await this._refreshAccessToken();
    }

    const url = `${this.instanceUrl}/services/data/${this.apiVersion}${path}`;
    const { headers: optHeaders, ...restOpts } = opts;
    const headers = {
      ...optHeaders,
      Authorization: `Bearer ${this.accessToken}`,
    };

    try {
      const response = await axios({
        method,
        url,
        ...restOpts,
        headers,
      });
      return response.data;
    } catch (error) {
      // Retry once with a fresh token on 401
      if (error.response?.status === 401) {
        console.log('[salesforce-client] Access token expired, refreshing...');
        await this._refreshAccessToken();
        const retryHeaders = {
          ...optHeaders,
          Authorization: `Bearer ${this.accessToken}`,
        };
        const retryResponse = await axios({
          method,
          url,
          ...restOpts,
          headers: retryHeaders,
        });
        return retryResponse.data;
      }
      throw error;
    }
  }

  /**
   * Execute a SOQL query and return the list of records.
   */
  async query(soql) {
    const data = await this._request('GET', '/query', {
      params: { q: soql },
    });
    return data.records || [];
  }

  /**
   * Retrieve a single record by sObject type and record ID.
   */
  async getRecord(sobject, recordId, fields = []) {
    let path = `/sobjects/${sobject}/${recordId}`;
    if (fields.length > 0) {
      path += `?fields=${fields.join(',')}`; 
    }
    return await this._request('GET', path);
  }

  /**
   * Create a new record and return the API response (id, success, errors).
   */
  async createRecord(sobject, data) {
    return await this._request('POST', `/sobjects/${sobject}`, {
      data,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// Export singleton instance
export default new SalesforceClient();
