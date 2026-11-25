import { optionalSetting, type RepoSettingResult } from "../repo_settings_shared.ts";

/** `.jumi.yml` key `ignore_conflicts_label`. See `repo_settings.ts` for the registry. */
export const ignoreConflictsLabelSetting = optionalSetting({
  key: "ignore_conflicts_label",
  field: "ignoreConflictsLabel",
  doc: "Override for the deployment ignore-conflicts label.",
  parse: (raw): RepoSettingResult<string> => {
    if (typeof raw !== "string" || !raw.trim()) {
      return { ok: false, error: `"ignore_conflicts_label" must be a non-blank string` };
    }
    return { ok: true, value: raw.trim() };
  },
});
