import { optionalSetting, type RepoSettingResult, validateBranchPrefix } from "../repo_settings_shared.ts";

/** `.jumi.yml` key `branch_prefix`. See `repo_settings.ts` for the registry. */
export const branchPrefixSetting = optionalSetting({
  key: "branch_prefix",
  field: "branchPrefix",
  doc: "Branch prefix for issue branches (<prefix>/issue-<N>-<slug>).",
  parse: (raw): RepoSettingResult<string> => {
    if (typeof raw !== "string" || !raw.trim()) {
      return { ok: false, error: `"branch_prefix" must be a non-blank string` };
    }
    const validated = validateBranchPrefix(raw);
    if (!validated.ok) return validated;
    return { ok: true, value: validated.prefix };
  },
});
