// Removes the compiled output so stale files never leak into a build or test run.
import { rmSync } from "node:fs";

rmSync(new URL("../dist", import.meta.url), { recursive: true, force: true });
