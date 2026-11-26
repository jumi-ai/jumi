import { optionalSetting, type RepoSettingResult } from "../repo_settings_shared.ts";

/** `.jumi.yml` key `max_followup_rounds`. See `repo_settings.ts` for the registry. */
export const maxFollowupRoundsSetting = optionalSetting({
  key: "max_followup_rounds",
  field: "maxFollowupRounds",
  doc: "Cap follow-up rounds per pull request; 0 means no follow-up rounds.",
  parse: (raw): RepoSettingResult<number> => {
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0)
      return { ok: false, error: `"max_followup_rounds" must be a non-negative integer` };
    return { ok: true, value: raw };
  },
});
