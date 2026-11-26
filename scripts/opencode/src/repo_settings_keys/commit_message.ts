import { optionalSetting, type RepoSettingResult, validatePrTemplate } from "../repo_settings_shared.ts";

/** `.jumi.yml` key `commit_message`. See `repo_settings.ts` for the registry. */
export const commitMessageSetting = optionalSetting({
  key: "commit_message",
  field: "commitMessage",
  doc: "Commit message template for the parent's leftover commit.",
  parse: (raw): RepoSettingResult<string> => {
    if (typeof raw !== "string" || !raw.trim()) {
      return { ok: false, error: `"commit_message" must be a non-blank string` };
    }
    const validated = validatePrTemplate("commit_message", raw);
    if (!validated.ok) return validated;
    return { ok: true, value: validated.template };
  },
});
