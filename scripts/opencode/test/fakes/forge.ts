import { test } from "bun:test";
import { FORGE_PRESET_NAMES, type ForgePreset, forgePreset } from "../../src/forge_fake.ts";

export type { ForgePreset } from "../../src/forge_fake.ts";
export { makeForgeApi, makeIssueApi, makeReviewApi } from "../../src/forge_fake.ts";

/**
 * Register `name` once per forge preset. The callback receives the preset
 * for that run so one regression body covers Gitea and GitHub. Where a
 * scenario does not apply to one forge (capability absent in
 * `forge_capabilities.ts`), assert the capability-gated behaviour inside
 * the callback instead of skipping.
 */
export function forEachForge(name: string, fn: (preset: ForgePreset) => void | Promise<void>): void {
  for (const presetName of FORGE_PRESET_NAMES) {
    test(`${name} [${presetName}]`, () => fn(forgePreset(presetName)));
  }
}
