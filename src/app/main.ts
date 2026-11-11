#!/usr/bin/env node
/** Starts the outreach app and opens it in the browser. */
import { spawn } from "node:child_process";
import { DataFileError } from "./store.js";
import { DEFAULT_DATA_FILE, startApp } from "./server.js";

function openBrowser(url: string): void {
  try {
    const child =
      process.platform === "win32"
        ? spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true })
        : spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* The address is printed anyway. */
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const portArg = args.find((a) => a.startsWith("--port="));
  const port = portArg ? Number(portArg.slice("--port=".length)) : Number(process.env.LEAD_FINDER_PORT ?? 4321);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error("Port must be a whole number between 1 and 65535.");
    process.exitCode = 1;
    return;
  }
  const dataFile = process.env.LEAD_FINDER_DATA?.trim() || DEFAULT_DATA_FILE;
  try {
    const app = await startApp({ dataFile, port });
    console.log(`lead-finder app is running at ${app.url}`);
    console.log(`Data file: ${dataFile}`);
    console.log("Only this computer can open it. Press Ctrl+C to stop the app.");
    console.log("Off switch: create a file named STOP in the project folder to block all website checks.");
    if (!args.includes("--no-open")) openBrowser(app.url);
  } catch (err) {
    if (err instanceof DataFileError) {
      console.error(`Cannot start: ${err.message}`);
    } else if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
      console.error(`Port ${port} is busy. The app may already be running: open http://127.0.0.1:${port}/`);
    } else {
      console.error(err);
    }
    process.exitCode = 1;
  }
}

void main();
