import { sum } from "./sum.js";

const cases = [
  [2, 3, 5],
  [0, 0, 0],
  [-1, 1, 0],
];

for (const [a, b, expected] of cases) {
  const got = sum(a, b);
  if (got !== expected) {
    console.error(`sum(${a}, ${b}) = ${got}, expected ${expected}`);
    process.exit(1);
  }
}

console.log("check passed");
