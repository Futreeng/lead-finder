#!/usr/bin/env node
import { run } from "./run.js";

run(process.argv.slice(2)).then(
  (r) => {
    process.exitCode = r.exitCode;
  },
  (err: unknown) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  },
);
