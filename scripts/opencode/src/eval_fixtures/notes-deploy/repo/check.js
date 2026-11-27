import { summarize } from "./notes.js";

const cases = [
  [[], "You have 0 notes."],
  [["a"], "You have 1 note."],
  [["a", "b"], "You have 2 notes."],
];

for (const [input, expected] of cases) {
  const got = summarize(input);
  if (got !== expected) {
    console.error(`summarize(${JSON.stringify(input)}) = ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
    process.exit(1);
  }
}

console.log("check passed");
