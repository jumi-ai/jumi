---
name: worker-proof
description: Use when implementing, following up, or resolving conflicts to turn the task and accepted feedback into observable checks. Fix the cause and add a regression that reaches the symptom.
---

# worker-proof

Before editing, turn the task and accepted feedback into observable checks. Fix the cause and add a regression that reaches the symptom.

## Checks

1. **Observable checks first.** Restate the task and each accepted feedback item as a check with an independent expected result: what you will run, what it should show, and what plausible broken behavior would still pass it.
2. **Current code and scope.** Check feedback against the current code and the accepted scope before changing code to satisfy it. A removed assertion, a skip, or a stale comment is a lead, not an order: show the broken path or the lost behavior on this tree before you adopt it.
3. **Cause, not symptom.** Fix the cause. Add or update a regression that reaches the symptom through the real entrypoint, with a positive control where a negative test must prove the observer works.
4. **Report.** Report what actually ran and what remains unverified. Do not claim coverage you did not run.

## Limits

- Verify once at the end, not after every edit. This skill does not add a test-first mandate or a check after every edit.
- This skill is for implement, follow-up, and conflict jobs. It does not review, approve, or gate a pull request.
- Repo-specific commands, versions, and deploy facts stay in that repo. This skill carries none of them.
