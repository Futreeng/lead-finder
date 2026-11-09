import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { FetchOutcome, Fetcher } from "../src/http.js";

/** A fetcher that serves canned pages and records what was asked for. No network. */
export class FakeFetcher implements Fetcher {
  readonly requested: string[] = [];
  constructor(private readonly pages: Record<string, string | { fail: string }>) {}

  async get(url: string): Promise<FetchOutcome> {
    this.requested.push(url);
    const page = this.pages[url];
    if (page === undefined) return { ok: false, url, reason: "HTTP 404" };
    if (typeof page !== "string") return { ok: false, url, reason: page.fail };
    return { ok: true, url, status: 200, body: page, contentType: "text/html; charset=utf-8" };
  }
}

export type Route = (req: IncomingMessage, res: ServerResponse) => void;

export interface TestServer {
  origin: string;
  hits: string[];
  close: () => Promise<void>;
}

/** Starts a local web server on 127.0.0.1 with the given routes (path -> handler). */
export async function startServer(routes: Record<string, Route>): Promise<TestServer> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    const path = req.url ?? "/";
    hits.push(path);
    const route = routes[path];
    if (route) route(req, res);
    else {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export function html(body: string, title = "Test"): Route {
  return (_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`);
  };
}

export function text(body: string, status = 200): Route {
  return (_req, res) => {
    res.writeHead(status, { "content-type": "text/plain" });
    res.end(body);
  };
}

export function redirect(location: string, status = 301): Route {
  return (_req, res) => {
    res.writeHead(status, { location });
    res.end();
  };
}

export function page(body: string, title = "Test"): string {
  return `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
}

export function profileLinks(dir: string, count: number): string {
  const first = ["alex", "blair", "casey", "drew", "emery", "finley", "gray", "harper", "indy", "jordan", "kai", "logan", "morgan", "noel", "oakley", "parker"];
  return first
    .slice(0, count)
    .map((f) => `<a href="/${dir}/${f}-smith/">${f} Smith</a>`)
    .join("\n");
}
