import { median } from "./median.js";

const got = median([10, 2, 30]);
if (got !== 10) {
  console.error(`median([10, 2, 30]) = ${got}, expected 10`);
  process.exit(1);
}

console.log("check passed");
