export interface Env {
  /**
   * LTA DataMall account key, sent as the `AccountKey` header on every
   * DataMall call. Set via `wrangler secret put LTA_ACCOUNT_KEY`. Unlike
   * OneMap's email/password, this is a static key — nothing to exchange or
   * cache.
   */
  LTA_ACCOUNT_KEY: string;
  /**
   * Required shared secret gating this Worker's MCP endpoint. Every
   * request must send `Authorization: Bearer <MCP_SHARED_SECRET>`; requests
   * are rejected if this isn't configured at all (fail closed, not open).
   */
  MCP_SHARED_SECRET: string;
}
