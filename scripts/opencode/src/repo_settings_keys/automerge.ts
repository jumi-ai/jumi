import { type RepoSettingResult, requiredSetting } from "../repo_settings_shared.ts";

/** `.jumi.yml` key `automerge`. See `repo_settings.ts` for the registry. */
export const automergeSetting = requiredSetting({
  key: "automerge",
  field: "automerge",
  doc: "Schedule the forge's native auto-merge on opened pull requests once every other gate passes.",
  defaultValue: false,
  placement: "early",
  parse: (raw): RepoSettingResult<boolean> => {
    if (typeof raw !== "boolean") return { ok: false, error: `"automerge" must be a boolean` };
    return { ok: true, value: raw };
  },
});
