/**
 * Checks one firm's public website: practice keywords, attorney count, and published contact details.
 * Reads at most `maxPagesPerSite` pages: the homepage, the attorneys page, and (only if needed)
 * a practice areas page. Every number it reports says how it was found, so a person can verify it.
 */
import type { Settings } from "./config.js";
import type { Fetcher } from "./http.js";
import { extractLinks, firstMailto, firstTel, htmlToText, matchKeywords, pageTitle, type Link } from "./html.js";
import type { Candidate, Enriched } from "./types.js";
import { domainOf, hasExplicitScheme, normalizeWebsite } from "./urls.js";

/** Folders that hold one page per attorney. */
const ATTORNEY_DIRS = new Set([
  "attorneys",
  "attorney",
  "lawyers",
  "lawyer",
  "our-attorneys",
  "our-lawyers",
  "attorney-profiles",
  "attorney-profile",
  "professionals",
  "our-professionals",
]);

/**
 * Folders that may list attorneys AND paralegals or office staff together.
 * Staff-only folders such as /staff/ are deliberately not here: people in them are never attorneys.
 */
const MIXED_DIRS = new Set([
  "people",
  "our-people",
  "team",
  "our-team",
  "meet-the-team",
  "meet-our-team",
]);

/** Page names that sit in those folders but are not a person. */
const NOT_A_PERSON = new Set([
  "page",
  "category",
  "feed",
  "tag",
  "tags",
  "index",
  "all",
  "search",
  "practice-areas",
  "practice-area",
  "areas-of-practice",
  "contact",
  "contact-us",
  "about",
  "about-us",
  "our-firm",
  "the-firm",
  "careers",
  "join-our-team",
  "testimonials",
  "reviews",
  "faq",
  "faqs",
  "blog",
  "news",
  "locations",
  "office-locations",
  "staff",
  "support-staff",
  "paralegals",
  "of-counsel",
  "attorneys",
  "our-attorneys",
  "our-team",
  "team",
]);

const PAGE_EXT = /\.(html?|php|aspx?)$/;

export interface ProfileLinks {
  paths: string[];
  mayIncludeStaff: boolean;
}

/**
 * Same-site links shaped like /attorneys/jane-doe or /about/our-team/jane-doe.
 * When a site has attorney-only profile folders (/attorneys/, /lawyers/), only those are counted,
 * so staff pages elsewhere never inflate the number. Mixed "team" folders are used only as a
 * fallback, and are flagged because they may include staff.
 */
export function findProfileLinks(links: Link[], siteDomain: string): ProfileLinks {
  const attorneyPaths = new Set<string>();
  const mixedPaths = new Set<string>();
  for (const l of links) {
    if (!l.url || domainOf(l.url.href) !== siteDomain) continue;
    const segs = l.url.pathname
      .split("/")
      .filter(Boolean)
      .map((s) => s.toLowerCase().replace(PAGE_EXT, ""));
    if (segs.length < 2 || segs.length > 3) continue;
    const dir = segs[segs.length - 2] ?? "";
    const slug = segs[segs.length - 1] ?? "";
    const isAttorneyDir = ATTORNEY_DIRS.has(dir);
    const isMixedDir = MIXED_DIRS.has(dir);
    if (!isAttorneyDir && !isMixedDir) continue;
    if (NOT_A_PERSON.has(slug)) continue;
    // Person pages are almost always "first-last" style; this skips things like /team/overview.
    if (!/^[a-z][a-z0-9.'_-]*[-_][a-z0-9.'_-]*[a-z0-9]$/.test(slug)) continue;
    (isAttorneyDir ? attorneyPaths : mixedPaths).add("/" + segs.join("/"));
  }
  if (attorneyPaths.size > 0) return { paths: [...attorneyPaths].sort(), mayIncludeStaff: false };
  return { paths: [...mixedPaths].sort(), mayIncludeStaff: mixedPaths.size > 0 };
}

/** Distinct "Name, Esq." mentions, a fallback when a site has no attorney profile pages. */
export function findEsqNames(text: string): string[] {
  const names = new Set<string>();
  const re = /\b([A-Z][a-zA-Z'.-]+(?:\s+[A-Z]\.)?(?:\s+[A-Z][a-zA-Z'-]+){1,2}),?\s+Esq\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1]) names.add(m[1].replace(/\s+/g, " "));
  }
  return [...names].sort();
}

const LISTING_PATH = /\/(attorneys?|lawyers?|our-attorneys|our-lawyers|attorney-profiles|professionals|our-professionals|people|our-people|team|our-team|meet-the-team|meet-our-team)\/?$/i;
const LISTING_TEXT = /\b(our attorneys|attorneys|our lawyers|lawyers|attorney profiles|our team|meet the team|our people|professionals)\b/i;
const PRACTICE_PATH = /(practice|services|estate|probate|trust|wills|elder)/i;
const PRACTICE_TEXT = /\b(practice areas?|areas of practice|services|estate planning|probate|trusts?|wills|elder law)\b/i;

function sameSitePages(links: Link[], siteDomain: string, exclude: string[]): URL[] {
  const seen = new Set(exclude.map(stripHash));
  const out: URL[] = [];
  for (const l of links) {
    if (!l.url || domainOf(l.url.href) !== siteDomain) continue;
    if (l.url.protocol !== "http:" && l.url.protocol !== "https:") continue;
    const key = stripHash(l.url.href);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l.url);
  }
  return out;
}

function stripHash(href: string): string {
  return href.replace(/#.*$/, "");
}

export function pickAttorneyPage(links: Link[], siteDomain: string, homeUrl: string): string | undefined {
  let best: { url: string; score: number } | undefined;
  const textByHref = new Map(links.filter((l) => l.url).map((l) => [stripHash(l.url!.href), l.text]));
  for (const u of sameSitePages(links, siteDomain, [homeUrl])) {
    const text = textByHref.get(stripHash(u.href)) ?? "";
    let score = 0;
    const pm = LISTING_PATH.exec(u.pathname);
    if (pm?.[1]) score += /attorney|lawyer|professional/i.test(pm[1]) ? 3 : 2;
    if (LISTING_TEXT.test(text)) score += 1;
    if (score > 0 && (!best || score > best.score)) best = { url: stripHash(u.href), score };
  }
  return best?.url;
}

export function pickPracticePage(links: Link[], siteDomain: string, exclude: string[]): string | undefined {
  const textByHref = new Map(links.filter((l) => l.url).map((l) => [stripHash(l.url!.href), l.text]));
  for (const u of sameSitePages(links, siteDomain, exclude)) {
    const text = textByHref.get(stripHash(u.href)) ?? "";
    if (PRACTICE_PATH.test(u.pathname) || PRACTICE_TEXT.test(text)) return stripHash(u.href);
  }
  return undefined;
}

export async function enrichCandidate(c: Candidate, fetcher: Fetcher, s: Settings): Promise<Enriched> {
  const e: Enriched = { ...c, practiceTerms: [], checked: false, notes: [] };
  const site = normalizeWebsite(c.website);
  if (!site) {
    e.checkError = c.website ? `website "${c.website}" is not a valid address` : "no website listed";
    return e;
  }
  e.website = site;
  e.domain = domainOf(site);

  let home = await fetcher.get(site);
  let pagesUsed = 1;
  if (!home.ok && !hasExplicitScheme(c.website)) {
    // The seed had no http/https; we tried https first, now try plain http once.
    const httpSite = site.replace(/^https:/, "http:");
    home = await fetcher.get(httpSite);
    if (home.ok) e.website = httpSite;
  }
  if (!home.ok) {
    e.checkError = `homepage: ${home.reason}`;
    return e;
  }
  e.checked = true;

  const finalDomain = domainOf(home.url);
  if (finalDomain && finalDomain !== e.domain) {
    e.notes.push(`Website redirects to ${finalDomain}`);
    e.domain = finalDomain;
  }
  const domain = e.domain ?? "";

  const homeLinks = extractLinks(home.body, home.url);
  const homeText = htmlToText(home.body);
  const terms = new Set(matchKeywords(`${pageTitle(home.body)} ${homeText}`, s.keywords));
  // Links from the homepage and the attorneys page, counted together once at the end.
  const personLinks: Link[] = [...homeLinks];
  const esqNames = new Set(findEsqNames(homeText));
  e.phone ||= firstTel(homeLinks);
  e.publicEmail ||= firstMailto(homeLinks);

  const visited = [home.url];
  let attorneyPageUrl: string | undefined;
  const attorneyPage = pickAttorneyPage(homeLinks, domain, home.url);
  if (attorneyPage && pagesUsed < s.maxPagesPerSite) {
    const r = await fetcher.get(attorneyPage);
    pagesUsed++;
    visited.push(attorneyPage);
    if (r.ok) {
      attorneyPageUrl = r.url;
      const links = extractLinks(r.body, r.url);
      const text = htmlToText(r.body);
      personLinks.push(...links);
      findEsqNames(text).forEach((n) => esqNames.add(n));
      matchKeywords(text, s.keywords).forEach((t) => terms.add(t));
      e.phone ||= firstTel(links);
      e.publicEmail ||= firstMailto(links);
    } else {
      e.notes.push(`Attorneys page not read: ${r.reason}`);
    }
  }

  if (terms.size === 0 && pagesUsed < s.maxPagesPerSite) {
    const practicePage = pickPracticePage(homeLinks, domain, visited);
    if (practicePage) {
      const r = await fetcher.get(practicePage);
      pagesUsed++;
      if (r.ok) {
        matchKeywords(`${pageTitle(r.body)} ${htmlToText(r.body)}`, s.keywords).forEach((t) => terms.add(t));
      } else {
        e.notes.push(`Practice page not read: ${r.reason}`);
      }
    }
  }

  e.practiceTerms = s.keywords.filter((k) => terms.has(k));

  const profile = findProfileLinks(personLinks, domain);
  if (profile.paths.length > 0) {
    e.attorneyCount = profile.paths.length;
    e.attorneyCountMayIncludeStaff = profile.mayIncludeStaff;
    const where = attorneyPageUrl ? `on ${attorneyPageUrl}` : "on the homepage";
    e.attorneyCountNote =
      `Attorney count estimated: ${profile.paths.length} profile link(s) ${where}` +
      (profile.mayIncludeStaff ? ", may include non-attorney staff" : "");
  } else if (esqNames.size > 0) {
    e.attorneyCount = esqNames.size;
    e.attorneyCountNote = `Attorney count estimated: ${esqNames.size} name(s) written with "Esq."`;
  }
  return e;
}
