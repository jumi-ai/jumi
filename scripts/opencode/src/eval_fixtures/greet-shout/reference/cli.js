import { greet } from "./greet.js";

const args = process.argv.slice(2);
const shout = args.includes("--shout");
const name = args.find((arg) => !arg.startsWith("--")) ?? "world";
console.log(greet(name, { shout }));
