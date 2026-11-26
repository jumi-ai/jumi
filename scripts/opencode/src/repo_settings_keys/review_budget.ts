import {
  parseReviewBudgetValue,
  type RepoReviewBudget,
  type RepoSettingResult,
  requiredSetting,
} from "../repo_settings_shared.ts";

/** `.jumi.yml` key `review_budget`. See `repo_settings.ts` for the registry. */
export const reviewBudgetSetting = requiredSetting({
  key: "review_budget",
  field: "reviewBudget",
  doc: "Review size budget overrides (max_files, max_patch_bytes).",
  defaultValue: {} as RepoReviewBudget,
  parse: (raw): RepoSettingResult<RepoReviewBudget> => {
    const parsed = parseReviewBudgetValue(raw);
    if (!parsed.ok) return parsed;
    return { ok: true, value: parsed.reviewBudget };
  },
});
