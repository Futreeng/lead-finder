// Runs every compiled test file with Node's built-in test runner.
// Listing the files here keeps this working the same way on Windows, macOS and Linux.
import { readdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const dir = join("dist", "test");
if (!existsSync(dir)) {
  console.error("No compiled tests found. Run `npm run build` first.");
  process.exit(1);
}
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".test.js"))
  .sort()
  .map((f) => join(dir, f));
if (files.length === 0) {
  console.error("No *.test.js files in dist/test.");
  process.exit(1);
}
const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
