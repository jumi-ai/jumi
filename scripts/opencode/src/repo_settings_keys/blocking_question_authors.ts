import { parseStringList, type RepoSettingResult, requiredSetting } from "../repo_settings_shared.ts";

/** `.jumi.yml` key `blocking_question_authors`. See `repo_settings.ts` for the registry. */
export const blockingQuestionAuthorsSetting = requiredSetting({
  key: "blocking_question_authors",
  field: "blockingQuestionAuthors",
  doc: "PR authors whose open questions block the review status.",
  defaultValue: [] as string[],
  parse: (raw): RepoSettingResult<string[]> => {
    const parsed = parseStringList(raw, "blocking_question_authors", {
      notListError: `"blocking_question_authors" must be a list of logins`,
    });
    if (!parsed.ok) return parsed;
    return { ok: true, value: parsed.values };
  },
});
