export interface Env {
  /**
   * LTA DataMall account key, sent as the `AccountKey` header on every
   * DataMall call. Set via `wrangler secret put LTA_ACCOUNT_KEY`. Unlike
   * OneMap's email/password, this is a static key — nothing to exchange or
   * cache.
   */
  LTA_ACCOUNT_KEY: string;
}
