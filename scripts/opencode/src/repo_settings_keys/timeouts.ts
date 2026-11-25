import {
  parseTimeoutsValue,
  type RepoSettingResult,
  type RepoTimeouts,
  requiredSetting,
} from "../repo_settings_shared.ts";

/** `.jumi.yml` key `timeouts`. See `repo_settings.ts` for the registry. */
export const timeoutsSetting = requiredSetting({
  key: "timeouts",
  field: "timeouts",
  doc: "Per-kind run timeouts in whole minutes; absent keys run with the deployment timeout.",
  defaultValue: {} as RepoTimeouts,
  parse: (raw): RepoSettingResult<RepoTimeouts> => {
    const parsed = parseTimeoutsValue(raw);
    if (!parsed.ok) return parsed;
    return { ok: true, value: parsed.timeouts };
  },
});
