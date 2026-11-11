# lead-finder

Futreeng's all-in-one outreach tool for small estate planning law firms (2 to 10 attorneys).
It runs on one computer and covers the whole process from the training packet:

1. **Find firms**: looks up law offices and checks each firm's own website politely.
2. **Review**: every firm it finds waits in a review queue until a person accepts or rejects it.
3. **Tracker**: one list of every firm, its status, last contact and next step. Exports to CSV for Google Sheets.
4. **Emails**: drafts the first email, follow-up, report cover note and call recap from the packet templates.
5. **Speed check**: records the firm's permission, logs the measured times, and builds the one-page report.
6. **Numbers**: the weekly counts and rates for the Friday review.

**It never contacts anyone.** No emails, no form submissions, no calls. A person copies each approved email
into Outlook and sends it, then marks it sent in the app.

## Human review and the off switch (mandatory)

- **Review queue:** nothing found by a search can be emailed until a person accepts it.
- **Approver PIN:** emails and reports cannot be copied or marked sent until the approver types the PIN.
  A draft still holding a `[placeholder]`, or missing the mailing address or the opt-out line, cannot be approved.
- **Permission first:** a speed check cannot be logged until the firm's permission (who, when, how) is recorded.
- **Opt-outs:** an opted-out firm gets no new drafts, its unsent drafts are deleted, and only the approver can undo it.
- **Off switch:** the Off switch button in the app, or an empty file named `STOP` in the project folder
  (or `LEAD_FINDER_DISABLED=1`), blocks every website check, including one already running.
  Delete the `STOP` file to turn it back on.

## Setup

Needs Node.js 20 or newer.

```bash
git clone https://github.com/Futreeng/lead-finder.git
cd lead-finder
npm install
npm test
```

`npm test` builds the project and runs the test suite. It uses local test servers only, no internet.

## The app

```bash
npm start
```

This builds the project, starts the app, and opens it in your browser at `http://127.0.0.1:4321/`.
Only this computer can open it. Press Ctrl+C in the terminal to stop it.

First time: open **Settings**, fill in your name, phone or email, and mailing address, and set the approver PIN.

- Data is saved in `data/lead-finder.json` with a daily copy in `data/backups/`. The `data/` folder is never committed.
- If the data file is ever damaged, the app refuses to start rather than overwrite it. Copy the newest backup over it.
- Already have a prospects CSV from the command line tool or a tracker export? Use **Tracker, Import CSV**.
  Firms marked `Opted out` in the file stay opted out.
- Other options: `npm start -- --no-open` (do not open the browser), `npm start -- --port=5000`.

## Command line tool

The same finder also runs without the app and writes CSV files.


### 1. With a seed list (main way)

Make a CSV of firms you found by hand, for example by browsing Google Maps or a bar association's public
lawyer search in your browser. Only `Firm` is required; `Website` is what lets the tool check a firm.

```csv
Firm,Website,Phone,Address
Example Estate Law,https://www.example-estate-law.test,330-555-0100,"1 Main St, Akron, OH"
```

Save it as `seeds/akron.csv` (the `seeds/` folder is never committed), then:

```bash
npm run build
node dist/src/cli.js --seed seeds/akron.csv --dry-run --limit 5   # try it first, writes nothing
node dist/src/cli.js --seed seeds/akron.csv                        # writes the CSV files
```

### 2. Add OpenStreetMap law offices near a point

```bash
node dist/src/cli.js --near 41.08,-81.52 --radius-km 15 --seed seeds/akron.csv
```

`41.08,-81.52` is roughly downtown Akron. This makes one request to the public Overpass API.
OpenStreetMap does not list every US law office, so use it to add to a seed list, not replace it.

### Skip firms already in the tracker or opted out

Export the tracker to CSV and pass it in. Any firm whose website or name is in it is skipped and never visited.

```bash
node dist/src/cli.js --seed seeds/akron.csv --exclude exclude/tracker.csv
```

A plain text file with one website per line also works.

## Output

Each run writes two files to `output/` (never committed):

- `prospects-<date>-<time>.csv`: firms that look like a fit. Columns, in order:
  Firm, Contact, Attorneys, Practice area, Website, Status, Last contact, Next step and date, Notes
  (the tracker columns), then Phone, Public email, Source.
- `skipped-<date>-<time>.csv`: every firm left out, with the reason, so nothing disappears silently.

**Into Google Sheets:** open the tracker sheet, then File, Import, Upload, choose the prospects CSV,
and pick "Append to current sheet". The first nine columns line up with the tracker.

Cells that could run as spreadsheet formulas are prefixed with an apostrophe for safety.

## How it decides

For each firm with a website it reads the homepage, the attorneys page, and (only if no keyword was found yet)
one practice areas page. At most 3 pages per firm.

- **Practice area:** looks for estate planning words (estate planning, wills, trusts, probate, elder law, and
  similar). Change them with `--keywords`. Firms with none are skipped unless you add `--include-unmatched`.
- **Attorney count:** counts links to individual profile pages like `/attorneys/jane-doe`, or names written
  with "Esq." if there are no profile pages. This is an estimate and the Notes column says how it was found.
  If it cannot tell, the Attorneys cell is left blank and the note says "check by hand". It never guesses.
- **Size:** fewer than 2 or more than 10 detected attorneys is skipped (change with `--min-attorneys` and
  `--max-attorneys`). Counts from "team" or "people" pages may include staff, so those are kept and flagged.

## Being a good web citizen

- Reads and obeys every site's `robots.txt`, including `Crawl-delay`. If a site's `robots.txt` returns a server
  error, the site is skipped.
- Waits at least 2 seconds between requests to the same site (`--delay-ms`, minimum 500).
- Identifies itself with the user agent `FutreengLeadFinder/0.1`. Override with `LEAD_FINDER_USER_AGENT`.
- Only sends GET requests and caps each page at 2 MB.

## Sources and their rules

| Source | Used? | Why |
| --- | --- | --- |
| Firms' own public websites | Yes | Public pages, checked against each site's robots.txt |
| OpenStreetMap via Overpass API | Yes, optional | Open data under the ODbL. Credit: © OpenStreetMap contributors. The public Overpass servers are volunteer run and ask heavy or commercial users to use a paid or self-hosted instance; set `OVERPASS_URL` to switch. One request per run. |
| Justia lawyer directory | No | Its Terms of Service forbid commercial reuse of the service and access other than through its own interface |
| Other directories (Avvo, FindLaw, Martindale, state bar search) | No | Not reviewed. Browse them by hand to build seed lists; do not automate them without checking their terms first |

## Commands

```text
--seed <file.csv>        Firms you found by hand
--near <lat,lon>         Also look up OpenStreetMap law offices near this point
--radius-km <n>          Radius for --near in km, up to 50 (default 15)
--exclude <file>         Tracker export or website list to skip (repeatable)
--limit <n>              Check at most n firms
--dry-run                Check sites and print results, write no files
--out <folder>           Output folder (default output)
--delay-ms <n>           Wait between requests to one site (default 2000, minimum 500)
--min-attorneys <n>      Default 2
--max-attorneys <n>      Default 10
--keywords "<a,b,c>"     Practice keywords to look for
--include-unmatched      Keep firms with no practice keyword found
--help                   Show help
```

## Project layout

```text
src/app/main.ts      app entry point (npm start)
src/app/server.ts    local web server (127.0.0.1 only, token and host checks)
src/app/pipeline.ts  every rule: review queue, PIN approval, permission, opt-outs
src/app/templates.ts email drafts and the speed check report
src/app/store.ts     data file with atomic saves and daily backups
src/app/metrics.ts   weekly numbers
public/              the app's page (plain HTML, CSS and JavaScript)
src/find.ts          finding pipeline shared by the app and the command line
src/cli.ts           command line entry point
src/run.ts           options and the overall run
src/killswitch.ts    STOP file and LEAD_FINDER_DISABLED off switch
src/http.ts          polite fetcher (robots.txt, delays, size cap, off switch before every request)
src/robots.ts        robots.txt rules
src/enrich.ts        reads a firm's site: keywords, attorney count, phone, email
src/filter.ts        repeats, exclusions, keep or skip decision
src/tracker.ts       tracker CSV columns
src/sources/seed.ts  seed CSV reader
src/sources/osm.ts   OpenStreetMap / Overpass lookup
test/                tests (local servers and saved pages only)
```
