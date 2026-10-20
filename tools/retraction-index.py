#!/usr/bin/env python3
"""Turn the Retraction Watch database into the index the userscript can carry.

The database itself is 68 MB of CSV and twenty columns, and a userscript cannot
ask every editor to download that to check thirty references. Four of those
columns answer the only question being asked — has this paper been retracted —
and this writes them out as one line per identifier:

    10.1016/j.radcr.2024.07.009<TAB>R<TAB>2025-04-11<TAB>10.1016/j.radcr.2024.12.027
    39165313<TAB>R<TAB>2025-04-11<TAB>39817091

The identifier comes FIRST, and that is the whole design. The browser never
parses this into a table: it holds the file as one string and asks it
`indexOf("\n" + doi + "\t")`, which on four megabytes costs a millisecond and
nothing in memory beyond the string itself. Ninety-five thousand entries in a
`Map` would be ten megabytes of objects to answer forty questions. There is no
column saying which scheme a line is keyed by, either — a DOI begins `10.` and
a PubMed ID is digits, so the identifier already says.

Then the kind of event, the date it happened, and the identifier of the notice
— which is the thing an editor wants next, since the notice is what says why
and is what gets cited in its place.

Only three kinds of event are kept:

    R   retraction
    E   expression of concern
    I   reinstatement — the retraction was itself withdrawn

Plain corrections are dropped. There are fifteen hundred of them and a
corrected paper is not a paper with a problem; flagging it would train
everybody to ignore the flag.

Reinstatements are the reason this is resolved HERE rather than in the browser.
The database keeps one row per event, so a paper can be in it twice, and
158 of them carry a reinstatement. What the script needs is the state the
paper is in now — so the events for one identifier are collapsed into the one
that governs: the latest, and, on the same date, the most serious.

Usage:

    python3 tools/retraction-index.py                       # from the CSV in this folder
    python3 tools/retraction-index.py --download            # fetch a fresh one first
    python3 tools/retraction-index.py --out other-name.txt

The database is Retraction Watch's, made available by Crossref under CC BY 4.0,
and the file this writes carries that attribution in its header.
"""

import argparse
import csv
import datetime as dt
import http.client
import os
import re
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CSV_NAME = 'retraction_watch.csv'
OUT_NAME = 'retraction-index.txt'

# Crossref hosts the database and asks for an address in the query string
# rather than a key. Nothing is sent back and nothing is signed up for; it is
# how they count who is using it.
SOURCE = 'https://api.labs.crossref.org/data/retractionwatch?{mailto}'
MAILTO = 'radiopaedia-lint@users.noreply.github.com'

# The four kinds the database uses, and the one letter each becomes. The order
# is also the precedence: on one identifier, the lower number wins a tie.
KINDS = {'Reinstatement': ('I', 0), 'Retraction': ('R', 1),
         'Expression of concern': ('E', 2), 'Correction': (None, 3)}

DOI = re.compile(r'^10\.\d{4,9}/\S+$')
PMID = re.compile(r'^\d{1,8}$')

# What a plausible database looks like, because this runs unattended once a week
# and a commit is published to every installed copy of the script the moment it
# lands. The ways this goes wrong are not subtle — an HTML error page served
# where a CSV was asked for, a truncated download, a renamed column — and all
# of them end in an index that is far too small rather than slightly wrong.
CSV_HEADER = 'Record ID,Title,'
CSV_MIN = 40 * (1 << 20)       # 68 MB today, and a database of retractions only grows
# Crossref send it chunked, with no length to check the end against, and a
# weekly unattended job will meet a connection that stops early — the first run
# of this did, at 659 kB of 68 MB. So the end is checked another way and a
# truncated read is retried rather than reported.
WAITS = (5, 20, 60)            # seconds between attempts; four attempts in all
ROWS_MIN = 60_000              # 73,315 today
NEEDED = ('RetractionNature', 'RetractionDate', 'OriginalPaperDOI',
          'OriginalPaperPubMedID', 'RetractionDOI', 'RetractionPubMedID')
SHRINK = 0.95                  # of the entries the index already had

# Three that have been retracted for years and will not stop being retracted.
# A format change that still parses would quietly empty the index of meaning,
# and nothing else here would notice.
CANARIES = ('10.1016/s0140-6736(97)11096-0', '9500320', '10.1016/j.radcr.2024.07.009')


class Truncated(Exception):
    """The connection stopped before the database did. Worth another go."""


def fetch(url, part):
    """One attempt, straight to `part`. Returns the bytes written.

    Raised rather than returned when the answer stops early, because that is
    the one failure here that another attempt fixes."""
    got = 0
    try:
        with urllib.request.urlopen(url, timeout=1800) as r, open(part, 'wb') as f:
            while chunk := r.read(1 << 20):
                f.write(chunk)
                got += len(chunk)
    except (http.client.IncompleteRead, urllib.error.URLError,
            TimeoutError, ConnectionError) as stopped:
        raise Truncated(f'{type(stopped).__name__} after {got // 1024} kB') from stopped

    with open(part, 'rb') as f:
        head = f.read(len(CSV_HEADER)).decode('utf-8', 'replace')
        f.seek(max(0, got - 1))
        tail = f.read(1)

    # The wrong file is not a thing to retry: an error page served where a CSV
    # was asked for will be served again.
    if head != CSV_HEADER:
        os.remove(part)
        sys.exit(f'that was not the database: it begins {head!r}, not {CSV_HEADER!r}')
    # These two are: both are what a connection that stopped early looks like
    # when it managed to stop politely. The database ends with a newline, and
    # a truncation that happens to clear CSV_MIN would not.
    if got < CSV_MIN:
        raise Truncated(f'{got // (1 << 20)} MB, and the database is not that small')
    if tail != b'\n':
        raise Truncated(f'it ends {tail!r}, mid-row')
    return got


def download(path):
    """The current database, fetched beside the old one and moved over it last.

    Written to `.part` and renamed, so a download that fails, arrives as an
    error page or stops early leaves the copy that was already there — which
    still builds a correct index, one week staler."""
    url = SOURCE.format(mailto=MAILTO)
    part = f'{path}.part'
    for attempt, wait in enumerate((*WAITS, None), start=1):
        print(f'fetching {url} (attempt {attempt})', file=sys.stderr)
        try:
            got = fetch(url, part)
        except Truncated as short:
            print(f'  stopped early: {short}', file=sys.stderr)
            if wait is None:
                if os.path.exists(part):
                    os.remove(part)
                sys.exit(f'the database could not be fetched whole in {attempt} attempts')
            time.sleep(wait)
            continue
        os.replace(part, path)
        print(f'{got // (1 << 20)} MB written to {path}', file=sys.stderr)
        return


def a_date(raw):
    """`6/28/2023 0:00` as `2023-06-28`, and nothing at all when it is not a date.

    The column is written by hand and shows it: some rows carry a time, some
    do not, and a few carry neither a month nor a day worth printing."""
    m = re.match(r'\s*(\d{1,2})/(\d{1,2})/(\d{4})', raw or '')
    if not m:
        m = re.search(r'(\d{4})', raw or '')
        return m.group(1) if m else ''
    month, day, year = (int(g) for g in m.groups())
    try:
        return dt.date(year, month, day).isoformat()
    except ValueError:
        return str(year)


def clean_doi(raw):
    doi = (raw or '').strip().strip('.').lower()
    doi = re.sub(r'^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)', '', doi)
    return doi if DOI.match(doi) else ''


def clean_pmid(raw):
    """A PubMed ID, or nothing.

    `00000000` is this database's way of saying it has not got one, and it
    appears on tens of thousands of rows: left alone it would match nothing,
    stripped of its zeros it would match everything that stripped to nothing."""
    pmid = (raw or '').strip().lstrip('0')
    return pmid if PMID.match(pmid) and pmid != '0' else ''


def build(csv_path):
    """One governing event per identifier.

    Keyed by `(D|P, identifier)` rather than by paper: the two columns of a row
    are two ways into the same event, and a reference quoting only one of them
    still has to find it."""
    events = {}
    rows = 0
    csv.field_size_limit(1 << 30)
    with open(csv_path, newline='', encoding='utf-8', errors='replace') as f:
        reader = csv.DictReader(f)
        missing = [c for c in NEEDED if c not in (reader.fieldnames or [])]
        if missing:
            sys.exit('the database has been renamed under us — no column '
                     + ', '.join(missing))
        for row in reader:
            rows += 1
            code, rank = KINDS.get((row.get('RetractionNature') or '').strip(), (None, 9))
            if not code:
                continue
            when = a_date(row.get('RetractionDate'))
            for kind, paper, notice in (
                ('D', clean_doi(row.get('OriginalPaperDOI')), clean_doi(row.get('RetractionDOI'))),
                ('P', clean_pmid(row.get('OriginalPaperPubMedID')),
                 clean_pmid(row.get('RetractionPubMedID'))),
            ):
                if not paper:
                    continue
                # A notice that is the paper is a row pointing at itself, which
                # a few hundred of them do; printing it would send the editor
                # back to the reference they are standing on.
                if notice == paper:
                    notice = ''
                here = (when, rank, code, notice)
                there = events.get((kind, paper))
                # Later wins; same date, more serious wins. The date is ISO by
                # now, so comparing the strings compares the days.
                if there is None or (when, -rank) > (there[0], -there[1]):
                    events[(kind, paper)] = here
    return rows, events


def write(out_path, rows, events, source_mtime):
    """The file, DOIs first and PubMed IDs after, each block sorted.

    Sorted so that regenerating it next month is a diff somebody can read:
    a few hundred lines inserted where they belong, rather than a file that
    changed everywhere. The two blocks are kept apart for the same reason —
    sorted together, `10.` DOIs and the PubMed IDs that start with a 1 would
    interleave, and every new DOI would move a PubMed ID."""
    dois = sorted(k for k in events if k[0] == 'D')
    pmids = sorted((k for k in events if k[0] == 'P'), key=lambda k: int(k[1]))
    kinds = {}
    for _, _, code, _ in events.values():
        kinds[code] = kinds.get(code, 0) + 1

    lines = [
        '# The Retraction Watch database, reduced to what a reference check asks of it.',
        '#',
        '# Source: Retraction Watch, via Crossref - https://doi.org/10.13003/c23rw1d9',
        '#         CC BY 4.0. Database of %d records, dated %s.' % (rows, source_mtime),
        '# Built:  %s by tools/retraction-index.py' % dt.date.today().isoformat(),
        '# Holds:  %d lines - %d by DOI, then %d by PubMed ID'
        % (len(events), len(dois), len(pmids)),
        '#         %s' % ', '.join('%s %d' % (c, n) for c, n in sorted(kinds.items())),
        '#',
        '# identifier<TAB>event<TAB>date<TAB>notice',
        '#   event   R retraction, E expression of concern, I reinstatement',
        '#   notice  the identifier of the notice, in the same scheme, where there is one',
        '#',
        '# The identifier is first because this file is read by searching it for',
        r'# a newline, the identifier and a tab, and nothing else. It is also what',
        '# says which scheme the line is keyed by: a DOI begins "10.", a PubMed ID',
        '# is digits.',
        '#',
        '# One line per identifier, not per event: where a paper has been through more',
        '# than one of these, the line is the one that governs it now.',
    ]
    for block in (dois, pmids):
        for key in block:
            when, _, code, notice = events[key]
            lines.append('\t'.join((key[1], code, when, notice)).rstrip('\t'))
    body = '\n'.join(lines) + '\n'
    with open(out_path, 'w', encoding='utf-8') as f:
        f.write(body)
    return len(body.encode())


def entries(path):
    """How many identifiers a built index holds, or zero if there is not one."""
    if not os.path.exists(path):
        return 0
    with open(path, encoding='utf-8') as f:
        return sum(1 for line in f if not line.startswith('#'))


def vouch(out_path, rows, events):
    """Refuse to write an index that is not one.

    Everything above this point can fail and be noticed. This is the case
    where it all worked and the answer is still wrong — fewer records than any
    real database has, or a file that has lost a tenth of what it held last
    week, or one that no longer knows about three papers that have been
    retracted for years."""
    if rows < ROWS_MIN:
        sys.exit(f'{rows} records parsed, and the database has at least {ROWS_MIN}')
    for canary in CANARIES:
        found = events.get(('D' if canary.startswith('10.') else 'P', canary))
        if not found or found[2] != 'R':
            sys.exit(f'{canary} is retracted and this index does not say so')
    had = entries(out_path)
    if had and len(events) < had * SHRINK:
        sys.exit(f'{len(events)} entries where there were {had}: '
                 'that is a loss, not an update (--force to write it anyway)')


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--csv', default=os.path.join(HERE, CSV_NAME))
    ap.add_argument('--out', default=os.path.join(HERE, OUT_NAME))
    ap.add_argument('--download', action='store_true',
                    help='fetch the current database from Crossref first')
    ap.add_argument('--force', action='store_true',
                    help='write the index even if it has lost entries')
    args = ap.parse_args()

    if args.download:
        download(args.csv)
    if not os.path.exists(args.csv):
        sys.exit(f'{args.csv} is not there. Run with --download to fetch it.')

    stamp = dt.date.fromtimestamp(os.path.getmtime(args.csv)).isoformat()
    rows, events = build(args.csv)
    if not args.force:
        vouch(args.out, rows, events)
    size = write(args.out, rows, events, stamp)
    print(f'{rows} records → {len(events)} lines, {size // 1024} kB in {args.out}',
          file=sys.stderr)


if __name__ == '__main__':
    main()
