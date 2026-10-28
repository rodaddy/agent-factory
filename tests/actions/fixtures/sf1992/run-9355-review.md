1. **P1 — Pi estimates still feed billed spend** — `fleet/paperclip-patches/2026.916.1/07-usage-accounting-provenance.patch:242`  
   `accountingMetadata()` labels Pi’s CLI price-table cost as an API-equivalent estimate and sets `billedCostUsd` to `null`, but the ledger path still calculates `additionalCostCents` from `resolveCacheAdjustedCostUsd(result)`. The adapter continues returning that estimate in `result.costUsd`, so the new provenance metadata does not prevent estimated costs from becoming billed spend.  
   **Fix:** Calculate Pi ledger charges from the accounting layer’s billed-cost value, retaining unknown billed cost separately from API-equivalent estimates.

2. **P2 — Mixed-model usage is attributed to the configured model’s family** — `fleet/paperclip-patches/2026.916.1/07-usage-accounting-provenance.patch:213`  
   When the collector detects multiple models, execution replaces `"mixed"` with the configured model. `accountingMetadata()` then derives a single provider family from that replacement and assigns all aggregated usage to that provider, even when `parsedModel` and `transportProvider` indicate mixed usage.  
   **Fix:** Make provider-family attribution respect `parsedModel === "mixed"` and retain mixed/unknown attribution unless usage is split by model.

verdict: fix-first
