#!/usr/bin/env sh
# Hidden grader for the greet-shout fixture. Read from the base checkout
# before the run, executed against a fresh checkout of the pushed commit the
# agent never saw. Independent of repo/check.js so an agent edit to check.js
# cannot fake a pass. Covers the library and the CLI across both files.
set -eu
dir="$1"
cat > "$dir/.hidden-verify.mjs" <<'EOF'
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { greet } from "./greet.js";
const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "cli.js");
function eq(got, want, label) {
  if (got !== want) {
    console.error(`hidden: ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    process.exit(1);
  }
}
eq(greet("Ada", { shout: true }), "HELLO, ADA!", "greet shout");
eq(greet("Ada"), "Hello, Ada!", "greet plain");
eq(greet("Bo", { shout: false }), "Hello, Bo!", "greet explicit false");
eq(greet("world", { shout: true }), "HELLO, WORLD!", "greet world shout");
eq(execFileSync("node", [cli, "Ada", "--shout"], { encoding: "utf8" }).trim(), "HELLO, ADA!", "cli shout after");
eq(execFileSync("node", [cli, "--shout", "Ada"], { encoding: "utf8" }).trim(), "HELLO, ADA!", "cli shout before");
eq(execFileSync("node", [cli, "Ada"], { encoding: "utf8" }).trim(), "Hello, Ada!", "cli plain");
console.log("hidden check passed");
EOF
node "$dir/.hidden-verify.mjs"
rm -f "$dir/.hidden-verify.mjs"
