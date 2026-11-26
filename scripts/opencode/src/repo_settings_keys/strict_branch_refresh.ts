import { type RepoSettingResult, requiredSetting } from "../repo_settings_shared.ts";

/** `.jumi.yml` key `strict_branch_refresh`. See `repo_settings.ts` for the registry. */
export const strictBranchRefreshSetting = requiredSetting({
  key: "strict_branch_refresh",
  field: "strictBranchRefresh",
  doc: "Gitea fallback for strict branch refresh when branch protection is unreadable.",
  defaultValue: false,
  parse: (raw): RepoSettingResult<boolean> => {
    if (typeof raw !== "boolean") return { ok: false, error: `"strict_branch_refresh" must be a boolean` };
    return { ok: true, value: raw };
  },
});
