import { type RepoSettingResult, requiredSetting } from "../repo_settings_shared.ts";

/** `.jumi.yml` key `retitle_adopted_prs`. See `repo_settings.ts` for the registry. */
export const retitleAdoptedPrsSetting = requiredSetting({
  key: "retitle_adopted_prs",
  field: "retitleAdoptedPrs",
  doc: "Retitle adopted PRs when Jumi's commits change what they do; false never retitles.",
  defaultValue: true,
  parse: (raw): RepoSettingResult<boolean> => {
    if (typeof raw !== "boolean") return { ok: false, error: `"retitle_adopted_prs" must be a boolean` };
    return { ok: true, value: raw };
  },
});
