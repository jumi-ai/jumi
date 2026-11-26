import { parseStringList, type RepoSettingResult, requiredSetting } from "../repo_settings_shared.ts";

/** `.jumi.yml` key `ignore_conflicts_authors`. See `repo_settings.ts` for the registry. */
export const ignoreConflictsAuthorsSetting = requiredSetting({
  key: "ignore_conflicts_authors",
  field: "ignoreConflictsAuthors",
  doc: "Pulls by these authors get the ignore-conflicts behavior without the label.",
  defaultValue: [] as string[],
  parse: (raw): RepoSettingResult<string[]> => {
    const parsed = parseStringList(raw, "ignore_conflicts_authors", {
      notListError: `"ignore_conflicts_authors" must be a list of logins`,
    });
    if (!parsed.ok) return parsed;
    return { ok: true, value: parsed.values };
  },
});
