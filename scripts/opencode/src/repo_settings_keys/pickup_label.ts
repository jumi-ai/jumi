import { optionalSetting, type RepoSettingResult } from "../repo_settings_shared.ts";

/** `.jumi.yml` key `pickup_label`. See `repo_settings.ts` for the registry. */
export const pickupLabelSetting = optionalSetting({
  key: "pickup_label",
  field: "pickupLabel",
  doc: "Override for the GitHub pickup label (Gitea ignores it).",
  parse: (raw): RepoSettingResult<string> => {
    if (typeof raw !== "string" || !raw.trim()) {
      return { ok: false, error: `"pickup_label" must be a non-blank string` };
    }
    return { ok: true, value: raw.trim() };
  },
});
