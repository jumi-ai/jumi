import { DEFAULT_NO_AUTOMERGE_LABEL, type RepoSettingResult, requiredSetting } from "../repo_settings_shared.ts";

/** `.jumi.yml` key `no_automerge_label`. See `repo_settings.ts` for the registry. */
export const noAutomergeLabelSetting = requiredSetting({
  key: "no_automerge_label",
  field: "noAutomergeLabel",
  doc: "Per-PR label opting one Jumi PR out of auto-merge.",
  defaultValue: DEFAULT_NO_AUTOMERGE_LABEL,
  placement: "early",
  parse: (raw): RepoSettingResult<string> => {
    if (typeof raw !== "string" || !raw.trim()) {
      return { ok: false, error: `"no_automerge_label" must be a non-blank string` };
    }
    return { ok: true, value: raw.trim() };
  },
});
