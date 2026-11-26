import { parseStringList, type RepoSettingResult, requiredSetting } from "../repo_settings_shared.ts";

/** `.jumi.yml` key `takeover_authors`. See `repo_settings.ts` for the registry. */
export const takeoverAuthorsSetting = requiredSetting({
  key: "takeover_authors",
  field: "takeoverAuthors",
  doc: "Pull requests opened by these logins are taken over like a manual handover.",
  defaultValue: [] as string[],
  parse: (raw): RepoSettingResult<string[]> => {
    const parsed = parseStringList(raw, "takeover_authors", {
      notListError: `"takeover_authors" must be a list of logins`,
    });
    if (!parsed.ok) return parsed;
    return { ok: true, value: parsed.values };
  },
});
