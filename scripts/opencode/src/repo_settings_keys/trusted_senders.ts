import { alwaysPresentSetting, parseStringList, type RepoSettingResult } from "../repo_settings_shared.ts";

/** `.jumi.yml` key `trusted_senders`. See `repo_settings.ts` for the registry. */
export const trustedSendersSetting = alwaysPresentSetting({
  key: "trusted_senders",
  field: "trustedSenders",
  doc: "Repository trusted-sender list; narrows a set deployment list, never widens it.",
  parse: (raw): RepoSettingResult<string[]> => {
    const parsed = parseStringList(raw, "trusted_senders", {
      notListError: `"trusted_senders" must be a list of logins`,
    });
    if (!parsed.ok) return parsed;
    if (parsed.values.length === 0) {
      return {
        ok: false,
        error: `"trusted_senders" is empty, so no sender could work on the repository; use mode: off or mode: review-only`,
      };
    }
    return { ok: true, value: parsed.values };
  },
});
