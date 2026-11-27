import { optionalSetting, type RepoSettingResult } from "../repo_settings_shared.ts";
import { parseVerifyValue, type RepoVerify } from "../repo_verify.ts";

/** `.jumi.yml` key `verify`. See `repo_settings.ts` for the registry. */
export const verifySetting = optionalSetting({
  key: "verify",
  field: "verify",
  doc: "Repository verify command run after the worker with commits and before the push.",
  parse: (raw): RepoSettingResult<RepoVerify | undefined> => {
    const parsed = parseVerifyValue(raw);
    if (!parsed.ok) return parsed;
    return { ok: true, value: parsed.verify };
  },
});
