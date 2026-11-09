/**
 * OpenStreetMap source: law offices (office=lawyer) within a radius of a point, via the Overpass API.
 *
 * Data © OpenStreetMap contributors, available under the Open Database License (ODbL).
 * The public Overpass servers are run by volunteers: this makes ONE request per run.
 * For heavy or commercial use, point OVERPASS_URL at a paid or self-hosted Overpass instance.
 * OpenStreetMap coverage of US law offices is incomplete, so treat this as a supplement to a seed list.
 */
import type { Candidate } from "../types.js";

export const DEFAULT_OVERPASS_URL = "https://overpass-api.de/api/interpreter";
export const OSM_SOURCE = "OpenStreetMap (© OpenStreetMap contributors, ODbL)";
export const MAX_RADIUS_KM = 50;

export interface Near {
  lat: number;
  lon: number;
  radiusKm: number;
}

export function parseNear(value: string, radiusKm: number): Near {
  const parts = value.split(",").map((p) => Number(p.trim()));
  const [lat, lon] = parts;
  if (parts.length !== 2 || lat === undefined || lon === undefined || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error(`--near must look like "41.08,-81.52" (latitude,longitude); got "${value}"`);
  }
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    throw new Error(`--near is out of range: "${value}"`);
  }
  if (!Number.isFinite(radiusKm) || radiusKm <= 0 || radiusKm > MAX_RADIUS_KM) {
    throw new Error(`--radius-km must be between 0 and ${MAX_RADIUS_KM}; got ${radiusKm}`);
  }
  return { lat, lon, radiusKm };
}

export function buildOverpassQuery(n: Near): string {
  const meters = Math.round(n.radiusKm * 1000);
  return `[out:json][timeout:60];nwr["office"="lawyer"](around:${meters},${n.lat},${n.lon});out center tags;`;
}

interface OverpassElement {
  tags?: Record<string, string>;
}

export function parseOverpass(json: unknown): Candidate[] {
  const elements = (json as { elements?: OverpassElement[] } | null)?.elements;
  if (!Array.isArray(elements)) throw new Error("Overpass reply had no elements list");
  const out: Candidate[] = [];
  for (const el of elements) {
    const t = el.tags ?? {};
    const firm = (t.name ?? "").trim();
    if (!firm) continue;
    const street = [t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" ");
    const address = [street, t["addr:city"], t["addr:state"], t["addr:postcode"]].filter(Boolean).join(", ");
    out.push({
      firm,
      website: (t.website ?? t["contact:website"] ?? t.url ?? "").trim() || undefined,
      phone: (t.phone ?? t["contact:phone"] ?? "").trim() || undefined,
      address: address || undefined,
      source: OSM_SOURCE,
    });
  }
  return out;
}

export interface OverpassOptions {
  endpoint: string;
  userAgent: string;
  timeoutMs: number;
  stopCheck: () => void;
}

export async function fetchOsmCandidates(n: Near, o: OverpassOptions): Promise<Candidate[]> {
  o.stopCheck();
  const res = await fetch(o.endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": o.userAgent },
    body: `data=${encodeURIComponent(buildOverpassQuery(n))}`,
    signal: AbortSignal.timeout(o.timeoutMs),
  });
  if (!res.ok) throw new Error(`Overpass returned HTTP ${res.status}`);
  return parseOverpass(await res.json());
}
