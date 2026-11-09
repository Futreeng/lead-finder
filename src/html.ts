/** Small, dependency-free helpers for reading text and links out of HTML. */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "-",
  mdash: "-",
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
  hellip: "...",
  copy: "(c)",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code.startsWith("#")) {
      const hex = code[1] === "x" || code[1] === "X";
      const n = hex ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : match;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? match;
  });
}

/** Removes comments and blocks that never hold visible text. */
export function stripNonContent(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, " ");
}

export function htmlToText(html: string): string {
  return decodeEntities(stripNonContent(html).replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

export function pageTitle(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  return m?.[1] ? decodeEntities(m[1]).replace(/\s+/g, " ").trim() : "";
}

export interface Link {
  href: string;
  url?: URL;
  text: string;
}

function readAttr(attrs: string, name: string): string | undefined {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
  const m = re.exec(attrs);
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
}

export function extractLinks(html: string, baseUrl: string): Link[] {
  const links: Link[] = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  const clean = stripNonContent(html);
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) {
    const href = readAttr(m[1] ?? "", "href");
    if (!href) continue;
    let url: URL | undefined;
    try {
      url = new URL(decodeEntities(href.trim()), baseUrl);
    } catch {
      url = undefined;
    }
    links.push({ href, url, text: htmlToText(m[2] ?? "") });
  }
  return links;
}

const EMAIL_RE = /^[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}$/i;

/** First email address published as a mailto: link. */
export function firstMailto(links: Link[]): string | undefined {
  for (const l of links) {
    if (l.url?.protocol !== "mailto:") continue;
    let addr = l.url.pathname;
    try {
      addr = decodeURIComponent(addr);
    } catch {
      /* keep raw */
    }
    addr = addr.split(",")[0]?.trim() ?? "";
    if (EMAIL_RE.test(addr)) return addr.toLowerCase();
  }
  return undefined;
}

/** First phone number published as a tel: link. */
export function firstTel(links: Link[]): string | undefined {
  for (const l of links) {
    if (l.url?.protocol !== "tel:") continue;
    let raw = l.url.pathname;
    try {
      raw = decodeURIComponent(raw);
    } catch {
      /* keep raw */
    }
    const digits = raw.replace(/[^\d+]/g, "");
    if (digits.replace(/\D/g, "").length >= 10) return raw.trim();
  }
  return undefined;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Which of the keywords appear in the text, as whole words, ignoring case. */
export function matchKeywords(text: string, keywords: string[]): string[] {
  const found: string[] = [];
  for (const kw of keywords) {
    const pattern = escapeRegex(kw.trim()).replace(/\s+/g, "\\s+");
    if (!pattern) continue;
    if (new RegExp(`\\b${pattern}\\b`, "i").test(text)) found.push(kw.trim());
  }
  return found;
}
