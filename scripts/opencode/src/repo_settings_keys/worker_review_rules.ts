import { type RepoSettingResult, requiredSetting } from "../repo_settings_shared.ts";

/** `.jumi.yml` key `worker_review_rules`. See `repo_settings.ts` for the registry. */
export const workerReviewRulesSetting = requiredSetting({
  key: "worker_review_rules",
  field: "workerReviewRules",
  doc: "Share the base-branch REVIEW.md rules with implement and follow-up workers; false keeps workers on today's prompts.",
  defaultValue: true,
  parse: (raw): RepoSettingResult<boolean> => {
    if (typeof raw !== "boolean") return { ok: false, error: `"worker_review_rules" must be a boolean` };
    return { ok: true, value: raw };
  },
});
