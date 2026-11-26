import { optionalSetting, type RepoSettingResult } from "../repo_settings_shared.ts";

/** `.jumi.yml` key `max_suggestions`. See `repo_settings.ts` for the registry. */
export const maxSuggestionsSetting = optionalSetting({
  key: "max_suggestions",
  field: "maxSuggestions",
  doc: "Cap for suggestion findings in this repository; 0 means no suggestions.",
  parse: (raw): RepoSettingResult<number> => {
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0)
      return { ok: false, error: `"max_suggestions" must be a non-negative integer` };
    return { ok: true, value: raw };
  },
});
