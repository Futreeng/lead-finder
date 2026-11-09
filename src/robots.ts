/**
 * Minimal robots.txt support following RFC 9309:
 * - the group naming our product token wins over the "*" group
 * - longest matching rule wins; on a tie, Allow wins
 * - "*" wildcards and a trailing "$" anchor are supported
 */
export interface RobotsRules {
  allow: string[];
  disallow: string[];
  crawlDelaySec?: number;
}

interface Group {
  agents: string[];
  allow: string[];
  disallow: string[];
  crawlDelaySec?: number;
}

export const ALLOW_ALL: RobotsRules = { allow: [], disallow: [] };

export function parseRobots(text: string, agentToken: string): RobotsRules {
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastLineWasAgent = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (key === "user-agent") {
      if (!current || !lastLineWasAgent) {
        current = { agents: [], allow: [], disallow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastLineWasAgent = true;
      continue;
    }
    lastLineWasAgent = false;
    if (!current) continue;

    if (key === "allow") {
      if (value) current.allow.push(value);
    } else if (key === "disallow") {
      if (value) current.disallow.push(value);
    } else if (key === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.crawlDelaySec = n;
    }
  }

  const token = agentToken.toLowerCase();
  const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && a !== "" && token.includes(a)));
  const chosen = specific.length > 0 ? specific : groups.filter((g) => g.agents.includes("*"));

  const rules: RobotsRules = { allow: [], disallow: [] };
  for (const g of chosen) {
    rules.allow.push(...g.allow);
    rules.disallow.push(...g.disallow);
    if (g.crawlDelaySec !== undefined) {
      rules.crawlDelaySec = Math.max(rules.crawlDelaySec ?? 0, g.crawlDelaySec);
    }
  }
  return rules;
}

function escapeRegex(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

function ruleToRegex(rule: string): RegExp {
  const anchored = rule.endsWith("$");
  const body = (anchored ? rule.slice(0, -1) : rule).split("*").map(escapeRegex).join(".*");
  return new RegExp("^" + body + (anchored ? "$" : ""));
}

/** pathAndQuery is the URL path plus query string, e.g. "/attorneys?page=2". */
export function isAllowed(pathAndQuery: string, rules: RobotsRules): boolean {
  let bestLength = -1;
  let allowed = true;
  for (const rule of rules.allow) {
    if (rule.length > bestLength && ruleToRegex(rule).test(pathAndQuery)) {
      bestLength = rule.length;
      allowed = true;
    }
  }
  for (const rule of rules.disallow) {
    if (rule.length > bestLength && ruleToRegex(rule).test(pathAndQuery)) {
      bestLength = rule.length;
      allowed = false;
    }
  }
  return allowed;
}
