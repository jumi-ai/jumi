import { parseStringList, type RepoSettingResult, requiredSetting } from "../repo_settings_shared.ts";

/** `.jumi.yml` key `review_exclude`. See `repo_settings.ts` for the registry. */
export const reviewExcludeSetting = requiredSetting({
  key: "review_exclude",
  field: "reviewExclude",
  doc: "Changed files matching these globs are left out of the review (patch withheld).",
  defaultValue: [] as string[],
  parse: (raw): RepoSettingResult<string[]> => {
    const parsed = parseStringList(raw, "review_exclude", {
      notListError: `"review_exclude" must be a list of glob strings`,
      dedupe: false,
    });
    if (!parsed.ok) return parsed;
    return { ok: true, value: parsed.values };
  },
});
