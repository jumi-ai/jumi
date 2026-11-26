import { DEFAULT_AUTOMERGE_LABEL, type RepoSettingResult, requiredSetting } from "../repo_settings_shared.ts";

/** `.jumi.yml` key `automerge_label`. See `repo_settings.ts` for the registry. */
export const automergeLabelSetting = requiredSetting({
  key: "automerge_label",
  field: "automergeLabel",
  doc: "Per-PR label opting one Jumi PR into auto-merge.",
  defaultValue: DEFAULT_AUTOMERGE_LABEL,
  placement: "early",
  parse: (raw): RepoSettingResult<string> => {
    if (typeof raw !== "string" || !raw.trim()) {
      return { ok: false, error: `"automerge_label" must be a non-blank string` };
    }
    return { ok: true, value: raw.trim() };
  },
});
