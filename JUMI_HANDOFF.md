# Handoff: issue 406 follow-up (review findings)

Key files:
- `scripts/opencode/src/worker_webhook.ts` (~line 320): PR closed/merged branch; handoff deletes removed, `issues` closed path (~line 637) still deletes by issue number.
- `scripts/opencode/src/implement.ts` (~line 523, ~line 573): `implementExternalIssue` handoff inject/save now guarded by `isExternalIssueJob`.
- `scripts/opencode/src/handoff.ts`: store + key helpers (unchanged this round).
- `scripts/opencode/src/tracker.ts:171`: `issueNumber: 0` for external jobs (root cause of collision).
- `scripts/opencode/test/handoff.test.ts`: 2 new regression tests.

Verified: `bun install --frozen-lockfile` then `bun run ci` in `scripts/opencode` → biome 0, tsc clean, 2218 pass / 0 fail. `test:pg` needs `JUMI_TEST_DATABASE_URL` (skips without).

Left/risky: external briefs get no handoff carryover (deliberate; schema key can't hold tracker identity). If that ever matters, extend `issue_handoffs` key — don't reuse `#0`.
