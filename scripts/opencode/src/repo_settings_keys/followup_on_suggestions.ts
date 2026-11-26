import { type RepoSettingResult, requiredSetting } from "../repo_settings_shared.ts";

/** `.jumi.yml` key `followup_on_suggestions`. See `repo_settings.ts` for the registry. */
export const followupOnSuggestionsSetting = requiredSetting({
  key: "followup_on_suggestions",
  field: "followupOnSuggestions",
  doc: "Follow up on success-with-suggestions reviews; false leaves them as-is.",
  defaultValue: true,
  parse: (raw): RepoSettingResult<boolean> => {
    if (typeof raw !== "boolean") return { ok: false, error: `"followup_on_suggestions" must be a boolean` };
    return { ok: true, value: raw };
  },
});
