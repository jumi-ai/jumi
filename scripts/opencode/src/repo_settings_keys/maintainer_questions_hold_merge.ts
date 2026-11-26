import { optionalSetting, type RepoSettingResult } from "../repo_settings_shared.ts";

/** `.jumi.yml` key `maintainer_questions_hold_merge`. See `repo_settings.ts` for the registry. */
export const maintainerQuestionsHoldMergeSetting = optionalSetting({
  key: "maintainer_questions_hold_merge",
  field: "maintainerQuestionsHoldMerge",
  doc: "Hold the merge while open ❓ maintainer: questions remain; false posts success instead of pending.",
  placement: "late",
  parse: (raw): RepoSettingResult<boolean> => {
    if (typeof raw !== "boolean") return { ok: false, error: `"maintainer_questions_hold_merge" must be a boolean` };
    return { ok: true, value: raw };
  },
});
