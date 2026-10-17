# Async reference

Load this file only when the diff touches retries, queues, locks, or other concurrency and ordering paths. Do not load it on every review.

- Name the retry or queue hop and the lock or token that serializes it.
- For a compare-and-swap or idempotency claim, write the two interleavings that would break a naive check.
- A sequential test that never overlaps the window does not prove the claim.
- A timeout or backoff default that a caller can override is not enforcement at the call site.
