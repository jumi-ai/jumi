import { type RepoSettingResult, requiredSetting } from "../repo_settings_shared.ts";

/** `.jumi.yml` key `blocking_risks`. See `repo_settings.ts` for the registry. */
export const blockingRisksSetting = requiredSetting({
  key: "blocking_risks",
  field: "blockingRisks",
  doc: "Whether 🟡 risk findings fail the review status; false leaves them advisory.",
  defaultValue: true,
  parse: (raw): RepoSettingResult<boolean> => {
    if (typeof raw !== "boolean") return { ok: false, error: `"blocking_risks" must be a boolean` };
    return { ok: true, value: raw };
  },
});
