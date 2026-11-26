import { optionalSetting, type RepoSettingResult } from "../repo_settings_shared.ts";

/** `.jumi.yml` key `max_conflict_rounds`. See `repo_settings.ts` for the registry. */
export const maxConflictRoundsSetting = optionalSetting({
  key: "max_conflict_rounds",
  field: "maxConflictRounds",
  doc: "Cap consecutive failed conflict-resolution rounds per issue; 0 means none.",
  parse: (raw): RepoSettingResult<number> => {
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0)
      return { ok: false, error: `"max_conflict_rounds" must be a non-negative integer` };
    return { ok: true, value: raw };
  },
});
