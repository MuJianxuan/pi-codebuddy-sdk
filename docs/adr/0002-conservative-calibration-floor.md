# ADR 0002: Use the conservative calibration floor for registration

## Status

Accepted

## Decision

The SDK records three context-window metrics for each model and runtime environment:

- `floor`: the smallest observed usable window;
- `latest`: the most recent observation;
- `max`: the largest observation seen.

Pi model registration and live provider refreshes use `floor`. A larger later observation may improve diagnostics (`latest`/`max`) but must not raise a previously proven conservative bound.

Each observation is committed with a cross-process lock on a stable `.lock` path, a fresh temporary file, `fsync`, and atomic rename. The transaction rereads the newest cache while holding the lock, so concurrent writers cannot lose records. If persistence fails, the runtime may only lower its in-memory window and retries the observation later.

## Rationale

Pi uses the registered context window when deciding compaction and served-window metadata. Advertising a larger window than the smallest proven entitlement can cause an avoidable context overflow. Keeping `latest` and `max` separately preserves observability without turning optimistic observations into an unsafe registration value.

## Consequences

Historical malformed records are isolated and ignored. The cache remains a diagnostic artifact; the safety-critical value is the matching environment's `floor`.
