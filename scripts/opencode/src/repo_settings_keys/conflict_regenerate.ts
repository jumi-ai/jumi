import {
  type ConflictRegenerateEntry,
  optionalSetting,
  parseConflictRegenerateValue,
  type RepoSettingResult,
} from "../repo_settings_shared.ts";

/** `.jumi.yml` key `conflict_regenerate`. See `repo_settings.ts` for the registry. */
export const conflictRegenerateSetting = optionalSetting({
  key: "conflict_regenerate",
  field: "conflictRegenerate",
  doc: "Lockfiles the conflict job rebuilds with a shell command instead of the model.",
  parse: (raw): RepoSettingResult<ConflictRegenerateEntry[]> => {
    const parsed = parseConflictRegenerateValue(raw);
    if (!parsed.ok) return parsed;
    return { ok: true, value: parsed.entries };
  },
});
