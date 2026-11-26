import { alwaysPresentSetting, parseStringList, type RepoSettingResult } from "../repo_settings_shared.ts";

/** `.jumi.yml` key `allowed_runners`. See `repo_settings.ts` for the registry. */
export const allowedRunnersSetting = alwaysPresentSetting({
  key: "allowed_runners",
  field: "allowedRunners",
  doc: "Runner allow-list: every job for the repository narrows to chain entries on the list.",
  parse: (raw): RepoSettingResult<string[]> => {
    const parsed = parseStringList(raw, "allowed_runners", {
      notListError: `"allowed_runners" must be a list of runner names`,
    });
    if (!parsed.ok) return parsed;
    if (parsed.values.length === 0) {
      return {
        ok: false,
        error: `"allowed_runners" is empty, so no runner could work on the repository; use mode: off or mode: review-only`,
      };
    }
    return { ok: true, value: parsed.values };
  },
});
