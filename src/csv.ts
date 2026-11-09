/** CSV reading and writing (RFC 4180 style), with protection against spreadsheet formula injection. */

export function parseCsv(text: string): string[][] {
  const s = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/**
 * Website text could start with "=" and run as a formula when the CSV is opened in
 * Google Sheets or Excel. Such cells get a leading apostrophe. Phone numbers like
 * "+1 330 555 0100" are left alone.
 */
export function safeCell(value: string): string {
  if (/^[=@\t\r]/.test(value)) return `'${value}`;
  if (/^[+-]/.test(value) && !/^[+-][\d\s().-]+$/.test(value)) return `'${value}`;
  return value;
}

export function toCsv(rows: string[][]): string {
  return (
    rows
      .map((r) =>
        r
          .map((cell) => {
            const v = safeCell(cell ?? "");
            return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
          })
          .join(","),
      )
      .join("\r\n") + "\r\n"
  );
}
