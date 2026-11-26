import { optionalSetting, type RepoSettingResult, validatePrTemplate } from "../repo_settings_shared.ts";

/** `.jumi.yml` key `pr_title`. See `repo_settings.ts` for the registry. */
export const prTitleSetting = optionalSetting({
  key: "pr_title",
  field: "prTitle",
  doc: "Pull-request title template for forge issues ({title} and {issue} only).",
  parse: (raw): RepoSettingResult<string> => {
    if (typeof raw !== "string" || !raw.trim()) {
      return { ok: false, error: `"pr_title" must be a non-blank string` };
    }
    const validated = validatePrTemplate("pr_title", raw);
    if (!validated.ok) return validated;
    return { ok: true, value: validated.template };
  },
});
