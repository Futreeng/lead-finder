/** Turns "smithlaw.com" or "https://www.smithlaw.com/" into a full web address, or undefined if invalid. */
export function normalizeWebsite(raw: string | undefined): string | undefined {
  const s = (raw ?? "").trim();
  if (!s) return undefined;
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    if (!u.hostname.includes(".") && u.hostname !== "localhost") return undefined;
    return u.href;
  } catch {
    return undefined;
  }
}

export function hasExplicitScheme(raw: string | undefined): boolean {
  return /^https?:\/\//i.test((raw ?? "").trim());
}

/** Host (and port, if any) in lower case without a leading "www.". Used to spot the same firm twice. */
export function domainOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host.toLowerCase().replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

/** Key used to spot duplicates: the website domain, or the firm name when there is no website. */
export function firmKey(firm: string, website: string | undefined): string {
  const domain = domainOf(normalizeWebsite(website));
  if (domain) return domain;
  return "name:" + firm.toLowerCase().replace(/[^a-z0-9]/g, "");
}
