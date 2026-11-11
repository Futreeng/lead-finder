/**
 * Saves all app data to one JSON file on this computer.
 * - Every save writes a temporary file first and then swaps it in, so a crash never leaves half a file.
 * - The first save of each day also keeps a copy in data/backups/.
 * - If the file cannot be read, the app refuses to start rather than overwrite it.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  STATUSES,
  defaultAppSettings,
  emptyData,
  type AppSettings,
  type Data,
  type Firm,
  type Status,
} from "./model.js";

export class DataFileError extends Error {}

function str(v: unknown): string {
  return typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
}

function normalizeFirm(raw: Record<string, unknown>): Firm {
  const status = STATUSES.includes(raw.status as Status) ? (raw.status as Status) : "Needs review";
  return {
    id: str(raw.id),
    firm: str(raw.firm),
    contact: str(raw.contact),
    attorneys: str(raw.attorneys),
    practiceArea: str(raw.practiceArea),
    website: str(raw.website),
    status,
    lastContact: str(raw.lastContact),
    nextStep: str(raw.nextStep),
    nextStepDate: str(raw.nextStepDate),
    notes: str(raw.notes),
    phone: str(raw.phone),
    publicEmail: str(raw.publicEmail),
    address: str(raw.address),
    source: str(raw.source),
    foundNote: str(raw.foundNote),
    createdAt: str(raw.createdAt),
    updatedAt: str(raw.updatedAt),
    permission: raw.permission as Firm["permission"],
    speedCheck: raw.speedCheck as Firm["speedCheck"],
    drafts: Array.isArray(raw.drafts) ? (raw.drafts as Firm["drafts"]) : [],
  };
}

export function normalizeData(raw: unknown): Data {
  if (!raw || typeof raw !== "object") throw new DataFileError("data file does not hold an object");
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) throw new DataFileError(`data file version ${String(r.version)} is not supported`);
  const settings: AppSettings = { ...defaultAppSettings(), ...((r.settings as Partial<AppSettings>) ?? {}) };
  return {
    version: 1,
    firms: Array.isArray(r.firms) ? r.firms.map((f) => normalizeFirm(f as Record<string, unknown>)) : [],
    events: Array.isArray(r.events) ? (r.events as Data["events"]) : [],
    settings,
    searches: Array.isArray(r.searches) ? (r.searches as Data["searches"]) : [],
  };
}

export class Store {
  data: Data;

  constructor(
    readonly file: string,
    private readonly today: () => string = () => new Date().toISOString().slice(0, 10),
  ) {
    this.data = this.load();
  }

  private load(): Data {
    if (!existsSync(this.file)) return emptyData();
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch (err) {
      throw new DataFileError(`could not read ${this.file}: ${(err as Error).message}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new DataFileError(
        `${this.file} is not valid JSON. Nothing was changed. Restore the newest copy from ${join(dirname(this.file), "backups")}.`,
      );
    }
    return normalizeData(parsed);
  }

  save(): void {
    const dir = dirname(this.file);
    mkdirSync(dir, { recursive: true });
    if (existsSync(this.file)) {
      const backupDir = join(dir, "backups");
      mkdirSync(backupDir, { recursive: true });
      const backup = join(backupDir, `lead-finder-${this.today()}.json`);
      if (!existsSync(backup)) copyFileSync(this.file, backup);
    }
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
    renameSync(tmp, this.file);
  }

  /** Runs a change and saves it. If the change throws, nothing is saved and memory is restored. */
  update<T>(change: (d: Data) => T): T {
    const before = JSON.stringify(this.data);
    try {
      const result = change(this.data);
      this.save();
      return result;
    } catch (err) {
      this.data = JSON.parse(before) as Data;
      throw err;
    }
  }
}
