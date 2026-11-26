import { optionalSetting, parseSetupValue, type RepoSettingResult, type RepoSetup } from "../repo_settings_shared.ts";

/** `.jumi.yml` key `setup`. See `repo_settings.ts` for the registry. */
export const setupSetting = optionalSetting({
  key: "setup",
  field: "setup",
  doc: "Repository preparation command run once per job before the first engine spawn.",
  parse: (raw): RepoSettingResult<RepoSetup | undefined> => {
    const parsed = parseSetupValue(raw);
    if (!parsed.ok) return parsed;
    return { ok: true, value: parsed.setup };
  },
});
