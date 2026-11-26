import { type CiGateWait, optionalSetting, parseCiGateValue, type RepoSettingResult } from "../repo_settings_shared.ts";

/** `.jumi.yml` key `ci_gate`. See `repo_settings.ts` for the registry. */
export const ciGateSetting = optionalSetting({
  key: "ci_gate",
  field: "ciGate",
  doc: "CI gate wait mode: required, all, or none.",
  parse: (raw): RepoSettingResult<{ wait: CiGateWait } | undefined> => {
    const parsed = parseCiGateValue(raw);
    if (!parsed.ok) return parsed;
    return { ok: true, value: parsed.ciGate };
  },
});
