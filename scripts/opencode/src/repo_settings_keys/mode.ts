import { REPO_MODES, type RepoMode, type RepoSettingResult, requiredSetting } from "../repo_settings_shared.ts";

/** `.jumi.yml` key `mode`. See `repo_settings.ts` for the registry. */
export const modeSetting = requiredSetting({
  key: "mode",
  field: "mode",
  doc: "Repository mode: full work, reviews only, or everything off.",
  defaultValue: "full" as RepoMode,
  parse: (raw): RepoSettingResult<RepoMode> => {
    if (typeof raw !== "string" || !(REPO_MODES as readonly string[]).includes(raw)) {
      return { ok: false, error: `"mode" must be one of "full", "review-only", "off"` };
    }
    return { ok: true, value: raw as RepoMode };
  },
});
