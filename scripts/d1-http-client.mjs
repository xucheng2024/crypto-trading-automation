export class D1HttpDatabase {
  constructor({ accountId, databaseId, apiToken, fetcher = fetch }) {
    if (!accountId || !databaseId || !apiToken) throw new Error("Missing Cloudflare D1 credentials");
    this.url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
    this.apiToken = apiToken;
    this.fetcher = (...args) => fetcher(...args);
  }

  prepare(sql) {
    return new D1HttpStatement(this, sql);
  }

  async query(sql, params = []) {
    const response = await this.fetcher(this.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sql, params }),
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.success || !Array.isArray(payload.result) || !payload.result[0]?.success) {
      throw new Error(`Cloudflare D1 query failed: ${payload?.errors?.[0]?.message || payload?.result?.[0]?.error || response.status}`);
    }
    return payload.result[0];
  }

  async batch(statements) {
    for (const statement of statements) await statement.run();
  }
}

class D1HttpStatement {
  constructor(database, sql, params = []) {
    this.database = database;
    this.sql = sql;
    this.params = params;
  }

  bind(...params) {
    return new D1HttpStatement(this.database, this.sql, params);
  }

  async all() {
    const result = await this.database.query(this.sql, this.params);
    return { results: result.results || [], success: true, meta: result.meta || {} };
  }

  async first() {
    const { results } = await this.all();
    return results[0] || null;
  }

  async run() {
    const result = await this.database.query(this.sql, this.params);
    return { success: true, meta: result.meta || {} };
  }
}
