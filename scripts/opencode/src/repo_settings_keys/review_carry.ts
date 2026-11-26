import { type RepoSettingResult, requiredSetting } from "../repo_settings_shared.ts";

/** `.jumi.yml` key `review_carry`. See `repo_settings.ts` for the registry. */
export const reviewCarrySetting = requiredSetting({
  key: "review_carry",
  field: "reviewCarry",
  doc: "Carry a green review across a clean target-branch merge without running a model.",
  defaultValue: true,
  parse: (raw): RepoSettingResult<boolean> => {
    if (typeof raw !== "boolean") return { ok: false, error: `"review_carry" must be a boolean` };
    return { ok: true, value: raw };
  },
});
