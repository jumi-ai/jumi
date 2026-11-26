import { optionalSetting, type RepoSettingResult } from "../repo_settings_shared.ts";

/** `.jumi.yml` key `suggestions_hold_merge`. See `repo_settings.ts` for the registry. */
export const suggestionsHoldMergeSetting = optionalSetting({
  key: "suggestions_hold_merge",
  field: "suggestionsHoldMerge",
  doc: "Hold the merge for one suggestion follow-up round in auto-merge repositories.",
  placement: "late",
  parse: (raw): RepoSettingResult<boolean> => {
    if (typeof raw !== "boolean") return { ok: false, error: `"suggestions_hold_merge" must be a boolean` };
    return { ok: true, value: raw };
  },
});
