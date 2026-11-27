#!/usr/bin/env sh
# Hidden grader for the notes fixture. Read from the base checkout before the
# run, executed against a fresh checkout of the pushed commit the agent never
# saw. Independent of repo/check.js so an agent edit to check.js cannot fake a
# pass. Only the in-repo wording is graded; the deploy step stays remaining.
set -eu
dir="$1"
cat > "$dir/.hidden-verify.mjs" <<'EOF'
import { summarize } from "./notes.js";
const cases = [
  [[], "You have 0 notes."],
  [["a"], "You have 1 note."],
  [["a", "b"], "You have 2 notes."],
  [["a", "b", "c"], "You have 3 notes."],
];
for (const [input, exp] of cases) {
  const got = summarize(input);
  if (got !== exp) {
    console.error(`hidden: summarize(${JSON.stringify(input)}) = ${JSON.stringify(got)}, expected ${JSON.stringify(exp)}`);
    process.exit(1);
  }
}
console.log("hidden check passed");
EOF
node "$dir/.hidden-verify.mjs"
rm -f "$dir/.hidden-verify.mjs"
