#!/usr/bin/env sh
# Hidden grader for the median fixture. Read from the base checkout before
# the run, executed against a fresh checkout of the pushed commit the agent
# never saw. Independent of repo/check.js so an agent edit to check.js cannot
# fake a pass. Covers more cases than the issue states.
set -eu
dir="$1"
cat > "$dir/.hidden-verify.mjs" <<'EOF'
import { median } from "./median.js";
const cases = [
  [[10, 2, 30], 10],
  [[3, 1, 2], 2],
  [[5], 5],
  [[1, 2, 3, 4], 2.5],
  [[4, 1, 3, 2], 2.5],
  [[2, 2, 2], 2],
  [[1.5, 0.5, 2.5], 1.5],
  [[100, 20, 30], 30],
];
for (const [input, exp] of cases) {
  const got = median(input);
  if (got !== exp) {
    console.error(`hidden: median(${JSON.stringify(input)}) = ${got}, expected ${exp}`);
    process.exit(1);
  }
}
console.log("hidden check passed");
EOF
node "$dir/.hidden-verify.mjs"
rm -f "$dir/.hidden-verify.mjs"
