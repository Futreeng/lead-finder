/**
 * Emergency off switch.
 *
 * The tool refuses to start, and stops before its next web request, when either:
 *   - a file named STOP exists in the folder you run it from or in the project folder, or
 *   - the environment variable LEAD_FINDER_DISABLED is set to anything except "0" or "false".
 *
 * This is checked before every single network request, not just at startup.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Project root: this file compiles to dist/src/killswitch.js, two levels below the root. */
export const PROJECT_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export class StoppedError extends Error {
  constructor(reason: string) {
    super(`Stopped by off switch: ${reason}`);
    this.name = "StoppedError";
  }
}

export interface StopOptions {
  env?: NodeJS.ProcessEnv;
  dirs?: string[];
}

export function stopReason(opts: StopOptions = {}): string | null {
  const env = opts.env ?? process.env;
  const flag = (env.LEAD_FINDER_DISABLED ?? "").trim().toLowerCase();
  if (flag !== "" && flag !== "0" && flag !== "false") {
    return "LEAD_FINDER_DISABLED is set";
  }
  const dirs = opts.dirs ?? [process.cwd(), PROJECT_ROOT];
  for (const dir of new Set(dirs.map((d) => resolve(d)))) {
    if (existsSync(resolve(dir, "STOP"))) {
      return `STOP file found in ${dir}`;
    }
  }
  return null;
}

export function assertNotStopped(opts?: StopOptions): void {
  const reason = stopReason(opts);
  if (reason) throw new StoppedError(reason);
}
