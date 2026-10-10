# AI usage

**Tool:** Claude (Anthropic), via Claude Code in a Claude project, used as a pair-programmer throughout.

**What it did**
- Helped turn the brief into a plan and a list of decisions (stack, broker, dedupe key, late-data approach). I reviewed and approved each decision before any code was written.
- Wrote most of the code: the API, the worker, the SQL schema, the React app, the Docker setup, and the tests.
- Drafted these documents, which I edited.

**How I verified it, rather than taking its word**
- **Invariants are tested against the running system, not mocks.** A property test (fast-check) pushes random readings through the real HTTP endpoint, shuffled, duplicated 1–4×, split into random requests across both lanes. It then compares Postgres to an in-memory oracle: history, current state, registration count, `device_discovered` events and every `late` flag.
- **I checked that the tests can fail.** Removing the `WHERE newer` guard from the state upsert makes the property test fail with a concrete counterexample. `scripts/check.sh` flagged the bad row that run left behind.
- **Failure injection:** killing the worker with SIGKILL mid-stream, and stopping Redpanda (the API answers `503`, the simulated gateways retry, nothing is lost). There is also a direct test that the worker's crash window (DB committed, offset not) is harmless, and that overlapping batches written concurrently converge to the sequential result.

**Where the AI was wrong and the tests caught it**
- The first worker re-processed the same Kafka batch in a loop: KafkaJS refetches from the last *resolved* offset, and it only committed. A smoke test showed `resend_count` at 1,436 for one reading. The fix was to resolve offsets as well as commit them.
- The first definition of `late` ("something newer was already current when the worker wrote it") depended on which worker lane happened to run first. That made it non-deterministic, which the trace can't tolerate. It was redefined by arrival order at the API, and the property test now checks it against an oracle.
- A unit test for the ordering function failed on `-0 !== +0`, a bug in the test rather than the code.

**Checking the provided generator.** Once the real `telemetry_generator.py` arrived, I read it against the assumptions the build had made. Its `--target` is a base URL, so the compose service had been sending to the wrong path; that's fixed. Its documented example target is `:8080`, our web port, so nginx now forwards `/ingest/readings` to the API. Its `sequence` counts per (gateway, device), which means a `(gateway_id, sequence)` key would have wrongly merged different devices; the wider dedupe key was the right call. The hand trace was committed before the real run (see git history) and matched it exactly. The `clean`, `replay` and `race` scenarios all pass `scripts/check.sh` with zero violations.

<!-- Paawan: add anything you did with other tools (ChatGPT, Copilot, etc.) or by hand. -->
