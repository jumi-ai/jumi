import {
  optionalSetting,
  REPO_CLOSING_KEYWORDS,
  type RepoClosingKeyword,
  type RepoSettingResult,
} from "../repo_settings_shared.ts";

/** `.jumi.yml` key `closing_keyword`. See `repo_settings.ts` for the registry. */
export const closingKeywordSetting = optionalSetting({
  key: "closing_keyword",
  field: "closingKeyword",
  doc: "Closing keyword behavior: closes (Fixes #N) or refs (non-closing Refs #N).",
  parse: (raw): RepoSettingResult<RepoClosingKeyword> => {
    if (typeof raw !== "string" || !raw.trim()) {
      return { ok: false, error: `"closing_keyword" must be a non-blank string` };
    }
    const trimmed = raw.trim();
    if (!(REPO_CLOSING_KEYWORDS as readonly string[]).includes(trimmed)) {
      return { ok: false, error: `"closing_keyword" must be one of "closes", "refs"` };
    }
    return { ok: true, value: trimmed as RepoClosingKeyword };
  },
});
