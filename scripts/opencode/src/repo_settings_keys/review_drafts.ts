import { type RepoSettingResult, requiredSetting } from "../repo_settings_shared.ts";

/** `.jumi.yml` key `review_drafts`. See `repo_settings.ts` for the registry. */
export const reviewDraftsSetting = requiredSetting({
  key: "review_drafts",
  field: "reviewDrafts",
  doc: "Review draft PRs and WIP:-titled PRs on every review-dispatch path.",
  defaultValue: false,
  parse: (raw): RepoSettingResult<boolean> => {
    if (typeof raw !== "boolean") return { ok: false, error: `"review_drafts" must be a boolean` };
    return { ok: true, value: raw };
  },
});
