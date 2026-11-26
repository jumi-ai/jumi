import { type RepoSettingResult, requiredSetting } from "../repo_settings_shared.ts";

/** `.jumi.yml` key `auto_rerun_flakes`. See `repo_settings.ts` for the registry. */
export const autoRerunFlakesSetting = requiredSetting({
  key: "auto_rerun_flakes",
  field: "autoRerunFlakes",
  doc: "Rerun failed CI jobs once per head and check after a no_changes round; false never reruns.",
  defaultValue: true,
  parse: (raw): RepoSettingResult<boolean> => {
    if (typeof raw !== "boolean") return { ok: false, error: `"auto_rerun_flakes" must be a boolean` };
    return { ok: true, value: raw };
  },
});
