import { execFileSync } from "node:child_process";
import { greet } from "./greet.js";

function eq(got, want, label) {
  if (got !== want) {
    console.error(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    process.exit(1);
  }
}

eq(greet("Ada", { shout: true }), "HELLO, ADA!", "greet shout");
eq(greet("Ada"), "Hello, Ada!", "greet plain");
eq(execFileSync("node", ["cli.js", "Ada", "--shout"], { encoding: "utf8" }).trim(), "HELLO, ADA!", "cli shout");
eq(execFileSync("node", ["cli.js", "Ada"], { encoding: "utf8" }).trim(), "Hello, Ada!", "cli plain");

console.log("check passed");
