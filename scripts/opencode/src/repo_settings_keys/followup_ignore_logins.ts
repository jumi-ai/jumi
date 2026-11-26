import { alwaysPresentSetting, parseStringList, type RepoSettingResult } from "../repo_settings_shared.ts";

/** `.jumi.yml` key `followup_ignore_logins`. See `repo_settings.ts` for the registry. */
export const followupIgnoreLoginsSetting = alwaysPresentSetting({
  key: "followup_ignore_logins",
  field: "followupIgnoreLogins",
  doc: "Extra follow-up ignore logins for this repository (union with the deployer list).",
  parse: (raw): RepoSettingResult<string[]> => {
    const parsed = parseStringList(raw, "followup_ignore_logins", {
      notListError: `"followup_ignore_logins" must be a list of logins`,
    });
    if (!parsed.ok) return parsed;
    return { ok: true, value: parsed.values };
  },
});
