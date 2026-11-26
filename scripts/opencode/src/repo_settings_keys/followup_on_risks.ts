import { type RepoSettingResult, requiredSetting } from "../repo_settings_shared.ts";

/** `.jumi.yml` key `followup_on_risks`. See `repo_settings.ts` for the registry. */
export const followupOnRisksSetting = requiredSetting({
  key: "followup_on_risks",
  field: "followupOnRisks",
  doc: "Follow up on success-with-risk reviews; false leaves them as-is.",
  defaultValue: true,
  parse: (raw): RepoSettingResult<boolean> => {
    if (typeof raw !== "boolean") return { ok: false, error: `"followup_on_risks" must be a boolean` };
    return { ok: true, value: raw };
  },
});
