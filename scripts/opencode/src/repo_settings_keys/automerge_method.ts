import {
  AUTOMERGE_METHODS,
  optionalSetting,
  type RepoAutomergeMethod,
  type RepoSettingResult,
} from "../repo_settings_shared.ts";

/** `.jumi.yml` key `automerge_method`. See `repo_settings.ts` for the registry. */
export const automergeMethodSetting = optionalSetting({
  key: "automerge_method",
  field: "automergeMethod",
  doc: "Merge method Jumi schedules with.",
  parse: (raw): RepoSettingResult<RepoAutomergeMethod> => {
    if (typeof raw !== "string" || !(AUTOMERGE_METHODS as readonly string[]).includes(raw)) {
      return {
        ok: false,
        error: `"automerge_method" must be one of "merge", "squash", "rebase", "rebase-merge", "fast-forward-only"`,
      };
    }
    return { ok: true, value: raw as RepoAutomergeMethod };
  },
});
