// ==UserScript==
// @name         Radiopaedia Lint
// @namespace    https://radiopaedia.work/
// @homepageURL  https://github.com/gmadevs/radiopaedia-lint-userscript
// @supportURL   https://github.com/gmadevs/radiopaedia-lint-userscript/issues
// @downloadURL  https://raw.githubusercontent.com/gmadevs/radiopaedia-lint-userscript/main/radiopaedia-lint.user.js
// @updateURL    https://raw.githubusercontent.com/gmadevs/radiopaedia-lint-userscript/main/radiopaedia-lint.user.js
// @license      MIT
// @version      3.1.0
// @description  A Lint button next to the article title, coloured by what the radiopaedia.work linter found: red for errors, amber for warnings, blue for suggestions, grey for nothing to fix. Click it and the findings light up on the text in the editor, one at a time. In the margin, the sections this kind of article should have and has not got. And beside every reference, a Lint citation chip: it checks that one against radiopaedia.work/cite and shows, word by word, what differs.
// @match        https://radiopaedia.org/*
// @connect      radiopaedia.work
// @connect      raw.githubusercontent.com
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * How this hangs together
 * -----------------------
 * The radiopaedia.work linter has an API — `GET /api/v1/lint?article=…`,
 * JSON, no key — and that is what this script asks. `fromApi()` below turns
 * one entry of `lints[]` into one finding: `condition` gives the check
 * ("Radiopaedia.OxfordComma" → "Oxford Comma", the same words the linter's own
 * page prints), `trimmed` gives the line as plain text, `matched` gives the
 * offending words inside it, `line`/`position` say where they were.
 *
 * Before this the findings were read off the linter's HTML page, through
 * Tailwind classes that were not an API: a new stylesheet, and the button
 * quietly stopped finding anything on every article. Now a field would have to
 * be renamed for that to happen — and fourteen kilobytes of JSON arrive where
 * four hundred of markup used to.
 *
 * `matched` is the part with the most in it. The old parser had to guess which
 * words a finding was about by reading the quotes out of its prose; the API
 * simply says. `position` says WHICH copy of them, counted along the line, so
 * on a sentence with six commas in it the sixth is the one that lights up.
 *
 * The anchor is the SNIPPET, not `line:column`: add one paragraph above and
 * every number shifts, and the editor's lines are not the linter's lines to
 * begin with. A snippet, on the other hand, can simply be searched for in the
 * editor text.
 *
 * The editor DOM is never touched. No `<mark>` wrapped around the text: those
 * would end up inside the article the first time you save. The highlight is a
 * layer of rectangles laid over the page, drawn from the `getClientRects()` of
 * the Ranges and redrawn on every scroll — the content stays exactly as it was.
 *
 * The linter lints the PUBLISHED article, not the text sitting in your form.
 * The findings are a snapshot of how things were before you started, so "done"
 * is a mark you make, not a re-check. What can be verified for free is
 * verified: as soon as a snippet can no longer be found in the text, its
 * finding closes itself — which is also how you see that a fix landed.
 *
 * Two checks of the linter's are answered here rather than shown, and for the
 * same reason: the rule is right and the exception is something the linter has
 * no way of knowing. "We don't start a list item with a capital letter.
 * Exceptions are proper nouns." — on a radiology article half of those capitals
 * ARE proper nouns: Alvarado, Langerhans, the British Thoracic Society. And
 * "'ELISA' has no definition. Spell it out if it's unfamiliar to the
 * audience." — where a good few are not unfamiliar to anybody reading a
 * radiology article, and a few more are not abbreviations at all but the name
 * of a trial (YEARS, PERC) or of a consortium (cIMPACT-NOW).
 *
 * `proper-nouns.txt` and `acronyms.txt`, next to this file in the repository,
 * are the lists of the ones we have met; a finding one of them answers never
 * reaches the stage. When the word is not in there yet, the bar offers to add
 * it: the word goes to the clipboard, the right file opens on GitHub, and the
 * change is proposed from there. The lists are shared, so a word added once is
 * added for everybody — which is the whole reason they are files in a
 * repository and not a setting in a browser.
 *
 * The exception mechanism the API itself carries (`supportsExceptions`) is the
 * right place for all of this, and it is not open to us: only Radiopaedia's
 * own editors can register one. This is the second best thing.
 *
 * The references at the bottom of the article are checked by a second tool at
 * the same host, `radiopaedia.work/cite`: it takes a reference, works out what
 * to look up in it, asks Crossref or PubMed or Google Books, and gives back the
 * canonical form. The edit page keeps each reference in a box of its own with
 * a "Format citation" link under it, and a `Lint citation` chip goes beside
 * that link: one press asks about that one reference — matches, differs, or
 * nothing in there to look up. Where it differs the two forms are shown
 * with the words that changed lit up, and the corrected line, numbered by
 * where it stands in the list, goes to the clipboard for you to paste. The
 * editor is never written to, here as everywhere else.
 *
 * One request here is one request to Radiopaedia: the linter reads the article
 * on our behalf. This is a human clicking a button on one article at a time,
 * so that is fine — but it is why there is no prefetching and no automatic
 * retry, and why the result is kept in `sessionStorage` rather than asked for
 * again on every reload.
 */

(function () {
  'use strict';

  /* Automatic mode: the button says what the article is like before you click
   * it, which means asking the linter as the page opens. This is only the
   * DEFAULT — the switch beside the button decides, and remembers, and what it
   * writes wins over this line. Set it to false and a browser that has never
   * been told anything stays manual: nothing leaves it until you press Lint.
   *
   * Worth knowing what it costs: the linter reads the article from Radiopaedia
   * to answer, so this turns one request per CLICK into one request per
   * ARTICLE PAGE YOU OPEN. It is kept to the article page itself, it waits for
   * a tab you can actually see, and the answer is cached for the session — but
   * a morning of browsing is a morning of lint runs, and the API allows 60 a
   * minute. Nothing here retries, and a failure is silent: the button simply
   * stays the colour it was. */
  const PREVIEW_ON_LOAD = true;
  const AUTO_KEY = 'rlx-auto';      // the switch, remembered across sessions

  const API_URL = 'https://radiopaedia.work/api/v1/lint?article=';

  /* Forcing a fresh read, and where the ↻ beside the button goes.
   *
   * The API answers from what the linter last read. Ask twice for the same
   * article and the second answer arrives in a third of the time, word for
   * word the same, however much the text moved on in between — and there is
   * no parameter that clears that copy: `force`, `refresh`, `nocache` are all
   * taken and ignored. The one control that does clear it is the ⟳ on the
   * linter's own page, which is not a link but a Livewire action posted back
   * to the server. So this button presses that one, on the page it lives on,
   * rather than inventing a query string the API has never had. */
  const LINT_PAGE_URL = 'https://radiopaedia.work/lint/linter?slug=';
  const FORCE_TIMEOUT = 60_000;       // a forced run reads the article from Radiopaedia again
  const FORCE_MAX = 4 * 1024 * 1024;  // the linter's page, findings table and all

  /* The citation worker, and what one press of "Lint citation" costs.
   *
   * `?search=` takes the whole reference, works out for itself what to look up
   * in it, and asks Crossref, PubMed, Google Books or Elsevier — somebody
   * else's API at the far end of ours. So this is asked once, per click, per
   * reference, and never on its own initiative: an article with thirty
   * references checked on page load would be thirty lookups nobody sat down to
   * read, and the whole point of a button is that a person pressed it. */
  const CITE_URL = 'https://radiopaedia.work/cite?search=';
  const CITE_TIMEOUT = 60_000;      // Crossref and PubMed are at the far end of it
  const CITE_MAX = 1024 * 1024;     // a rendered page; anything bigger is not one
  const CITE_KEY = 'rlx-cite:';     // one answer, for this tab's session
  const CITES_KEY = 'rlx-cites';    // the chips on or off, remembered
  const LINTER_TIMEOUT = 60_000;    // the linter still reads the article from Radiopaedia, but a second or two does it
  const EDITOR_TIMEOUT = 30_000;    // how long we wait for the WYSIWYG to initialise
  const PENDING_KEY = 'rlx-lint-pending';
  const CACHE_KEY = 'rlx-lint-cache:';

  /* The shared lists, and the pages you add to them. Raw for reading, the
   * repository's own editor for writing: GitHub turns "edit a file you cannot
   * write to" into a fork and a pull request on its own, so proposing a word
   * costs a paste and a click and no account beyond the one the person already
   * has. Nothing is ever sent from here — the script reads those files and
   * nothing else, and the word travels through the clipboard, where you can
   * see it. */
  const RAW_URL = 'https://raw.githubusercontent.com/gmadevs/radiopaedia-lint-userscript/main/';
  const EDIT_URL = 'https://github.com/gmadevs/radiopaedia-lint-userscript/edit/main/';
  const LIST_TIMEOUT = 15_000;
  const LIST_MAX = 256 * 1024;      // a list of words; anything bigger is not one
  const PROPOSED_KEY = 'rlx-proposed';   // {word: the day you proposed it}

  /* One entry per check a list answers. `condition` is what the API calls the
   * check; `match` is asked whether the word the linter quoted is already on
   * the list and answers with the entry that covered it; `draft` is what gets
   * offered to the clipboard when it is not. The rest is wording — the bar and
   * the note say "names list" or "acronyms list" out of this table, so the two
   * differ in one place rather than in a dozen sentences.
   *
   * A third one would be three lines here and nothing anywhere else, which is
   * the only reason this is a table and not two copies of the same code. */
  const LISTS = {
    names: {
      condition: 'Radiopaedia.ListCaps',
      file: 'proper-nouns.txt',
      cache: 'rlx-names',           // the file, for this tab's session
      what: 'name', plural: 'names', of: 'names list', button: '+ Name',
      /* By prefix: the file says "Alvarado" and the item is "Alvarado score";
       * the file says "British Thoracic Society" and the item runs on for
       * another twenty words. */
      match: (text, entries) => startsWithEntry(text, entries),
      draft: (text) => properName(text),
    },
    acronyms: {
      condition: 'Radiopaedia.Acronyms',
      file: 'acronyms.txt',
      cache: 'rlx-acronyms',
      what: 'acronym', plural: 'acronyms', of: 'acronyms list', button: '+ Acronym',
      /* Whole word: this check quotes the acronym and nothing else, so there
       * is no longer phrase for a prefix to stand in for — and 'PE' is not
       * 'PET', which a prefix match would have to be told. */
      match: (text, entries) => sameAsEntry(text, entries),
      draft: (text) => fold(text) || null,
    },
  };
  for (const [key, list] of Object.entries(LISTS)) {
    list.key = key;
    list.url = RAW_URL + list.file;
    list.editUrl = EDIT_URL + list.file;
    list.entries = null;    // what the file said, or `null` for "we could not read it"
    list.asked = null;      // the request in flight, so two callers make one
  }

  // What a Cloudflare interstitial carries instead of the results.
  const CHALLENGE = ['start_challenge', 'bot_management', 'Verifying you are human'];

  const COLORS = {
    error:      { ink: '#dc2626', wash: 'rgba(220, 38, 38, .22)' },
    warning:    { ink: '#d97706', wash: 'rgba(217, 119, 6, .22)' },
    suggestion: { ink: '#2563eb', wash: 'rgba(37, 99, 235, .20)' },
    other:      { ink: '#6b7280', wash: 'rgba(107, 114, 128, .20)' },
  };
  const paint = (severity) => COLORS[severity] || COLORS.other;

  // How much room the highlight takes beyond the words themselves.
  const PAD_X = 3, PAD_Y = 1;
  // A finding you have just fixed, or ignored: still on screen, no longer a finding.
  const SETTLED = { ink: '#059669', wash: 'rgba(5, 150, 105, .18)' };

  // ————————————————————————————————————————————————————————————— text

  /* One line of it, whatever came in. */
  function tidy(v) {
    return String(v ?? '').replace(/\s+/g, ' ').trim();
  }

  /* The text of a piece of the article the API quotes back at us.
   *
   * `matched`, `display` and `match` carry the article's markup with them —
   * `<strong> </strong>`, `<sup>24</sup>`, `<h6>Others</h6>` — and what has to
   * be found in the editor is the text, not the tags. `DOMParser` rather than
   * an `innerHTML` on a detached node: the document it builds is inert, so
   * nothing in there runs, loads or fetches anything. Strings with no `<` in
   * them skip it, which is most of them. */
  function plain(html) {
    const raw = String(html ?? '');
    if (!raw.includes('<')) return tidy(raw);
    return tidy(new DOMParser().parseFromString(raw, 'text/html').body.textContent);
  }

  /* Typography folded onto its plain forms: curly quotes and dashes onto the
   * straight ones, runs of space onto one space, invisible characters onto
   * nothing at all. That last pass earns its place on its own — `\s` in JS
   * does **not** cover the zero-width space, and articles are full of them:
   * the linter quotes the "Radiographic features" heading with a U+200B stuck
   * to the front, and one of those, invisible to the eye, is enough for a
   * snippet never to be found.
   *
   * This is the shape words are read in when the words themselves matter —
   * the names in `proper-nouns.txt` are compared here, where "Alvarado" is
   * still two syllables and a capital A. */
  function fold(s) {
    return String(s ?? '')
      .replace(/[‘’ʼ]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[–—−]/g, '-')
      .replace(/[\u200b-\u200d\u2060\ufeff\u00ad]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* And the shape things get compared in when only the letters matter: the
   * fold, with the spacing and the case taken out too. Ignoring spacing is
   * what makes the comparison survive both the phantom spaces the linter drags
   * along from `<sup>` markers and quotes, and the missing ones between one
   * tag and the next in the editor. */
  function flat(s) {
    return fold(s).replace(/\s+/g, '').toLowerCase();
  }

  // ————————————————————————————————————————————— the findings

  /* The check's name, as the linter's own page prints it:
   * "Radiopaedia.StrongListColonPosition" → "Strong List Colon Position". The
   * API answers with the condition that fired, which is those same words run
   * together — putting the spaces back is the whole translation. */
  function checkName(condition) {
    const bare = String(condition ?? '').replace(/^.*\./, '');
    return bare.replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim() || 'Finding';
  }

  /* A line with its citation markers taken out.
   *
   * `<sup>2,4,6,11,12</sup>` is a list of references, not a sentence, and the
   * commas in it are not commas in the prose. They still have to come out of
   * the *counting* even though they stay in the text — see `nthInLine`. The
   * second pass catches a `<sup>` the slice cut in half, which is exactly what
   * happens when the position we are counting up to is inside one. */
  const CITATION = /<sup\b[^>]*>[\s\S]*?<\/sup>/gi;
  const CITATION_OPEN = /<sup\b[^>]*>[\s\S]*$/i;
  const unref = (html) => String(html ?? '').replace(CITATION, '').replace(CITATION_OPEN, '');

  /* Is this offset inside a citation? An unclosed `<sup>` in everything before
   * it is the whole test. */
  function inCitation(html, upTo) {
    const before = String(html ?? '').slice(0, upTo);
    return (before.match(/<sup\b/gi) || []).length > (before.match(/<\/sup>/gi) || []).length;
  }

  /* Which copy of the offending words, counted along the line they sit on.
   *
   * `matched` is often something the line holds several times over — a comma,
   * a semicolon, an acronym used twice — and the finding is about exactly one
   * of them. `position` says which: the offset of the match into `match`, the
   * raw line. Counting the copies that come before it gives the occurrence to
   * light up, and counting them in `flat()` shape is what keeps that number
   * true in the editor, where the markup is gone and the spacing is not the
   * linter's. */
  function nthInLine(lint) {
    const needle = flat(plain(lint.matched));
    const position = Number(lint.position);
    if (!needle || !lint.match || !(position > 1)) return 1;

    /* Zero means "do not narrow at all", and that is the honest answer when
     * the linter's own position lands inside a citation. "More than 5 commas
     * in a single sentence" is reported against the comma of
     * `<sup>2,4,6,11,12</sup>`: the finding is about the sentence, the
     * position is about the reference list, and there is no way to tell which
     * comma of the prose was meant — because none was. Lighting the whole
     * sentence says what the message says; lighting a comma inside the
     * superscript points at the one place the reader cannot act on. */
    if (inCitation(lint.match, position - 1)) return 0;

    const before = flat(plain(unref(String(lint.match).slice(0, position - 1))));
    let n = 1;
    for (let at = before.indexOf(needle); at >= 0; at = before.indexOf(needle, at + 1)) n++;
    return n;
  }

  /* Where the missing comma goes, for the findings that are about a comma
   * that is not there.
   *
   * "Use the Oxford comma in 'patchy, reticulonodular or mixed'" quotes the
   * phrase, and lighting the phrase says which one it means — but not where
   * the comma belongs, which is the only thing you actually have to know. It
   * belongs immediately before the last conjunction, and that is something the
   * phrase itself says: the last ` or ` / ` and ` / ` nor ` in it.
   *
   * Two offsets come back because two things need one. The note prints the
   * phrase as it should read, and prints it in the spacing a human wrote; the
   * caret is drawn in the editor's text, which is indexed in `flat()` shape.
   * The same point, counted twice. */
  const CONJUNCTION = /\s+(?:or|and|nor)\b/gi;

  // Which list, if any, has something to say about this check.
  const listFor = (condition) =>
    Object.values(LISTS).find((l) => l.condition === condition) || null;

  function insertion(lint) {
    if (lint.condition !== 'Radiopaedia.OxfordComma') return null;
    const phrase = plain(lint.matched);
    let at = -1;
    for (const m of phrase.matchAll(CONJUNCTION)) at = m.index;
    if (at <= 0) return null;
    return {
      insert: ',',
      flatAt: flat(phrase.slice(0, at)).length,
      fixed: phrase.slice(0, at) + ',' + phrase.slice(at),
    };
  }

  /* One entry of `lints[]`, one finding — in the order they occur in the
   * article rather than grouped by check, so that walking them with `j` walks
   * the article from top to bottom.
   *
   * The snippet is `trimmed`, the line with the markup taken out of it: that
   * is the shape the editor's text is in, and the one `anchor()` searches for.
   * The message is left exactly as it came, markup and all — the linter's own
   * page shows it that way, and `'<strong> </strong>'` tells you something
   * that `' '` does not.
   *
   * `occurrence` is which COPY OF THE PARAGRAPH this finding is about, and
   * that is counted per line, not per message. An article that says the same
   * sentence twice comes back with findings on two different lines and the
   * second one must walk to the second copy; four acronyms in one paragraph
   * come back as four findings on one line quoting one snippet, and all four
   * belong to the copy that is actually there. Counting identical messages
   * instead — which is all the linter's page gave us to count — sent the
   * second 'NOW' of a paragraph looking for a second paragraph, and it
   * reported "snippet not found" for the rest of the run. Which of the four
   * lights up is `targetNth`'s business, not this one's. */
  function fromApi(data) {
    const inOrder = [...(data.lints || [])].sort(
      (a, b) => ((+a.line || 0) - (+b.line || 0)) || ((+a.position || 0) - (+b.position || 0)));
    const copies = new Map();   // snippet → the copy of it we are on, and its line
    const out = [];

    for (const lint of inOrder) {
      const message = tidy(lint.message);
      if (!message) continue;
      const check = checkName(lint.condition);
      const severity = tidy(lint.severity).toLowerCase();
      const snippet = plain(lint.trimmed || lint.display || lint.match);
      const where = lint.line == null ? null
        : (lint.position == null ? String(lint.line) : `${lint.line}:${lint.position}`);

      // `inOrder` is sorted by line, so a line that is not the one this snippet
      // was last seen on is the next copy of it.
      let copy = copies.get(snippet);
      if (!copy) copies.set(snippet, copy = { line: lint.line, n: 1 });
      else if (copy.line !== lint.line) { copy.line = lint.line; copy.n++; }

      /* The capital at the start of a list item, and the acronym with no
       * definition, weighed against their lists. A hit is a finding that never
       * gets shown; a miss is one that carries the word to propose. Both only
       * when the file was actually read — see `entries`. The word is `matched`,
       * which for `ListCaps` is the list item itself, from its first word to
       * its last, and for `Acronyms` is the acronym on its own. */
      const on = listFor(lint.condition);
      const quoted = on ? plain(lint.matched) : '';
      const known = quoted ? on.match(quoted, on.entries) : null;
      const propose = quoted && !known && on.entries ? on.draft(quoted) : null;

      out.push({ check, severity, line: where, message, snippet,
                 target: flat(plain(lint.matched)), targetNth: nthInLine(lint),
                 point: insertion(lint), known, propose, list: on ? on.key : null,
                 occurrence: copy.n, fp: `${check}|${message}|${snippet}|${where}` });
    }
    return out;
  }

  // ———————————————————————————————————————————————— the lists

  /* A list, as it was last read, lives on its own entry in `LISTS`. `entries`
   * of `null` is not "nothing on it": it is "we do not know", which is what an
   * unreachable file leaves behind — and the two have to be told apart. On
   * `null` nothing is hidden and nothing is offered, because both would be a
   * claim about a file we could not read: hiding a finding would say the word
   * is a known one, and offering to add it would invite a second pull request
   * for a word that may well be in there already. The findings simply come
   * through as the linter sent them. */

  const NAME_CHAR = /[\p{L}\p{N}]/u;

  /* One entry per line, `#` starts a comment, blank lines are ignored. Kept
   * this dull on purpose: the file is edited by hand, in a browser, by people
   * in the middle of fixing an article — a format with a syntax to get wrong
   * would be a second thing to get right. */
  function parseList(text) {
    const out = [];
    for (const line of String(text ?? '').split(/\r?\n/)) {
      const entry = fold(line.replace(/#.*$/, ''));
      if (entry) out.push(entry);
    }
    return out;
  }

  /* The file itself. Plain text, one GET, no headers of ours: this is the only
   * host besides the linter the script ever talks to, and it is read-only.
   * A failure is silent by design — see above. */
  function askList(list) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: list.url,
        timeout: LIST_TIMEOUT,
        onload: (r) => {
          const body = r.responseText || '';
          if (r.status >= 400 || body.length > LIST_MAX) return resolve(null);
          resolve(body);
        },
        onerror: () => resolve(null),
        ontimeout: () => resolve(null),
      });
    });
  }

  /* Once per tab, and once more when you press Re-lint. The session cache is
   * the same bargain the lint answers get: a file that changed a minute ago is
   * worth one more request, a file that changed last month is not worth one
   * per article. `force` is what a merged pull request needs — that, or a new
   * tab. GitHub's raw CDN keeps its own copy for about five minutes on top of
   * this, which no amount of asking from here will shorten. */
  async function readList(list, { force } = {}) {
    if (!force && list.entries) return list.entries;
    if (!force && list.asked) return list.asked;

    list.asked = (async () => {
      let text = force ? null : sessionStorage.getItem(list.cache);
      if (text == null) {
        text = await askList(list);
        if (text != null) {
          try { sessionStorage.setItem(list.cache, text); } catch { /* quota: never mind */ }
        }
      }
      list.entries = text == null ? null : parseList(text);
      if (list.entries) forgetProposed(list.entries);
      return list.entries;
    })();
    return list.asked;
  }

  /* All of them, side by side. Two files is two requests rather than one, and
   * they are made at the same time, cached the same way and read once per tab:
   * the second one costs the wait it takes to arrive alongside the first,
   * which is none. */
  const lists = (opts) => Promise.all(Object.values(LISTS).map((l) => readList(l, opts)));

  /* Is this list item one of the names? By prefix, at a word boundary: the
   * file says "Alvarado" and the item is "Alvarado score"; the file says
   * "British Thoracic Society" and the item runs on for another twenty words.
   * The boundary is what keeps "Alvarado" off "Alvaradoism", and the case is
   * ignored because a name typed lowercase into the file by somebody in a
   * hurry should still work — the check only ever fires on a capital, so there
   * is no lowercase word here for it to swallow by mistake. */
  function startsWithEntry(item, entries) {
    const text = fold(item);
    if (!text || !entries) return null;
    for (const entry of entries) {
      if (text.length < entry.length) continue;
      if (text.slice(0, entry.length).toLowerCase() !== entry.toLowerCase()) continue;
      if (NAME_CHAR.test(text.charAt(entry.length))) continue;
      return entry;
    }
    return null;
  }

  /* And the whole-word one, which is what the acronyms list wants: the check
   * quotes 'PE' and the entry says 'PE', or nothing happens. Case is ignored
   * here too, for the same reason and with the same safety — this check only
   * fires on capitals, so a lowercase entry has no lowercase word to swallow. */
  function sameAsEntry(word, entries) {
    const text = fold(word);
    if (!text || !entries) return null;
    return entries.find((e) => e.toLowerCase() === text.toLowerCase()) || null;
  }

  /* What to propose, when it is not in there yet: the run of capitalised words
   * the item opens with. "Alvarado score" gives "Alvarado"; "British Thoracic
   * Society (BTS) guidelines (2010): …" gives "British Thoracic Society"; and
   * "American College of Chest Physicians" gives "American College", because a
   * lowercase "of" ends the run — wrong as a name, right as an entry, since
   * matching is by prefix and "American College" already recognises the item.
   * It is a first draft either way: the name goes to the clipboard, and what
   * gets pasted into the file is whatever you decide to paste. */
  function properName(item) {
    const run = [];
    for (const w of fold(item).split(' ')) {
      if (!/^[\p{Lu}\p{N}]/u.test(w)) break;
      run.push(w);
    }
    if (!run.length) return null;
    // Trailing punctuation belongs to the sentence, not to the name.
    return run.join(' ').replace(/[.,:;]+$/, '') || null;
  }

  /* The words you have already proposed, and the day you did. One store for
   * both lists: what it answers is "have I already sent this one off?", and
   * that question does not care which file the answer went to.
   *
   * Between the click and the merge there is a pull request, and after the
   * merge there is GitHub's cache: minutes at best, and however long a review
   * takes at worst. Without this the same name would be offered again on the
   * next article, and the next, and the honest answer to "have I already done
   * this one?" would be "go and look at your pull requests". It lives in
   * `localStorage` because it has to outlive the tab, and it clears itself up:
   * a name that has landed in the file is a name this has nothing left to say
   * about. */
  function proposed() {
    try { return JSON.parse(localStorage.getItem(PROPOSED_KEY) || '{}') || {}; }
    catch { return {}; }
  }

  function rememberProposed(name) {
    const all = proposed();
    all[fold(name)] = new Date().toISOString().slice(0, 10);
    try { localStorage.setItem(PROPOSED_KEY, JSON.stringify(all)); } catch { /* this session only */ }
  }

  function forgetProposed(list) {
    const all = proposed();
    const lower = list.map((e) => e.toLowerCase());
    let changed = false;
    for (const name of Object.keys(all)) {
      if (lower.includes(name.toLowerCase())) { delete all[name]; changed = true; }
    }
    if (!changed) return;
    try { localStorage.setItem(PROPOSED_KEY, JSON.stringify(all)); } catch { /* never mind */ }
  }

  /* How many findings each list answered, and how to say it: "2 known names",
   * "1 known acronym". Counted per list rather than added up, because "3
   * findings were set aside" invites the question this answers. */
  function knownTally(findings) {
    const tally = {};
    for (const f of findings) if (f.known && f.list) tally[f.list] = (tally[f.list] || 0) + 1;
    return tally;
  }

  const knownSaid = (tally) => Object.entries(tally).map(
    ([key, n]) => `${n} known ${n > 1 ? LISTS[key].plural : LISTS[key].what}`);

  // ——————————————————————————————————————————————————— network

  /* The one request in the file. `GM_xmlhttpRequest` rather than `fetch` even
   * though the API sends `Access-Control-Allow-Origin: *`: a page's own
   * `connect-src` can forbid a call the browser would otherwise allow, and
   * `@connect radiopaedia.work` is also what states, in the header, the only
   * host this script ever talks to.
   *
   * Nothing that is not a lint result gets out of here. That is what lets the
   * rest of the file read an empty `lints[]` as an article with nothing wrong
   * with it, rather than as an answer it failed to understand. */
  function askLinter(slug) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: API_URL + encodeURIComponent(slug),
        headers: { Accept: 'application/json' },
        timeout: LINTER_TIMEOUT,
        onload: (r) => {
          const body = r.responseText || '';
          if (CHALLENGE.some((m) => body.includes(m))) {
            return reject(new Error(
              'Cloudflare bot check. Open radiopaedia.work in a tab, clear the check, ' +
              'then try again.'));
          }
          let data = null;
          try { data = JSON.parse(body); } catch { /* said below, with the status */ }
          if (r.status >= 400) {
            // 404 and 422 are the article: not found, or nothing in it to lint.
            return reject(new Error(data?.error
              ? `${data.error} (article "${slug}")`
              : `The linter answered ${r.status}.`));
          }
          if (!data || !Array.isArray(data.lints)) {
            return reject(new Error('The linter answered something that is not a lint result.'));
          }
          resolve(data);
        },
        onerror: () => reject(new Error('Request to the linter failed (network, or @connect).')),
        ontimeout: () => reject(new Error('The linter did not answer within a minute.')),
      });
    });
  }

  /* The forced run: two requests, and the only POST in the file.
   *
   * `forceReload` is a Livewire method on the linter's own page — the ⟳ there
   * is `wire:click="forceReload"` and nothing else — so pressing it from here
   * means sending back what that page would have sent. Three things are
   * needed and all three exist only in its HTML: the CSRF token, the snapshot
   * of the `lint` component, and the endpoint, whose path carries a number
   * that changes with every deploy of the site. Read them, check them, post
   * once, and let `askLinter` pick the new answer up.
   *
   * Worth saying plainly, because it is the fragile part: this is somebody's
   * page and not an API. The day the linter is rebuilt on something other
   * than Livewire, or the component is renamed, this stops working — and it
   * stops loudly. A refresh that quietly did not happen would be worse than
   * no button at all, since being sure of what comes back is the whole reason
   * for pressing it. */
  function forceLinter(slug) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: LINT_PAGE_URL + encodeURIComponent(slug),
        timeout: FORCE_TIMEOUT,
        onload: (r) => {
          const page = r.responseText || '';
          if (CHALLENGE.some((m) => page.includes(m))) {
            return reject(new Error(
              'Cloudflare bot check. Open radiopaedia.work in a tab, clear the check, ' +
              'then try again.'));
          }
          if (r.status >= 400) return reject(new Error(`The linter page answered ${r.status}.`));
          if (page.length > FORCE_MAX) return reject(new Error('That answer was not the linter page.'));
          const parts = forceParts(page, slug);
          if (!parts) {
            return reject(new Error(
              'The linter page is not built the way this button expects any more. ' +
              'Press the ⟳ on radiopaedia.work/lint/linter instead.'));
          }
          postForce(parts, slug).then(resolve, reject);
        },
        onerror: () => reject(new Error('The linter page could not be reached.')),
        ontimeout: () => reject(new Error('The linter page took too long to arrive.')),
      });
    });
  }

  /* Nothing is posted on a guess: either all three parts are there and the
   * snapshot really is the `lint` component's, or this answers null and the
   * press is refused out loud. */
  function forceParts(page, slug) {
    const token = /<meta name="csrf-token" content="([^"]+)"/.exec(page)?.[1];
    const path = /\/(livewire[\w-]*)\/update\b/.exec(page)?.[1];
    const snapshot = lintSnapshot(page, slug);
    if (!token || !path || !snapshot) return null;
    return { token, url: `https://radiopaedia.work/${path}/update`, snapshot };
  }

  /* The page carries a snapshot per component, and most of them are the
   * `lint-summary` of some related article. The one wanted is the `lint`
   * itself — the one with `force` in its state, which is what `forceReload`
   * sets — and, where the page holds more than one, the one about the
   * article being asked about.
   *
   * Returned as the string it was written as, unescaped and not re-encoded: a
   * checksum of it travels inside it, and JSON that has been through
   * `parse` and `stringify` is not the same bytes. */
  function lintSnapshot(page, slug) {
    let fallback = null;
    for (const m of page.matchAll(/wire:snapshot="([^"]*)"/g)) {
      const raw = unescapeAttribute(m[1]);
      let snap = null;
      try { snap = JSON.parse(raw); } catch { continue; }
      if (snap?.memo?.name !== 'lint' || !snap.data || !('force' in snap.data)) continue;
      if (typeof snap.data.slug === 'string' &&
          snap.data.slug.toLowerCase() === String(slug).toLowerCase()) return raw;
      fallback ??= raw;
    }
    return fallback;
  }

  /* An attribute read out of HTML source, without handing the source to a
   * parser. The value is JSON that was escaped on the way out, so five
   * entities cover it — and `&amp;` is undone last, or an `&amp;quot;` that was
   * written as text would come back as a quotation mark that was never there. */
  const unescapeAttribute = (s) => s
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

  /* The press itself. The session cookie the page was served with is the one
   * the token belongs to, and `GM_xmlhttpRequest` sends it because it is the
   * browser's own — nothing of ours is stored, sent or read here beyond the
   * slug, which was already in the URL of the page you are standing on. */
  function postForce({ token, url, snapshot }, slug) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url,
        timeout: FORCE_TIMEOUT,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Livewire': '1',
          'X-CSRF-TOKEN': token,
          Referer: LINT_PAGE_URL + encodeURIComponent(slug),
        },
        data: JSON.stringify({
          _token: token,
          components: [{
            snapshot,
            updates: {},
            calls: [{ path: '', method: 'forceReload', params: [] }],
          }],
        }),
        onload: (r) => {
          // 419 is Laravel for a token that has gone stale between the two
          // requests, which one more press fixes.
          if (r.status === 419) {
            return reject(new Error('The linter page\'s session had expired. Press it once more.'));
          }
          if (r.status >= 400) return reject(new Error(`The forced run answered ${r.status}.`));
          let data = null;
          try { data = JSON.parse(r.responseText || ''); } catch { /* said below */ }
          if (!data || !Array.isArray(data.components)) {
            return reject(new Error('The forced run answered something that is not a Livewire response.'));
          }
          resolve(true);
        },
        onerror: () => reject(new Error('The forced run could not be sent (network, or @connect).')),
        ontimeout: () => reject(new Error('The forced run did not finish within a minute.')),
      });
    });
  }

  // ————————————————————————————— finding the editor and anchoring snippets in it

  /* Radiopaedia edits in a WYSIWYG: the text may live in an iframe (TinyMCE)
   * or in a contenteditable. Every plausible root is collected and searched —
   * an article has several fields, and a finding can land in any of them. */
  const EDITOR_SELECTORS = [
    'iframe.tox-edit-area__iframe',
    'iframe[id$="_ifr"]',
    'div.tox-edit-area [contenteditable="true"]',
    'div.mce-content-body[contenteditable="true"]',
    'trix-editor',
    'div.ql-editor',
    '[contenteditable="true"]',
  ];

  function editorRoots() {
    const roots = [];
    const seen = new Set();
    for (const sel of EDITOR_SELECTORS) {
      for (const el of document.querySelectorAll(sel)) {
        let root = el, frame = null;
        if (el.tagName === 'IFRAME') {
          let d = null;
          try { d = el.contentDocument; } catch { /* never on someone else's iframe */ }
          if (!d || !d.body) continue;
          root = d.body;
          frame = el;
        }
        if (seen.has(root)) continue;
        // A contenteditable nested inside one we already took would bring the
        // same text along twice.
        if (roots.some((r) => !r.frame && r.root.contains(root))) continue;
        seen.add(root);
        roots.push({ root, frame });
      }
    }
    return roots;
  }

  /* Wait until the editor actually holds text: freshly mounted it is empty,
   * and searching it then would anchor nothing. */
  function awaitEditor() {
    return new Promise((resolve) => {
      const deadline = Date.now() + EDITOR_TIMEOUT;
      (function poll() {
        const roots = editorRoots().filter((r) => (r.root.textContent || '').trim().length > 40);
        if (roots.length) return resolve(roots);
        if (Date.now() > deadline) return resolve(editorRoots());
        setTimeout(poll, 400);
      })();
    });
  }

  /* What counts as one piece of text on its own: a heading, a paragraph, a
   * list item. Ranges never care about these — the index does, to be able to
   * say "this match IS that heading" rather than "this match is somewhere in
   * the article". */
  const BLOCKS = 'p,li,h1,h2,h3,h4,h5,h6,dd,dt,td,th,caption,figcaption,blockquote,pre,div';

  /* The index of a root: the flattened string of all its text, plus the node
   * and offset each character came from. A Range over any substring can be
   * rebuilt from that, even one crossing several tags.
   *
   * Every character also remembers the block it belongs to, and every block
   * the stretch of characters that is its whole text. That is what lets a
   * match be recognised as filling a block exactly — see `pick`. */
  function buildIndex(root) {
    const doc = root.ownerDocument;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (p.closest('script, style, noscript')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let s = '';
    const nodes = [], offsets = [], owners = [], cited = [];
    const blocks = new Map();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const raw = n.nodeValue || '';
      const owner = n.parentElement.closest(BLOCKS) || root;
      // Reference markers stay in the text — the snippet quotes them — but
      // they are not prose, and nothing gets highlighted inside one.
      const isCitation = !!n.parentElement.closest('sup');
      for (let i = 0; i < raw.length; i++) {
        const c = flat(raw[i]);
        if (!c) continue;              // whitespace: out of the index by construction
        const at = s.length;
        s += c;
        nodes.push(n);
        offsets.push(i);
        owners.push(owner);
        cited.push(isCitation);
        const b = blocks.get(owner);
        if (b) b.to = at; else blocks.set(owner, { from: at, to: at });
      }
    }
    return { root, s, nodes, offsets, owners, cited, blocks };
  }

  /* Every place the needle falls, in document order. Capped, because a very
   * short snippet can occur a hundred times over and nothing past the first
   * few is ever asked for. */
  function locateAll(index, needle, cap = 200) {
    const hits = [];
    if (!needle) return hits;
    for (let from = index.s.indexOf(needle); from >= 0 && hits.length < cap;
         from = index.s.indexOf(needle, from + 1)) {
      const to = from + needle.length - 1;
      if (to < index.nodes.length) hits.push({ from, to });
    }
    return hits;
  }

  /* True when the match is not merely inside a block but IS one: the heading
   * "Toxic", not the word toxic in a sentence. */
  function fillsBlock(index, { from, to }) {
    const b = index.blocks.get(index.owners[from]);
    return !!b && b.from === from && b.to === to;
  }

  /* Which occurrence of the needle this finding gets.
   *
   * Occurrences that fill a block exactly are offered first. The linter quotes
   * a heading as just its words — "Toxic" for `HEADINGS VALID` — and an
   * article that says "in most cases, toxic and metabolic disease…" in a
   * paragraph above the heading would otherwise have that sentence lit
   * instead: first in the text, and the wrong place by any reading.
   *
   * The preference only decides *among* matches, never invents one: with no
   * block-filling match, or fewer of them than the occurrence asked for, the
   * plain document order is used exactly as before. That is what keeps a
   * one-word snippet the linter really did mean in prose from being dragged
   * onto a heading that happens to repeat the word. */
  function pick(index, needle, occurrence) {
    const hits = locateAll(index, needle);
    if (!hits.length) return null;
    const exact = hits.filter((h) => fillsBlock(index, h));
    const list = exact.length >= occurrence ? exact : hits;
    return list[occurrence - 1] || null;
  }

  function rangeFrom(index, { from, to }) {
    const r = index.root.ownerDocument.createRange();
    r.setStart(index.nodes[from], index.offsets[from]);
    r.setEnd(index.nodes[to], index.offsets[to] + 1);
    return r;
  }

  /* Where the offending words sit inside the snippet: the copy `nthInLine`
   * counted if it is there, the first one otherwise. A count that has run out
   * is no reason to give up the narrowing — the line the linter counted along
   * and the text sitting in the form are not always the same text any more.
   *
   * Nought is not a count, it is `nthInLine` saying the linter pointed into a
   * citation: nothing to narrow onto, the whole snippet stays lit.
   *
   * Copies inside reference markers are set aside while there is one in the
   * prose. The comma of `<sup>2,4,6,11,12</sup>` is a comma in the text of the
   * page and nothing else — highlighting it for a finding about the sentence
   * puts the reader's eye on the one thing they must not touch. */
  function within(index, wide, needle, nth) {
    if (!needle || nth === 0) return -1;
    const hay = index.s.slice(wide.from, wide.to + 1);
    const hits = [];
    for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) hits.push(at);
    if (!hits.length) return -1;
    const prose = hits.filter((at) => !index.cited[wide.from + at]);
    const list = prose.length ? prose : hits;
    return list[Math.min(Math.max(nth || 1, 1), list.length) - 1];
  }

  /* Anchor every finding still open. Each root is indexed once, and which copy
   * of the snippet a finding gets is its OWN `occurrence`, the one `fromApi`
   * counted — not a running tally of how many findings quoted that snippet
   * before it. The difference is the whole paragraph rule: one paragraph
   * naming three acronyms comes back as three findings quoting exactly the
   * same snippet, and a running tally would send the second to a second copy
   * of that paragraph, which does not exist — the first acronym would light
   * up and the other two would report "snippet not found". Only a snippet the
   * article really does say twice — findings on a second line of its own —
   * carries occurrence 2, 3, … and those are the ones that must walk forward.
   *
   * Two passes: the snippet says *where*, `matched` says *what*. Once the
   * snippet is found, the words the API named are searched for inside it and
   * the highlight tightens onto them — one lit acronym is worth more than a
   * whole paragraph washed in colour. When there is nothing left of them once
   * the tags are out (`<strong> </strong>` is a space), or they cannot be
   * found in there, the snippet stays lit: too wide beats nothing. */
  function anchor(findings, roots) {
    const indices = roots.map((r) => buildIndex(r.root));
    for (const f of findings) {
      f.range = null; f.frame = null; f.narrowed = false; f.caret = null;
      if (f.state === 'ignored' || f.state === 'done') continue;
      const needle = flat(f.snippet);
      if (!needle) continue;
      for (let i = 0; i < indices.length; i++) {
        const wide = pick(indices[i], needle, f.occurrence || 1);
        if (!wide) continue;

        let spot = wide;
        const rel = within(indices[i], wide, f.target, f.targetNth);
        if (rel >= 0) {
          spot = { from: wide.from + rel, to: wide.from + rel + f.target.length - 1 };
          f.narrowed = true;
        }
        f.range = rangeFrom(indices[i], spot);
        f.frame = roots[i].frame;

        /* The caret sits between two characters, so it is anchored on the one
         * before it and drawn against that character's trailing edge. Only
         * when the highlight really is the quoted phrase: on a finding that
         * stayed wide, an offset into the phrase points at nothing. */
        if (f.narrowed && f.point) {
          const at = spot.from + f.point.flatAt;
          if (at > spot.from && at <= spot.to + 1) {
            f.caret = rangeFrom(indices[i], { from: at - 1, to: at - 1 });
          }
        }
        // Where it lived, kept for after the edit that dissolves the range:
        // `highlightBounds` falls back to it so the note does not fly off to
        // the corner of the screen the moment you start typing.
        f.home = { el: indices[i].owners[spot.from], frame: roots[i].frame };
        break;
      }
    }
  }

  // ———————————————————————————————————————————————————————————— the stage

  GM_addStyle(`
    /* The pair — the button and its switch — travel together: the title is a
       flex container and would otherwise treat them as two things to squeeze
       independently. */
    .rlx-group {
      display:inline-flex; align-items:center; gap:.4em; vertical-align:middle;
      margin-left:.6em; white-space:nowrap; flex:0 0 auto; align-self:center;
    }
    /* Shaped like Radiopaedia's own "Edit article", down to the numbers read
       off it: ".btn.btn-flat" is 6px/12px of padding, 12px semibold on an 18px
       line, a 2px corner, a hairline border that goes darker along the bottom,
       and an inset highlight along the top. Thirty-two pixels tall, and ours
       is thirty-two pixels tall.

       Only the colour is ours. Radiopaedia's sits in flat grey; this one keeps
       the flat, and tints it with the verdict — a wash of the ink for the
       fill, the ink itself for the text. With no verdict yet the mix lands on
       their grey, which is the right thing for a button that has not been told
       anything. "color-mix" is a one-line upgrade over the plain "#ededed"
       above it, and where it is not understood the plain one stands.

       "font-family:inherit" rather than a stack of our own: Radiopaedia sets
       Open Sans on the body and on the title alike, so inheriting lands on the
       same face wherever the button is mounted, and keeps landing there if
       they ever change it. Size, weight and line-height are set explicitly, or
       the title would hand down its own — which is 27px semibold. */
    .rlx-btn {
      display:inline-flex; align-items:center; gap:.4em; vertical-align:middle;
      padding:6px 12px; border-radius:2px;
      border:1px solid rgba(0,0,0,.1); border-bottom-color:rgba(0,0,0,.25);
      background:#ededed;
      background:color-mix(in srgb, var(--rlx-ink, #555) 12%, #ededed);
      color:var(--rlx-ink, #555);
      box-shadow:inset 0 1px 0 rgba(255,255,255,.2), 0 1px 2px rgba(0,0,0,.05);
      font-family:inherit; font-size:12px; font-weight:600; line-height:18px;
      letter-spacing:normal; text-transform:none; cursor:pointer;
      /* The title is a flex container, and it deforms the button twice over.
         A long title squeezes it until "Lint" wraps to "Lin/t", because
         flex-shrink defaults to 1 and the button gets treated as spare room;
         and align-self defaults to stretch, so on a title running to two lines
         the button is pulled into a tall oval. Pinned here: never wrap, never
         give up width, keep your own height. */
      white-space:nowrap; flex:0 0 auto; align-self:center;
    }
    .rlx-btn:hover { background:var(--rlx-ink, #2563eb); color:#fff; }
    /* Asking. Not grey — grey is an answer here, and it would be the wrong one. */
    .rlx-btn-asking { opacity:.55; }
    .rlx-btn[disabled] { opacity:.55; cursor:progress; }

    /* The switch. Filled in the colour of the verdict while it is on, so the
       two read as one control; hollow and grey when nothing is being asked. */
    .rlx-auto {
      padding:3px 7px; border-radius:2px;
      border:1px solid rgba(0,0,0,.1); border-bottom-color:rgba(0,0,0,.25);
      background:#ededed; color:#999; cursor:pointer;
      box-shadow:inset 0 1px 0 rgba(255,255,255,.2), 0 1px 2px rgba(0,0,0,.05);
      font-family:inherit; font-size:11px; font-weight:600; line-height:14px;
      letter-spacing:normal; text-transform:none;
      white-space:nowrap; flex:0 0 auto; align-self:center;
    }
    .rlx-auto:hover { color:#555; }
    .rlx-auto.rlx-on { background:var(--rlx-ink, #2563eb); border-color:transparent; color:#fff; }
    .rlx-auto.rlx-on:hover { color:#fff; opacity:.85; }

    /* The ↻. Shaped like the switches beside it, because it sits with them,
       but it never lights up: it switches nothing, it does something, and the
       only state it has is the second or two it takes to do it. The glyph
       turns rather than the button, or the border would spin with it. */
    .rlx-force-glyph { display:inline-block; }
    .rlx-force[disabled] { opacity:.55; cursor:progress; }
    .rlx-force.rlx-busy .rlx-force-glyph { animation:rlx-turn .9s linear infinite; }
    @keyframes rlx-turn { to { transform:rotate(360deg); } }

    .rlx-btn-float { position:fixed; top:14px; right:14px; z-index:99999; margin:0;
      padding:4px 6px; border-radius:2px;
      background:#fff; box-shadow:0 2px 10px rgba(0,0,0,.18); }

    /* ————— the structure rail: the sections the article has not got yet.

       A layer of its own, under the highlights: the two never appear together
       — one lives on the article page, the other in the editor — but a chip
       drawn over a highlight would be the wrong way round if they ever did.

       The chips are "position:fixed" and placed from JavaScript, because what
       they line up with is a heading in a column that scrolls. What CSS is
       left is what they look like: Radiopaedia's own flat button, borrowed one
       more time, with the amber of a linter warning down the left edge —
       which is what a missing required section is. */
    #rlx-gutter { position:fixed; inset:0; pointer-events:none; z-index:99996; }
    #rlx-gutter > * { pointer-events:auto; box-sizing:border-box; }

    /* 13px on an 18px line, which is the size Radiopaedia sets on the article's
       own paragraphs. The first version was 11px — the size of the site's
       chrome — and beside prose a third larger it read as a footnote about the
       article rather than as part of reading it. The margin is not chrome. */
    .rlx-rail-head, .rlx-chip {
      position:fixed; border-radius:2px;
      border:1px solid rgba(0,0,0,.1); border-bottom-color:rgba(0,0,0,.25);
      background:#fff; box-shadow:0 1px 2px rgba(0,0,0,.06);
      font-family:"Open Sans", system-ui, -apple-system, sans-serif;
      font-size:13px; line-height:18px;
    }

    .rlx-rail-head {
      display:flex; align-items:center; gap:6px; flex-wrap:wrap;
      padding:6px 8px; background:#f7f7f7; color:#777; font-weight:600;
      font-size:12px;
    }
    .rlx-rail-n {
      display:inline-block; min-width:18px; padding:0 5px; border-radius:2px;
      background:var(--rlx-miss, #d97706); color:#fff; text-align:center;
    }
    /* Nothing required is missing. The badge still says so — the rail is the
       one place that has looked — but amber would be claiming otherwise. */
    .rlx-rail-none { background:#b6b6b6; }
    /* Sections are out of the canon's order somewhere in this article. Said
       here and not on the chips, because it is a fact about the article and
       not about any one missing heading — and because it is the reason the
       placements below are approximate rather than exact. */
    .rlx-rail-jumbled { color:#b45309; cursor:help; }
    /* How many chips are off screen in each direction. Flex-basis 100% so it
       takes a line of its own rather than squeezing the count out of the
       first one. */
    .rlx-rail-hidden { flex:1 1 100%; color:#aaa; font-weight:400; cursor:help; }
    .rlx-rail-hidden[hidden] { display:none; }
    .rlx-rail-what { flex:1 1 auto; }
    /* The kind of article, and the whole point of its being a menu: the guess
       is a guess, and on the article it gets wrong it is one click to say so. */
    .rlx-rail-kind {
      flex:1 1 100%; max-width:100%; padding:3px 4px; border-radius:2px;
      border:1px solid rgba(0,0,0,.12); background:#fff; color:#555;
      font-family:inherit; font-size:11px; font-weight:600; cursor:pointer;
    }
    .rlx-rail-off, .rlx-rail-undo, .rlx-rail-more {
      padding:0 5px; border:0; border-radius:2px; background:transparent;
      color:#aaa; font-family:inherit; font-size:12px; font-weight:600; cursor:pointer;
    }
    .rlx-rail-more { flex:1 1 100%; text-align:left; color:#999; }
    .rlx-rail-more.rlx-on { color:#555; }
    .rlx-rail-off:hover, .rlx-rail-undo:hover, .rlx-rail-more:hover {
      color:#555; background:rgba(0,0,0,.06);
    }

    /* Two things are being said at once and they are two different axes, so
       they get two different signals. WHETHER Radiopaedia asks for it is the
       left edge and the weight of the ink: amber and bold for a section it
       requires, grey and light for one it merely offers. WHERE it sits is the
       indent: a subsection is stepped in under the section it belongs to.
       Reading them as one — a dashed border meaning both "optional" and
       "subsection" — is what the first version did, and it made a required
       modality look like a suggestion. */
    .rlx-chip {
      display:flex; align-items:flex-start; gap:4px;
      padding:4px 7px 4px 8px;
      border-left:3px solid var(--rlx-miss, #d97706);
      color:#444; font-weight:600; cursor:pointer;
    }
    /* "hidden" has to be spelled out here. The attribute works by the browser's
       own "display:none", and "display:flex" two lines up is an author rule,
       which beats it — so a chip whose heading had scrolled away went on being
       drawn at the last place it had been put, and the ones that had scrolled
       away kept piling on top of each other until the margin was unreadable.
       It was counted as hidden the whole time, which is how it went unnoticed. */
    .rlx-chip[hidden] { display:none; }
    /* Which way the heading goes, which position alone cannot say: a chip
       beside "Clinical presentation" that means "above this" and one beside
       "Epidemiology" that means "inside this" sit in the same place and looked
       the same. Three cases, three glyphs, and the tooltip spells each out. */
    .rlx-chip-rel {
      flex:0 0 auto; width:12px; text-align:center;
      color:#c4c4c4; font-weight:400;
    }
    .rlx-chip:hover .rlx-chip-rel { color:var(--rlx-miss, #d97706); }
    .rlx-chip-optional:hover .rlx-chip-rel { color:#777; }

    /* The thread to the heading itself, drawn while the pointer is on a chip.
       Position says which heading a chip belongs to right up until the stack
       pushes it away from one, which on a dense article is most of them — so
       the answer is drawn rather than implied, and only for the one being
       asked about, or twenty threads would cross the margin at once. */
    #rlx-thread {
      position:fixed; inset:0; width:100%; height:100%;
      pointer-events:none; overflow:visible;
    }
    #rlx-thread path {
      fill:none; stroke:var(--rlx-miss, #d97706); stroke-width:1.5;
      stroke-linecap:round; stroke-linejoin:round;
    }
    #rlx-thread.rlx-thread-offered path { stroke:#9a9a9a; }
    .rlx-chip:hover { background:#fffdf7; color:#111; }
    .rlx-chip-optional {
      border-left-color:#c9c9c9; color:#8a8a8a; font-weight:400;
      background:#fcfcfc;
    }
    .rlx-chip-optional:hover { background:#f4f4f4; color:#444; }
    /* Stepped in under the section it belongs to. One step only: the canon
       goes three deep and three indents in a 200px margin is most of the
       margin. */
    .rlx-chip-sub { margin-left:12px; }
    .rlx-chip-name { flex:1 1 auto; overflow-wrap:anywhere; }
    .rlx-chip-hush {
      flex:0 0 auto; padding:0 2px; border:0; background:transparent;
      color:#ccc; font:inherit; font-size:12px; line-height:14px; cursor:pointer;
    }
    .rlx-chip:hover .rlx-chip-hush { color:#999; }
    .rlx-chip-hush:hover { color:#555; }
    .rlx-chip-copied { background:var(--rlx-miss, #d97706); border-color:transparent; color:#fff; }
    .rlx-chip-copied .rlx-chip-name::after { content:" — copied"; opacity:.8; font-weight:400; }

    /* No room for words. A tab against the edge of the text and the heading in
       the tooltip: less than the chip said, and none of it a lie about where
       the section goes. */
    .rlx-rail-slim .rlx-chip { padding:0; border-left-width:8px; height:22px; }
    .rlx-rail-slim .rlx-chip-name, .rlx-rail-slim .rlx-chip-hush { display:none; }
    .rlx-rail-slim .rlx-rail-what, .rlx-rail-slim .rlx-rail-kind,
    .rlx-rail-slim .rlx-rail-more { display:none; }
    .rlx-rail-slim .rlx-chip-sub { margin-left:6px; }
    .rlx-rail-slim .rlx-rail-head { padding:2px 3px; gap:2px; }

    #rlx-layer { position:fixed; inset:0; pointer-events:none; z-index:99997; }
    .rlx-mark { position:fixed; border-radius:2px; }
    .rlx-mark.rlx-current { outline:2px solid; outline-offset:1px; }

    /* The insertion caret: a rule between two letters, with the character it
       stands for above it. A transform rather than a negative left, so the
       glyph stays centred on the rule whatever character it is. */
    .rlx-caret { position:fixed; width:2px; border-radius:1px; }
    .rlx-caret::after {
      /* Under the rule rather than over it: a comma belongs on the baseline,
         and the line above is somebody else's text. */
      content:attr(data-insert); position:absolute; left:50%; top:100%;
      transform:translate(-50%, -68%);
      font:800 15px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
    }

    #rlx-note {
      position:fixed; z-index:99999; max-width:min(30em, 78vw);
      padding:.6em .8em; border-radius:8px; border-left:4px solid;
      background:#fff; color:#111; box-shadow:0 6px 24px rgba(0,0,0,.22);
      font:14px/1.45 system-ui,-apple-system,sans-serif;
    }
    /* Reach the note with the pointer and it gets out of the way: faded, and
       click-through, so the words underneath can be selected with the mouse
       like any other text. The message itself is still one keystroke away —
       c, or Copy on the bar — which is the better trade than a box you cannot
       select through.

       The class comes from a mousemove rather than from :hover, and it has to:
       an element that turns pointer-events off while hovered stops being
       hovered, which restores it, which hovers it again. That flickers at the
       refresh rate. */
    #rlx-note { transition: opacity .12s ease; }
    #rlx-note.rlx-ghost { opacity:.12; pointer-events:none; }
    #rlx-note .rlx-head { display:flex; gap:.5em; align-items:baseline;
      font-size:12px; text-transform:uppercase; letter-spacing:.04em; opacity:.8; }
    #rlx-note .rlx-msg { margin-top:.35em; }
    #rlx-note .rlx-hint { margin-top:.4em; font-size:12px; opacity:.62; }
    #rlx-note .rlx-fix { margin-top:.4em; padding:.25em .5em; border-radius:6px;
      background:rgba(127,127,127,.14); font-weight:600; }
    #rlx-note .rlx-snippet { margin-top:.4em; padding-left:.6em; border-left:2px solid #e5e7eb;
      color:#4b5563; font-style:italic; }

    /* One row, always. Wrapping put the status on a second line as soon as the
       sentence grew, and the bar changed height under the pointer while you
       were working in it — the buttons you were aiming at moved. The status is
       the only part that gives ground now: it shrinks and ends in an ellipsis,
       and everything you can press keeps its size.

       Top and bottom are set from the script, by placeBar(). The 18px here is
       what it looks like until the first measurement lands. */
    #rlx-bar {
      /* Centred by auto margins between left:0 and right:0, not by
         left:50% + translateX. The old pair looks the same and is not: a fixed
         box that starts at the middle of the window has only the right half to
         be wide in, so the bar was being sized against 50% of the screen and
         its last buttons hung outside its own background. Two edges and auto
         margins give it the whole width to shrink-to-fit in — and fit-content
         is what makes it shrink at all, since a box pinned to both edges with
         width:auto simply fills them, which is a dark pill with a lot of
         nothing in it once half the buttons are gone. */
      position:fixed; left:0; right:0; margin:0 auto; bottom:18px; z-index:99999;
      display:flex; align-items:center; gap:.45em; flex-wrap:wrap; justify-content:center;
      width:fit-content; max-width:min(64em, 96vw); padding:.5em .7em; border-radius:13px;
      background:#111827; color:#f9fafb; box-shadow:0 8px 30px rgba(0,0,0,.35);
      font:14px/1.4 system-ui,-apple-system,sans-serif;
    }
    #rlx-bar button { flex:0 0 auto; padding:.4em .8em; border:0; border-radius:8px;
      background:#374151; color:#e5e7eb; font:inherit; font-weight:600; cursor:pointer; }
    #rlx-bar button:hover:not([disabled]) { background:#4b5563; color:#fff; }
    #rlx-bar button[disabled] { opacity:.35; cursor:default; }

    /* Done is the one you press a hundred times an afternoon, and it was the
       same grey as Re-lint, which you press once. Green rather than the
       severity's own colour: red on the button you are meant to press reads as
       a warning about pressing it, and green is already what the finding turns
       when you do. */
    #rlx-bar .rlx-primary { background:#059669; color:#fff; }
    #rlx-bar .rlx-primary:hover:not([disabled]) { background:#047857; color:#fff; }

    /* The arrows are arrows, not buttons: no fill until you point at them. */
    #rlx-bar .rlx-step { background:transparent; padding:.28em .5em;
      font-size:17px; line-height:1; }

    #rlx-bar .rlx-count { display:flex; align-items:center; gap:.42em; flex:0 0 auto;
      font-variant-numeric:tabular-nums; }
    #rlx-bar .rlx-of { font-weight:600; }
    /* A severity is a colour in this script — on the highlight, on the note,
       on the button by the title. Here too, which is three words shorter. */
    #rlx-bar .rlx-tally { display:inline-flex; align-items:center; gap:.3em; }
    #rlx-bar .rlx-dot { width:.62em; height:.62em; border-radius:50%; }
    #rlx-bar .rlx-sepdot { opacity:.4; }
    #rlx-bar .rlx-known { opacity:.65; }
    #rlx-bar .rlx-title { font-weight:700; flex:0 0 auto; }
    /* flex-basis 0, so the line is measured as though the status were not
       there: it never pushes itself onto a second row, it takes whatever room
       is left over and ends in an ellipsis. Wrapping is still on for a window
       narrow enough that the buttons alone will not fit — better a second row
       than a button off the edge — but the sentence cannot cause it. */
    #rlx-bar .rlx-status { flex:1 1 0; min-width:0; overflow:hidden;
      text-overflow:ellipsis; white-space:nowrap; opacity:.85; }
    #rlx-bar .rlx-sep { width:1px; align-self:stretch; background:#4b5563; flex:0 0 auto; }
    #rlx-bar .rlx-close, #rlx-bar .rlx-flip { background:transparent; font-size:16px;
      line-height:1; padding:.3em .5em; }

    #rlx-banner {
      position:fixed; left:50%; top:18px; transform:translateX(-50%); z-index:99999;
      display:flex; align-items:center; gap:.6em;
      max-width:min(42em, 94vw); padding:.7em 1em; border-radius:12px;
      background:#111827; color:#f9fafb; box-shadow:0 8px 30px rgba(0,0,0,.35);
      font:14px/1.45 system-ui,-apple-system,sans-serif; cursor:pointer;
      animation: rlx-banner-in .18s ease-out;
    }
    #rlx-banner .rlx-tick { color:#34d399; font-size:17px; line-height:1; }
    #rlx-banner .rlx-sub { display:block; margin-top:.15em; font-size:12.5px; opacity:.75; }
    @keyframes rlx-banner-in {
      from { opacity:0; transform:translate(-50%, -8px); }
      to   { opacity:1; transform:translate(-50%, 0); }
    }

    /* ————— the citation chips, and what one has to say.

       These are the one thing this script puts inside the page rather than in
       a layer over it, and the reason is that they belong to the FORM: they
       stand beside Radiopaedia's own "Format citation" link, under the box
       holding the reference, which is where somebody already looks for
       something to press about a citation. The form is not what gets saved —
       the article is — so a button there is a button, not a thing waiting to
       be written into an article. Nothing is ever put inside the editor. */
    .rlx-cite {
      display:inline-block; vertical-align:baseline; margin-left:.8em;
      padding:2px 8px; border-radius:2px;
      border:1px solid rgba(0,0,0,.12); border-bottom-color:rgba(0,0,0,.25);
      background:#ededed; color:#6b7280;
      box-shadow:inset 0 1px 0 rgba(255,255,255,.2), 0 1px 2px rgba(0,0,0,.05);
      font:600 11px/16px system-ui,-apple-system,sans-serif;
      letter-spacing:normal; text-transform:none; white-space:nowrap; cursor:pointer;
    }
    .rlx-cite:hover { background:#6b7280; color:#fff; }
    .rlx-cite[disabled] { opacity:.55; cursor:progress; }
    .rlx-cite-match   { background:rgba(5,150,105,.16); color:#059669; }
    .rlx-cite-match:hover { background:#059669; color:#fff; }
    .rlx-cite-differs { background:rgba(217,119,6,.18); color:#b45309; }
    .rlx-cite-differs:hover { background:#b45309; color:#fff; }
    .rlx-cite-unknown { background:rgba(107,114,128,.18); color:#6b7280; }

    #rlx-cite-note {
      position:fixed; z-index:99999; width:min(38em, 84vw);
      padding:.7em .9em; border-radius:8px; border-left:4px solid #6b7280;
      background:#fff; color:#111; box-shadow:0 6px 24px rgba(0,0,0,.22);
      font:13px/1.5 system-ui,-apple-system,sans-serif;
    }
    #rlx-cite-note .rlx-cite-head { display:flex; gap:.5em; align-items:baseline;
      font-size:11px; text-transform:uppercase; letter-spacing:.04em; opacity:.8; }
    #rlx-cite-note .rlx-cite-why { margin-top:.35em; }
    #rlx-cite-note .rlx-cite-label { margin-top:.7em; font-size:11px;
      text-transform:uppercase; letter-spacing:.04em; opacity:.55; }
    #rlx-cite-note .rlx-cite-text { margin-top:.15em; padding:.3em .5em; border-radius:6px;
      background:rgba(127,127,127,.10); word-break:break-word; }
    /* The two words that differ, rather than the two paragraphs that contain
       them: a reference is eighty words long and the thing wrong with it is
       usually one of them. */
    #rlx-cite-note .rlx-was { background:rgba(220,38,38,.18); border-radius:2px; }
    #rlx-cite-note .rlx-now { background:rgba(5,150,105,.20); border-radius:2px; }
    #rlx-cite-note .rlx-cite-acts { display:flex; gap:.4em; margin-top:.7em; flex-wrap:wrap; }
    #rlx-cite-note button {
      padding:3px 8px; border-radius:2px; border:1px solid rgba(127,127,127,.35);
      background:transparent; color:inherit; cursor:pointer;
      font:600 11px/16px system-ui,-apple-system,sans-serif;
    }
    #rlx-cite-note button:hover { background:rgba(127,127,127,.18); }

    @media (prefers-color-scheme: dark) {
      #rlx-note { background:#1f2937; color:#f3f4f6; }
      #rlx-note .rlx-snippet { border-left-color:#4b5563; color:#d1d5db; }
      #rlx-cite-note { background:#1f2937; color:#f3f4f6; }
    }
  `);

  const stage = {
    slug: null,
    findings: [],
    hidden: {},       // what the lists answered: out of the walk, not out of the count
    roots: [],
    i: -1,
    history: [],      // for "undo": {i, state}
    layer: null, note: null, bar: null,
    live: false,
  };

  function createStage() {
    if (stage.live) return;
    stage.live = true;

    stage.layer = document.createElement('div');
    stage.layer.id = 'rlx-layer';
    document.body.appendChild(stage.layer);

    stage.note = document.createElement('div');
    stage.note.id = 'rlx-note';
    stage.note.hidden = true;
    document.body.appendChild(stage.note);

    stage.bar = document.createElement('div');
    stage.bar.id = 'rlx-bar';
    stage.bar.innerHTML = `
      <span class="rlx-title">Lint</span>
      <span class="rlx-count"></span>
      <span class="rlx-sep rlx-sep-nav"></span>
      <button data-act="prev" class="rlx-step" title="Previous (k)">&lsaquo;</button>
      <button data-act="next" class="rlx-step" title="Next (j)">&rsaquo;</button>
      <button data-act="done" class="rlx-primary" title="Done (s)">&#10003; Done</button>
      <button data-act="ignore" title="Ignore (x)">Ignore</button>
      <button data-act="undo" title="Undo the last one (u)">Undo</button>
      <span class="rlx-sep rlx-sep-tools"></span>
      <button data-act="copy" title="Copy the message (c)">Copy</button>
      <button data-act="propose" title="Add this to the shared list (p)">+ Name</button>
      <button data-act="reload" title="Ask the linter again">Re-lint</button>
      <button data-act="flip" class="rlx-flip" title="Move the bar to the other edge (t)">&#8645;</button>
      <button data-act="close" class="rlx-close" title="Close (Esc)">&times;</button>
      <span class="rlx-status"></span>`;
    document.body.appendChild(stage.bar);
    placeBar(true);
    stage.bar.addEventListener('click', (e) => {
      const what = e.target.closest('[data-act]')?.dataset.act;
      if (what) act(what);
    });

    addEventListener('scroll', scheduleDraw, true);
    addEventListener('resize', scheduleDraw);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousemove', onMove, true);
  }

  /* Scrolling and keystrokes inside an iframe never reach the document above:
   * they have to be listened for on its own window. */
  function listenToFrames() {
    for (const { frame, root } of stage.roots) {
      const w = frame?.contentWindow;
      if (w && !w.__rlxListening) {
        w.__rlxListening = true;
        w.addEventListener('scroll', scheduleDraw, true);
        w.document.addEventListener('keydown', onKey, true);
        w.document.addEventListener('input', reanchorSoon, true);
        w.document.addEventListener('mousemove', (e) => ghostNote(e, frame), true);
      }
      if (!frame && !root.__rlxListening) {
        root.__rlxListening = true;
        root.addEventListener('input', reanchorSoon, true);
      }
    }
  }

  function destroyStage() {
    if (!stage.live) return;
    stage.live = false;
    stage.layer?.remove(); stage.note?.remove(); stage.bar?.remove();
    removeEventListener('scroll', scheduleDraw, true);
    removeEventListener('resize', scheduleDraw);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousemove', onMove, true);
    stage.findings = []; stage.hidden = {}; stage.i = -1; stage.history = [];
  }

  // ———————————————————————————————————————————————— the all-clear banner

  /* Nothing to show on the text means there is nothing to put a stage around:
   * a bar reading "0/0" is a worse way of saying "clean" than a sentence. The
   * banner goes away on its own, on a click, or on Esc — it is an answer, not
   * a thing to manage. */
  let bannerTimer = null;

  function showBanner(headline, sub) {
    hideBanner();
    const el = document.createElement('div');
    el.id = 'rlx-banner';
    el.innerHTML =
      '<span class="rlx-tick">\u2713</span><span></span>';
    const body = el.lastElementChild;
    body.textContent = headline;
    if (sub) {
      const small = document.createElement('span');
      small.className = 'rlx-sub';
      small.textContent = sub;
      body.appendChild(small);
    }
    el.title = 'Click to dismiss';
    el.addEventListener('click', hideBanner);
    document.body.appendChild(el);
    document.addEventListener('keydown', bannerKey, true);
    bannerTimer = setTimeout(hideBanner, 7000);
  }

  function hideBanner() {
    clearTimeout(bannerTimer);
    bannerTimer = null;
    document.getElementById('rlx-banner')?.remove();
    document.removeEventListener('keydown', bannerKey, true);
  }

  function bannerKey(e) {
    if (e.key === 'Escape') hideBanner();
  }

  // —————————————————————————————————————————————————————— drawing

  let drawPending = null;
  function scheduleDraw() {
    if (drawPending) return;
    drawPending = requestAnimationFrame(() => { drawPending = null; draw(); });
  }

  /* One box per line of text, not one per tag.
   *
   * `getClientRects()` cuts a Range wherever it crosses an element boundary,
   * so "patchy, reticulonodular or mixed" with a link in the middle of it
   * comes back as three rectangles. Drawn as three, with an outline each, they
   * read as three findings and put borders through the middle of the words —
   * on the one finding whose whole point is that the phrase is hard to read.
   *
   * Rectangles that share a line become the single box that line deserves.
   * Sharing a line is judged by overlap rather than by equal tops: a
   * superscript sits higher and is shorter than the text around it, and it
   * belongs to the same line all the same. A phrase that wraps still gets one
   * box per line, which is the honest picture. */
  function mergeLines(spans) {
    const lines = [];
    for (const s of spans) {
      const line = lines.find((l) =>
        Math.min(l.y + l.h, s.y + s.h) - Math.max(l.y, s.y) > Math.min(l.h, s.h) / 2);
      if (!line) { lines.push({ ...s }); continue; }
      const right = Math.max(line.x + line.w, s.x + s.w);
      const bottom = Math.max(line.y + line.h, s.y + s.h);
      line.x = Math.min(line.x, s.x);
      line.y = Math.min(line.y, s.y);
      line.w = right - line.x;
      line.h = bottom - line.y;
    }
    return lines;
  }

  /* The lines a finding covers, in page coordinates, ready to draw. */
  function lineBoxes(f) {
    const box = f.frame ? f.frame.getBoundingClientRect() : null;
    let rects;
    try { rects = f.range.getClientRects(); } catch { return { box, lines: [] }; }

    const spans = [];
    for (const r of rects) {
      if (!r.width || !r.height) continue;
      let x = r.left, y = r.top, w = r.width, h = r.height;
      if (box) {
        x += box.left; y += box.top;
        // Clip against the iframe's area: it scrolls inside, and without the
        // clip the rectangles would spill past the edges of the editor.
        const x1 = Math.max(x, box.left), y1 = Math.max(y, box.top);
        const x2 = Math.min(x + w, box.right), y2 = Math.min(y + h, box.bottom);
        if (x2 <= x1 || y2 <= y1) continue;
        x = x1; y = y1; w = x2 - x1; h = y2 - y1;
      }
      spans.push({ x, y, w, h });
    }
    return { box, lines: mergeLines(spans) };
  }

  const overlaps = (a, b) =>
    Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x) &&
    Math.min(a.y + a.h, b.y + b.h) > Math.max(a.y, b.y);

  function draw() {
    if (!stage.live) return;
    placeBar();
    stage.layer.textContent = '';

    /* One phrase, two findings: only the one you are reading about.
     *
     * A sentence can be too long AND be missing a comma, and then two washes
     * land on the same words. Stacked, they mix into a third colour that
     * belongs to neither, and two outlines run through the text a pixel
     * apart. The finding in the note is the one you are working on, so it
     * keeps the words; the other stands down whole — not just on the line
     * they share — and gets them back, in its own colour, the moment you step
     * onto it. Half a highlight left behind on the lines that did not clash
     * would read as a phrase nobody is talking about. */
    const cur = stage.findings[stage.i];
    const lit = cur?.range && cur.state === 'open' ? lineBoxes(cur).lines : [];

    for (let k = 0; k < stage.findings.length; k++) {
      const f = stage.findings[k];
      if (!f.range || f.state !== 'open') continue;
      const c = paint(f.severity);
      const { box, lines } = lineBoxes(f);
      if (k !== stage.i && lines.some((s) => lit.some((l) => overlaps(l, s)))) continue;

      for (const s of lines) {
        /* A few pixels of air around the words.
         *
         * A rectangle that ends exactly where the text ends puts its edge —
         * and the outline just outside it — on the last glyph, and the last
         * glyph is sometimes the whole finding: "the colon should not be bold"
         * highlights `iatrogenic:`, and the colon it is talking about ends up
         * under the border, with the text caret alongside it for company.
         * Selections in every editor ever written have this air; the highlight
         * should too. */
        let x = s.x - PAD_X, y = s.y - PAD_Y;
        let w = s.w + PAD_X * 2, h = s.h + PAD_Y * 2;
        if (box) {
          // Do not let the padding push the box out of the iframe it belongs to.
          const x1 = Math.max(x, box.left), y1 = Math.max(y, box.top);
          const x2 = Math.min(x + w, box.right), y2 = Math.min(y + h, box.bottom);
          x = x1; y = y1; w = x2 - x1; h = y2 - y1;
        }
        const mark = document.createElement('div');
        mark.className = 'rlx-mark' + (k === stage.i ? ' rlx-current' : '');
        mark.style.cssText = `left:${x}px; top:${y}px; width:${w}px; height:${h}px;` +
                             `background:${c.wash}; outline-color:${c.ink};`;
        stage.layer.appendChild(mark);
      }
    }
    drawCaret(stage.findings[stage.i]);
    placeNote();
  }

  /* The place the comma is missing from, on the current finding only: a rule
   * standing between the two characters it goes between, with the character
   * itself sitting above it. A washed phrase says *this one*; this says
   * *here*, which is the thing you cannot read off the message. */
  function drawCaret(f) {
    if (!f?.caret || f.state !== 'open' || !f.point) return;
    let rects;
    try { rects = f.caret.getClientRects(); } catch { return; }
    const r = rects[rects.length - 1];
    if (!r || !r.height) return;

    const box = f.frame ? f.frame.getBoundingClientRect() : null;
    let x = r.right, y = r.top;
    if (box) {
      x += box.left; y += box.top;
      // Inside the iframe's own scroll, like the marks.
      if (x < box.left || x > box.right || y + r.height < box.top || y > box.bottom) return;
    }
    const c = paint(f.severity);
    const el = document.createElement('div');
    el.className = 'rlx-caret';
    el.dataset.insert = f.point.insert;
    el.style.cssText = `left:${x - 1}px; top:${y}px; height:${r.height}px; ` +
                       `background:${c.ink}; color:${c.ink};`;
    stage.layer.appendChild(el);
  }

  /* The note of the current finding — including one that has just closed
   * itself under your hands. It stays where the words were, says what became
   * of them, and says which key moves on: nothing about typing moves you. */
  /* Out of the way while the pointer is on it, back the moment it leaves.
   * Events keep coming while it is click-through — they are simply arriving
   * from the text below instead of from the note — so leaving is noticed as
   * reliably as arriving. Iframe coordinates are relative to the iframe: its
   * own offset has to go back in before comparing with a `position:fixed`
   * box in the page above. */
  function ghostNote(e, frame) {
    const note = stage.note;
    if (!stage.live || !note || note.hidden) return;
    const off = frame ? frame.getBoundingClientRect() : { left: 0, top: 0 };
    const x = e.clientX + off.left, y = e.clientY + off.top;
    const r = note.getBoundingClientRect();
    note.classList.toggle('rlx-ghost',
      x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
  }

  const onMove = (e) => ghostNote(e, null);

  function placeNote() {
    const f = stage.findings[stage.i];
    if (!f || !stage.live) { if (stage.note) stage.note.hidden = true; return; }
    const settled = f.state !== 'open';
    const c = settled ? SETTLED : paint(f.severity);
    stage.note.hidden = false;
    stage.note.classList.remove('rlx-ghost');   // a new place, a fresh start
    stage.note.style.borderLeftColor = c.ink;
    stage.note.innerHTML = '';

    const head = document.createElement('div');
    head.className = 'rlx-head';
    const sev = document.createElement('span');
    sev.style.cssText = `color:${c.ink}; font-weight:700`;
    sev.textContent = settled ? (f.state === 'ignored' ? '✓ ignored' : '✓ fixed')
                              : (f.severity || 'finding');
    const where = document.createElement('span');
    where.textContent = f.check + (f.line ? ` · line ${f.line}` : '');
    head.append(sev, where);

    const msg = document.createElement('div');
    msg.className = 'rlx-msg';
    msg.textContent = f.message;
    stage.note.append(head, msg);

    // The phrase as it should read. The message quotes it as it is, which
    // leaves the difference between the two for the reader to find.
    if (f.point?.fixed && !settled) {
      const fix = document.createElement('div');
      fix.className = 'rlx-fix';
      fix.style.color = c.ink;
      fix.textContent = f.point.fixed;
      stage.note.appendChild(fix);
    }

    /* The list line. A `ListCaps` finding on a capital that is a name is not
     * a finding, nor is an `Acronyms` finding on an acronym nobody spells out,
     * and the only thing standing between the two is a file — so the note says
     * which state this one is in: not in the file, or proposed and waiting. The words, not a button: the note fades and lets the
     * pointer through the moment the mouse comes near it, which is what makes
     * the text underneath selectable and what makes anything clickable in here
     * unclickable. The click lives on the bar, where the actions live. */
    if (f.propose && !settled) {
      const on = LISTS[f.list];
      const when = proposed()[fold(f.propose)];
      const line = document.createElement('div');
      line.className = 'rlx-hint';
      line.textContent = when
        ? `'${f.propose}' was proposed for the ${on.of} on ${when} — waiting for it to land.`
        : `'${f.propose}' is not in the ${on.of}. Press p to add it.`;
      stage.note.appendChild(line);
    }

    // Settled, and still on screen: the one thing left to say is how to leave.
    if (settled) {
      const hint = document.createElement('div');
      hint.className = 'rlx-hint';
      hint.textContent = 'Alt + → for the next one, Alt + ← to go back.';
      stage.note.appendChild(hint);
    }

    // The snippet only when it is NOT on screen. When the finding is anchored
    // you are already looking at the highlighted words, and repeating them
    // here just makes the note tall enough to cover them. Once it is settled
    // the old wording is history: you are looking at what replaced it.
    if (f.snippet && !f.range && !settled) {
      const s = document.createElement('div');
      s.className = 'rlx-snippet';
      s.textContent = f.snippet;
      stage.note.appendChild(s);
    }

    const spot = highlightBounds(f);
    if (!spot) {
      stage.note.style.left = '14px';
      stage.note.style.top = '14px';
      return;
    }
    const n = stage.note.getBoundingClientRect();
    const { left, top } = notePlacement(spot, n.width, n.height);
    stage.note.style.left = `${left}px`;
    stage.note.style.top = `${top}px`;
  }

  /* The box around the WHOLE highlight, in page coordinates.
   *
   * `getClientRects()[0]` is only the first line. Put the note under that and
   * a finding that wraps gets its remaining lines covered by the very note
   * explaining them — which is exactly what you do not want to hide. */
  function highlightBounds(f) {
    const page = (r, frame) => {
      if (!r || (!r.width && !r.height)) return null;
      const off = frame ? frame.getBoundingClientRect() : { left: 0, top: 0 };
      return { left: r.left + off.left, top: r.top + off.top,
               right: r.right + off.left, bottom: r.bottom + off.top };
    };
    if (f.range) {
      try {
        const box = page(f.range.getBoundingClientRect(), f.frame);
        if (box) return box;
      } catch { /* stale range: the paragraph below answers instead */ }
    }
    // The words are gone — you have just edited them — but the paragraph they
    // were in is still there, and it is what you are looking at.
    if (f.home?.el?.isConnected) return page(f.home.el.getBoundingClientRect(), f.home.frame);
    return null;
  }

  /* Where to put the note so it stays on screen and off the highlight.
   *
   * Four places are tried in order — below, above, right, left — each one
   * pulled back inside the viewport first and then checked for overlap, since
   * being pushed back in can slide a candidate right over the text it was
   * meant to sit clear of. The first that lands clean wins. If the highlight
   * is so tall that nothing fits beside it, the note goes below anyway and
   * hovering it fades it out, which is what the CSS is for. */
  /* Where the bar can stand without covering anything.
   *
   * It used to sit 18px off the bottom and that was the end of it — which is
   * fine until the page puts something there, and Radiopaedia does: a sticky
   * promo strip, and on the edit page the Tags field and the buttons under it.
   * A bar that covers the form you came to fill in is worse than no bar.
   *
   * So it looks. `elementsFromPoint` along the edge it wants to occupy, at its
   * own three x positions rather than one, because a banner does not have to
   * be centred to be in the way; anything of ours is skipped; and the first
   * thing found that is `fixed` or `sticky` — itself or through an ancestor,
   * since the strip is usually a child of the pinned container — decides how
   * far up to move. Everything else scrolls away on its own and is not worth
   * dodging.
   *
   * Capped at 40% of the window: a fixed element that tall is a cookie wall or
   * a lightbox, and the answer to those is not to climb over them.
   *
   * Measured at most four times a second. Scrolling fires this through the
   * same frame the highlights are redrawn in, and hit-testing three points and
   * reading a computed style on each is not free. */
  const BAR_EDGE = 18;
  const BAR_TOP_KEY = 'rlx-bar-top';   // which edge you last put it on

  function barIsTop() {
    try { return localStorage.getItem(BAR_TOP_KEY) === '1'; } catch { return false; }
  }

  function setBarTop(on) {
    try { localStorage.setItem(BAR_TOP_KEY, on ? '1' : '0'); } catch { /* this session only */ }
    placeBar(true);
    placeNote();
  }

  function pinnedAncestor(el) {
    for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      const pos = getComputedStyle(n).position;
      if (pos === 'fixed' || pos === 'sticky') return n;
    }
    return null;
  }

  let barMeasured = 0;
  function placeBar(force) {
    if (!stage.live || !stage.bar) return;
    const now = performance.now();
    if (!force && now - barMeasured < 250) return;
    barMeasured = now;

    const top = barIsTop();
    const r = stage.bar.getBoundingClientRect();
    const y = top ? 2 : innerHeight - 2;
    const xs = [r.left + 2, (r.left + r.right) / 2, r.right - 2];

    let clear = BAR_EDGE;
    for (const x0 of xs) {
      const x = Math.min(Math.max(x0, 1), innerWidth - 1);
      for (const el of document.elementsFromPoint(x, y)) {
        if (el.closest('#rlx-bar, #rlx-note, #rlx-banner, #rlx-layer')) continue;
        const pinned = pinnedAncestor(el);
        if (!pinned) continue;
        const b = pinned.getBoundingClientRect();
        const room = (top ? b.bottom : innerHeight - b.top) + BAR_EDGE;
        if (room > clear) clear = room;
        break;
      }
    }
    clear = Math.min(clear, innerHeight * 0.4);

    stage.bar.style.top = top ? `${Math.round(clear)}px` : 'auto';
    stage.bar.style.bottom = top ? 'auto' : `${Math.round(clear)}px`;
  }

  function notePlacement(spot, w, h) {
    const gap = 10, edge = 12;

    /* The room the bar takes, on the edge the bar is actually on — measured
     * rather than assumed. It used to be 76px of reserved space at the bottom
     * and nothing at the top, which was true while the bar could only be in
     * one place. */
    const b = stage.bar?.getBoundingClientRect();
    const barAtTop = b && b.top < innerHeight / 2;
    const roomTop = b && barAtTop ? b.bottom + gap : edge;
    const roomBottom = b && !barAtTop ? innerHeight - b.top + gap : edge;

    const clamp = (p) => ({
      left: Math.min(Math.max(p.left, edge), Math.max(edge, innerWidth - w - edge)),
      top: Math.min(Math.max(p.top, roomTop), Math.max(roomTop, innerHeight - h - roomBottom)),
    });
    const clear = (p) => p.left + w <= spot.left || p.left >= spot.right ||
                         p.top + h <= spot.top || p.top >= spot.bottom;

    const tries = [
      { left: spot.left, top: spot.bottom + gap },
      { left: spot.left, top: spot.top - h - gap },
      { left: spot.right + gap, top: spot.top },
      { left: spot.left - w - gap, top: spot.top },
    ];
    for (const t of tries) {
      const p = clamp(t);
      if (clear(p)) return p;
    }
    return clamp(tries[0]);
  }

  function updateBar() {
    if (!stage.live) return;
    const open = stage.findings.filter((f) => f.state === 'open');
    const counts = { error: 0, warning: 0, suggestion: 0, other: 0 };
    for (const f of open) counts[f.severity in counts ? f.severity : 'other']++;
    const f = stage.findings[stage.i];
    const position = f ? open.indexOf(f) + 1 : 0;

    /* The count, in the colours the rest of the script already speaks in.
     *
     * It used to read "–/0 · 0 error · 0 warning · 0 other", which spends a
     * third of the bar to say nothing three times over. A severity is a colour
     * here — on the highlight, on the note, on the button by the title — so it
     * can be a dot, and a severity nothing is left of simply does not appear.
     * When the walk is over the numbers are over too, and what is worth saying
     * is what you did: "All reviewed · 9 fixed · 3 ignored".
     *
     * The names are counted apart rather than not counted. The linter said
     * something about them and we decided it did not apply: that is a
     * decision, and a decision belongs on screen next to the numbers it
     * changed, not behind them. */
    const count = stage.bar.querySelector('.rlx-count');
    count.textContent = '';

    const word = (text, cls) => {
      if (count.childNodes.length) {
        const dot = document.createElement('span');
        dot.className = 'rlx-sepdot';
        dot.textContent = '·';
        count.appendChild(dot);
      }
      const el = document.createElement('span');
      if (cls) el.className = cls;
      el.textContent = text;
      count.appendChild(el);
      return el;
    };

    if (open.length) {
      word(`${position ? position : '–'}/${open.length}`, 'rlx-of');
      for (const sev of [...SEVEREST, 'other']) {
        if (!counts[sev]) continue;
        const tally = word('', 'rlx-tally');
        const dot = document.createElement('span');
        dot.className = 'rlx-dot';
        dot.style.background = paint(sev === 'other' ? null : sev).ink;
        const n = document.createElement('span');
        n.textContent = String(counts[sev]);
        tally.append(dot, n);
        tally.title = `${counts[sev]} ${sev}${counts[sev] > 1 ? 's' : ''}`;
      }
    } else {
      word('All reviewed', 'rlx-of');
      const done = stage.findings.filter((x) => x.state === 'done').length;
      const ignored = stage.findings.filter((x) => x.state === 'ignored').length;
      if (done) word(`${done} fixed`);
      if (ignored) word(`${ignored} ignored`);
    }
    for (const said of knownSaid(stage.hidden || {})) word(said, 'rlx-known');

    let status = '';
    if (!stage.findings.length) status = 'No findings: the article is clean.';
    // A settled finding has no snippet in the text by definition — saying it
    // "cannot be found" about the one you have just fixed reads as a fault.
    else if (f && f.state !== 'open' && open.length) status = 'Alt + → for the next one';
    else if (f && f.state === 'open' && !f.range) status = 'snippet not found in the editor text';
    stage.bar.querySelector('.rlx-status').textContent = status;
    placeBar();

    const disable = (name, v) => {
      const b = stage.bar.querySelector(`[data-act="${name}"]`);
      if (b) b.disabled = v;
    };
    disable('prev', open.length < 2); disable('next', open.length < 2);
    disable('done', !f); disable('ignore', !f); disable('copy', !f);
    disable('undo', !stage.history.length);

    /* What is on the bar is what there is to do. A button that can never be
     * pressed from here is not an option, it is furniture: with nothing left
     * open there is no finding to mark, to skip or to copy, and Undo, Re-lint
     * and the close button are the whole of what is left. Nothing moves while
     * you are working — this is the end of the walk, not a state you pass
     * through. */
    const show = (name, on) => {
      const b = stage.bar.querySelector(`[data-act="${name}"]`);
      if (b) b.hidden = !on;
    };
    const walking = open.length > 0;
    for (const b of ['prev', 'next', 'done', 'ignore', 'copy']) show(b, walking);
    stage.bar.querySelector('.rlx-sep-nav').hidden = !walking;

    // Offered only where there is a word to offer: a finding one of the lists
    // could have answered, whose word is in neither that file nor your own
    // list of things already proposed. Hidden otherwise — it appears exactly
    // when it works, and it says which list it would go to.
    const offer = f && f.state === 'open' && !proposed()[fold(f.propose || '')] ? f.propose : null;
    const on = offer ? LISTS[f.list] : null;
    const add = stage.bar.querySelector('[data-act="propose"]');
    if (add) {
      add.hidden = !on;
      add.textContent = on ? on.button : '+ Name';
      add.title = on ? `Add '${offer}' to the shared ${on.of} (p)` : '';
    }
  }

  // ————————————————————————————————————————————————— navigation and actions

  function goTo(k) {
    stage.i = k;
    const f = stage.findings[k];
    if (f?.range) bringIntoView(f);
    draw();
    updateBar();
  }

  function bringIntoView(f) {
    try {
      const c = f.range.startContainer;
      const el = c.nodeType === 1 ? c : c.parentElement;
      el?.scrollIntoView({ block: 'center', inline: 'nearest' });
      // If the text lives in an iframe, scrolling inside it is only half the
      // job: the iframe itself has to be brought into view in the page above.
      f.frame?.scrollIntoView({ block: 'nearest' });
    } catch { /* the range can be stale after an edit */ }
  }

  function step(dir) {
    const n = stage.findings.length;
    if (!n) { stage.i = -1; draw(); updateBar(); return; }
    for (let k = 1; k <= n; k++) {
      const j = ((stage.i + dir * k) % n + n) % n;
      if (stage.findings[j].state === 'open') return goTo(j);
    }
    stage.i = -1;
    draw();
    updateBar();
  }

  function mark(state) {
    const f = stage.findings[stage.i];
    if (!f) return;
    stage.history.push({ i: stage.i, state: f.state });
    f.state = state;
    f.range = null;
    step(1);
  }

  function undo() {
    const p = stage.history.pop();
    if (!p) return;
    stage.findings[p.i].state = p.state;
    anchor(stage.findings, stage.roots);
    goTo(p.i);
  }

  function act(what) {
    switch (what) {
      case 'prev': return step(-1);
      case 'next': return step(1);
      case 'done': return mark('done');
      case 'ignore': return mark('ignored');
      case 'undo': return undo();
      case 'copy': {
        const f = stage.findings[stage.i];
        if (f) navigator.clipboard?.writeText(f.message);
        return;
      }
      /* The name to the clipboard, the file to a new tab. Two halves of one
       * gesture: GitHub has no way to prefill the contents of a file you are
       * editing — that exists for new files and for issues, not for this — so
       * the name travels in the clipboard and you paste it where you want it,
       * which is also the last chance to correct it before it becomes the
       * list everybody reads.
       *
       * Nothing is sent. The script writes to the clipboard and opens a page;
       * what reaches the repository is what you type into GitHub yourself. */
      case 'propose': {
        const f = stage.findings[stage.i];
        if (!f?.propose) return;
        navigator.clipboard?.writeText(f.propose);
        rememberProposed(f.propose);
        window.open(LISTS[f.list].editUrl, '_blank', 'noopener');
        updateBar();
        placeNote();
        return;
      }
      case 'flip': return setBarTop(!barIsTop());
      case 'reload': return runLint(stage.slug, { force: true });
      case 'close': return destroyStage();
    }
  }

  function isTyping(t) {
    if (!t || t.nodeType !== 1) return false;
    if (t.isContentEditable) return true;
    const tag = t.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  function onKey(e) {
    if (!stage.live) return;
    if (e.metaKey || e.ctrlKey) return;

    // With Alt the shortcuts work even while you are typing in the editor.
    if (e.altKey) {
      const m = { ArrowRight: 'next', ArrowLeft: 'prev', Enter: 'done', Backspace: 'ignore' }[e.key];
      if (m) { e.preventDefault(); act(m); }
      return;
    }
    if (isTyping(e.target)) return;

    const m = { j: 'next', k: 'prev', s: 'done', x: 'ignore', u: 'undo',
                c: 'copy', p: 'propose', t: 'flip', Escape: 'close' }[e.key];
    if (m) { e.preventDefault(); act(m); }
  }

  /* Re-anchor after an edit. A snippet that can no longer be found is a
   * snippet you fixed: the finding closes itself (and "undo" reopens it).
   *
   * What it does NOT do is move you. Closing a finding is something your
   * typing does; going to the next one is something you do, with a key. They
   * used to be the same event, and the first character you changed took the
   * note off the screen and scrolled the editor to the next finding while you
   * were still mid-word — you could no longer see the sentence you were
   * rewriting, and getting back to it meant scrolling by hand. Now the note
   * stays on the paragraph, turns green, and waits. */
  let reanchorPending = null;
  function reanchorSoon() {
    clearTimeout(reanchorPending);
    reanchorPending = setTimeout(() => {
      if (!stage.live) return;
      const before = new Map(stage.findings.map((f, k) => [k, !!f.range]));
      anchor(stage.findings, stage.roots);
      for (let k = 0; k < stage.findings.length; k++) {
        const f = stage.findings[k];
        if (f.state === 'open' && before.get(k) && !f.range) {
          stage.history.push({ i: k, state: 'open' });
          f.state = 'done';
        }
      }
      draw();
      updateBar();
    }, 700);
  }

  // ————————————————————————————————————————————————————————— the button

  function currentSlug() {
    const m = /^\/articles\/([^/?#]+)/.exec(location.pathname);
    return m ? decodeURIComponent(m[1]) : null;
  }
  const inEditor = () => /\/edit\/?$/.test(location.pathname);

  let group = null, button = null, toggle = null, railToggle = null, citesToggle = null;
  let forceBtn = null;

  /* What the last answer said about this article, in the colour of the boxes
   * it would draw on the text: red if anything is an error, amber if anything
   * is a warning, blue for suggestions, grey for an article with nothing to
   * fix. Same `COLORS` table the highlights and the note use — the button is
   * meant to be read as the same thing, seen from further away.
   *
   * It is kept out here rather than on the button because Radiopaedia remounts
   * its own page and takes the button with it: the next `mountButton()` paints
   * the new one from this. */
  let verdict = null;
  let forcing = false;
  const SEVEREST = ['error', 'warning', 'suggestion'];

  /* Automatic or manual, as last chosen here. `localStorage` and not the
   * `sessionStorage` the answers live in: an answer is worth one visit, a
   * preference is worth keeping — being asked again in every new tab is not a
   * preference, it is a question. Unreadable storage (private mode, a browser
   * with cookies walled off) falls back to the constant rather than throwing
   * the button away. */
  function auto() {
    try {
      const v = localStorage.getItem(AUTO_KEY);
      if (v !== null) return v === '1';
    } catch { /* fall through to the default */ }
    return PREVIEW_ON_LOAD;
  }

  function setAuto(on) {
    try { localStorage.setItem(AUTO_KEY, on ? '1' : '0'); } catch { /* this session only */ }
    paintToggle();
    if (on) return previewSoon();
    // Manual again: the colour was an answer to a question nobody is asking
    // any more, and a stale answer is worse than none.
    verdict = null;
    paintButton();
  }

  function paintToggle() {
    if (!toggle) return;
    const on = auto();
    toggle.classList.toggle('rlx-on', on);
    toggle.setAttribute('aria-pressed', String(on));
    toggle.title = on
      ? 'Automatic: every article you open is sent to the linter and the button ' +
        'takes the colour of what it found. Click for manual.'
      : 'Manual: nothing is asked until you press Lint. Click for automatic, ' +
        'where the button colours itself as each article opens.';
  }

  function paintButton() {
    if (!button) return;
    button.classList.toggle('rlx-btn-asking', verdict === 'asking');
    if (!verdict || verdict === 'asking') {
      group?.style.removeProperty('--rlx-ink');
      return;
    }
    // On the pair rather than the button: the switch inherits the same ink.
    group?.style.setProperty('--rlx-ink', verdict.ink);
    button.title = verdict.title;
  }

  /* Ask about the article while you are still reading it, and answer in the
   * colour of the button. The request is the same one the click would make and
   * the answer is kept in `sessionStorage`, so clicking afterwards costs
   * nothing and the "nothing to lint" banner comes back instantly.
   *
   * Silent on failure, on purpose: nothing the page did not ask for should
   * ever put an alert in front of you. A linter that cannot be reached leaves
   * a button that looks exactly like one that has not been asked yet, which is
   * the truth. */
  async function preview(slug, opts = {}) {
    verdict = 'asking';
    paintButton();
    try {
      const findings = actionable(await findingsFor(slug, opts));
      const counts = { error: 0, warning: 0, suggestion: 0, other: 0 };
      for (const f of findings) counts[f.severity in counts ? f.severity : 'other']++;
      const worst = SEVEREST.find((sev) => counts[sev]);
      const said = SEVEREST.filter((sev) => counts[sev])
        .map((sev) => `${counts[sev]} ${sev}${counts[sev] > 1 ? 's' : ''}`)
        .join(', ');
      verdict = {
        ink: paint(worst).ink,   // no worst: `paint` answers grey, which is the answer
        title: findings.length
          ? `The linter found ${said || findings.length + ' things'} in this article — ` +
            'click to fix them in the editor'
          : 'The linter found nothing to fix in this article',
      };
    } catch {
      verdict = null;
    }
    paintButton();
  }

  const FORCE_TITLE =
    'Have the linter read the article again rather than answer from what it ' +
    'read last time — the ⟳ on radiopaedia.work/lint/linter, from here';

  function paintForce() {
    if (!forceBtn) return;
    forceBtn.classList.toggle('rlx-busy', forcing);
    forceBtn.disabled = forcing;
    forceBtn.title = forcing ? 'The linter is reading the article again…' : FORCE_TITLE;
  }

  /* Pressing it: the linter first, this tab second, and in that order for a
   * reason. Forgetting what this tab remembers and asking again would come
   * straight back with the same words out of the linter's own copy; forcing
   * the linter and keeping the copy here would leave the fresh answer unread.
   * So — force, forget, ask — and then show whichever of the two things this
   * page can show: the findings on the text in the editor, the colour of the
   * button outside it.
   *
   * Loud on failure, unlike `preview`. Nobody is surprised by an alert they
   * pressed a button for, and a ↻ that goes round once and changes nothing
   * would be a lie about what the linter has read. */
  async function forceRefresh(slug) {
    if (!slug || forcing) return;
    forcing = true;
    paintForce();
    try {
      await forceLinter(slug);
      if (inEditor()) await runLint(slug, { force: true });
      else await preview(slug, { force: true });
    } catch (err) {
      alert(`Could not have the linter read the article again.\n\n${err.message}`);
    } finally {
      forcing = false;
      paintForce();
    }
  }

  function mountButton() {
    // `isConnected` rather than a query: the observer also fires for the marks
    // we redraw ourselves on every scroll frame, and searching the document
    // each time would be wasted work.
    if (group?.isConnected) return;
    const slug = currentSlug();
    if (!slug) return;

    const g = document.createElement('span');
    g.className = 'rlx-group';

    const b = document.createElement('button');
    b.className = 'rlx-btn';
    b.type = 'button';
    b.textContent = 'Lint';
    b.title = 'Run the linter on this article and show the findings on the text';
    b.addEventListener('click', () => {
      if (inEditor()) return runLint(slug, {});
      return preflight(slug);
    });

    /* Next to `Lint` rather than out at the end, because it is the other
       thing this group DOES: the two beyond it are switches, and a press that
       goes off and asks the linter something belongs beside the press that
       already does. */
    const f = document.createElement('button');
    f.className = 'rlx-auto rlx-force';
    f.type = 'button';
    const glyph = document.createElement('span');
    glyph.className = 'rlx-force-glyph';
    glyph.textContent = '\u21bb';
    f.appendChild(glyph);
    f.addEventListener('click', () => forceRefresh(slug));

    // The switch. A word rather than a symbol: this one decides whether every
    // article you open becomes a request, and that deserves to be readable.
    const t = document.createElement('button');
    t.className = 'rlx-auto';
    t.type = 'button';
    t.textContent = 'auto';
    t.addEventListener('click', () => setAuto(!auto()));

    /* The third control, and the smallest: the structure rail on or off. A
       flag rather than a word because the pair beside it already carries two,
       and because what it switches is visible the moment it is on. */
    const r = document.createElement('button');
    r.className = 'rlx-auto rlx-rail-toggle';
    r.type = 'button';
    r.textContent = '\u2691';
    r.title = 'Show the sections this kind of article is missing, in the margin';
    r.addEventListener('click', () => setRailOn(!railOn()));

    g.append(b, f, t, r);

    /* The fourth, and only where it has anything to switch: the citation chips
       live in the editor and nowhere else, so on an article page this control
       would be a switch for something that is not there. */
    let c = null;
    if (inEditor()) {
      c = document.createElement('button');
      c.className = 'rlx-auto rlx-cites-toggle';
      c.type = 'button';
      c.textContent = '\u275d';
      c.title = 'Show a Lint citation chip beside every reference';
      c.addEventListener('click', () => setCitesOn(!citesOn()));
      g.appendChild(c);
    }

    const title = inEditor() ? null : visibleTitle();
    if (title) title.appendChild(g);
    else pinToCorner(g);

    // Attached does not mean visible. If the chosen title sits in a hidden
    // branch — and a page seen by a signed-in user has more than one `h1`,
    // menus and modals included — the button exists, `querySelector` finds it,
    // and there is nothing on screen. Better to notice here than later.
    const box = b.getBoundingClientRect();
    if (!box.width || !box.height) pinToCorner(g);

    group = g; button = b; toggle = t; railToggle = r; citesToggle = c;
    forceBtn = f;
    paintButton();
    paintForce();
    paintToggle();
    paintRailToggle();
    paintCitesToggle();
  }

  /* The fallback spot: fixed at the top right, outside any branch of the site.
   * Ugly but always visible, which is what counts here. */
  function pinToCorner(b) {
    b.classList.add('rlx-btn-float');
    document.body.appendChild(b);
  }

  /* The first title that actually takes up room on screen. */
  function visibleTitle() {
    const candidates = document.querySelectorAll(
      'h1.header-title, .page-header h1, #article-title, h1');
    for (const el of candidates) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return el;
    }
    return null;
  }

  // ————————————————————————————————————————————————— the structure

  /* What headings this KIND of article is supposed to have, and which of them
   * are not there.
   *
   * The linter answers the other half of this question. `Radiopaedia.HeadingsValid`
   * says when a heading is not one this article type recognises — "Osteology"
   * is not a recognised heading for this article type — and it says nothing at
   * all about the heading that should be there and isn't. The two halves do not
   * overlap: one reads what is written, this one reads what is missing from it.
   *
   * The canon is `article-structure.json`, next to this file in the repository
   * and fetched the same way `proper-nouns.txt` is. It is a transcription of
   * Radiopaedia's own `<type>-article-structure` help pages — twenty-three
   * structures, three hundred and twenty-seven headings, each with the level it
   * belongs at and the heading it belongs under — generated by
   * `tools/export-structure.py`. Radiopaedia's recommendations, not ours: when
   * they change theirs, this is an old transcription until somebody re-runs it.
   *
   * The parent is part of a heading's identity, which is the one subtlety worth
   * stating twice. `Complications` under `Clinical presentation` is the
   * complication of the disease; under `Treatment and prognosis` it is the
   * complication of the treatment. They are two rows of the canon and an
   * article can want both.
   *
   * Only the REQUIRED headings become chips. Every canon has thirty-odd
   * optional ones and an article that has all six of its obligations is not
   * improved by being told about thirty things Radiopaedia never asked for. */

  const STRUCTURE_URL = 'https://raw.githubusercontent.com/gmadevs/radiopaedia-lint-userscript/main/article-structure.json';
  const STRUCTURE_TIMEOUT = 15_000;
  const STRUCTURE_MAX = 512 * 1024;
  const STRUCTURE_KEY = 'rlx-structure';   // the file, for this tab's session
  const RAIL_KEY = 'rlx-rail';             // the switch, remembered across sessions
  const PROFILE_KEY = 'rlx-profile';       // {slug: the kind you said it was}
  const HUSHED_KEY = 'rlx-hushed';         // {slug: [headings you said it does not need]}
  const OPTIONAL_KEY = 'rlx-optional';     // whether the offered ones are shown too

  /* How the article body reads on the page. Radiopaedia renders an editor
   * "Heading 1" as `<h4 class="linked-header section-title">`, a "Heading 2"
   * as `<h5>`, a "Heading 3" as `<h6>` — the page's own `<h1>` is the article
   * title and its `<h2>`s belong to the furniture around the text (the "On
   * this page" panel, References, Promoted articles). So the levels the canon
   * counts in are the tags below, and nothing else on the page can be mistaken
   * for one. */
  const ARTICLE_BODY = '#content.article .body.user-generated-content';
  const SECTION_SEL = 'h4.section-title, h5.section-title, h6.section-title';
  const TAG_LEVEL = { H4: 1, H5: 2, H6: 3 };

  /* Between a chip and the text column. Wider than it looks like it needs to
   * be: the thread runs down this corridor, and at twelve pixels it had three
   * to turn a corner in and came out a bracket rather than a line. */
  const GUTTER_GAP = 20;
  /* And between a chip and the edge of the window, which needs nothing like as
   * much. The two were the same number, so widening the corridor for the
   * thread also took eight pixels off the far side where nothing runs — and
   * pushed the width at which the chips give up on words from a shade under
   * 1250 to a shade under 1280, which is a laptop. */
  const GUTTER_EDGE = 6;
  const GUTTER_MIN = 132;   // narrower than this and there is no room for words
  const CHIP_MAX = 190;
  const MISS = COLORS.warning;   // a section Radiopaedia asks for and isn't there

  let CANON = null;         // the file, compiled; `null` is "we do not know"
  let canonAsked = null;

  function askStructure() {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: STRUCTURE_URL,
        timeout: STRUCTURE_TIMEOUT,
        onload: (r) => {
          const body = r.responseText || '';
          if (r.status >= 400 || body.length > STRUCTURE_MAX) return resolve(null);
          resolve(body);
        },
        onerror: () => resolve(null),
        ontimeout: () => resolve(null),
      });
    });
  }

  /* The file, turned into the things the checks actually ask for: the regexes
   * compiled, and one lookup per canon from a heading's normalised text to the
   * rows that could be it. Two rows can share a text — the two `Complications`
   * — so it is a list and the parent picks between them.
   *
   * The patterns cross from Python to JavaScript unchanged. They use `\b`,
   * `\w`, `\s`, alternation and optional groups, and every one of those means
   * the same thing in both. Anything that did not would have had to be
   * rewritten by hand, and would have drifted the first time upstream changed. */
  function compile(raw) {
    const canons = {}, index = {}, modalities = {};
    for (const [name, rows] of Object.entries(raw.canons || {})) {
      canons[name] = rows;
      const byText = new Map();
      rows.forEach((c) => {
        const key = normaliseHeading(c.t);
        if (!byText.has(key)) byText.set(key, []);
        byText.get(key).push(c);
      });
      index[name] = byText;
      modalities[name] = rows.filter((c) => c.p === 'Radiographic features').map((c) => c.t);
    }
    return {
      canons, index, modalities,
      profiles: raw.profiles || {},
      synonyms: raw.synonyms || {},
      rules: (raw.rules || []).map(([p, r]) => [p, new RegExp(r, 'i')]),
      notPathologyOnly: new Set(raw.notPathologyOnly || []),
      diseaseVeto: new RegExp(raw.diseaseVeto || '(?!)', 'i'),
      anatomyTypes: (raw.anatomyTypes || []).map(([p, r]) => [p, new RegExp(r, 'i')]),
      byArticleType: raw.byArticleType || {},
      fallback: raw.fallbackProfile || 'disease',
      modalityEntry: raw.modalityEntry,
      modalityTitle: raw.modalityTitle,
      transcribed: raw.transcribed,
    };
  }

  async function canon() {
    if (CANON) return CANON;
    if (canonAsked) return canonAsked;
    canonAsked = (async () => {
      let text = sessionStorage.getItem(STRUCTURE_KEY);
      if (text == null) {
        text = await askStructure();
        if (text != null) {
          try { sessionStorage.setItem(STRUCTURE_KEY, text); } catch { /* quota: never mind */ }
        }
      }
      let raw = null;
      try { raw = text == null ? null : JSON.parse(text); } catch { raw = null; }
      CANON = raw && raw.canons ? compile(raw) : null;
      return CANON;
    })();
    return canonAsked;
  }

  /* A heading reduced to how it compares. Radiopaedia has zero-width characters
   * sitting inside headings — `Radiographic features` comes back from the
   * linter with a U+200B stuck to the front of it — and bold markers, and
   * trailing colons, none of which are part of the name. */
  const HEADING_NOISE = /[​‌‍﻿*_`]+/g;

  function normaliseHeading(text) {
    return String(text ?? '')
      .replace(HEADING_NOISE, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^:+|:+$/g, '')
      .trim()
      .toLowerCase();
  }

  /* The canonical name of a heading read off the page, or null for one the
   * canon does not have.
   *
   * The canon first and the synonyms second, never the other way round.
   * `Histology` is a way of writing `Microscopic appearance` in an article
   * about a disease, and in the anatomy canon it is a row of its own — there,
   * it has to stay itself. */
  function canonicalHeading(text, canonName) {
    const key = normaliseHeading(text);
    const byText = CANON.index[canonName] || CANON.index.standard;
    if (byText.has(key)) return byText.get(key)[0].t;
    const target = CANON.synonyms[key];
    if (target && byText.has(normaliseHeading(target))) return target;
    return null;
  }

  /* What kind of article this is.
   *
   * The lint API says first, and where it says anything it is right: it is
   * Radiopaedia's own classification of its own article, not a guess about it.
   * It only distinguishes a few kinds — anatomy and classification are the
   * ones that matter, and everything else arrives as `general` — so the rest
   * is the ordered list of title rules, first match wins, ported from the
   * project that wrote them.
   *
   * The anatomical SUB-type is a guess from the title and stays one: the API
   * says `anatomy_general` for a bone and for a nerve alike, and a bone wants
   * `Ossification` where a nerve wants a course. A wrong guess costs three
   * chips, and the menu in the rail header is the answer to it.
   *
   * Three rules are held back by a title that names a disease: `Iodinated
   * contrast induced thyrotoxicosis` is not a contrast agent, it is the
   * thyrotoxicosis one causes. */
  /* The article's title, and only it.
   *
   * `visibleTitle()` returns the `<h1>` — which by now has the Lint button
   * inside it, so its `textContent` reads "CSF overdrainage Lint auto ⚑". Feed
   * that to the rules and they are matching partly on our own furniture. The
   * clone is thrown away immediately; the page keeps its heading. */
  function articleTitle() {
    const h1 = visibleTitle();
    if (h1) {
      const clean = h1.cloneNode(true);
      clean.querySelector('.rlx-group')?.remove();
      const text = tidy(clean.textContent);
      if (text) return text;
    }
    return tidy(document.title.split('|')[0]);
  }

  function profileFor(title, articleType) {
    const chosen = chosenProfile();
    if (chosen && CANON.profiles[chosen]) return chosen;

    const text = tidy(title);
    const base = CANON.byArticleType[tidy(articleType)];
    if (base === 'anatomy') {
      for (const [profile, re] of CANON.anatomyTypes) if (re.test(text)) return profile;
      return 'anatomy';
    }
    if (base) return base;

    for (const [profile, re] of CANON.rules) {
      if (!re.test(text)) continue;
      if (CANON.notPathologyOnly.has(profile) && CANON.diseaseVeto.test(text)) continue;
      return profile;
    }
    return CANON.fallback;
  }

  // ————————————————————————————— what the page has, and what it has not

  /* The headings of the article body, in order, each with the heading it sits
   * under. The parent is the last heading of a smaller level seen before it,
   * which is the same rule Radiopaedia's own linter uses to decide that a
   * section is under the wrong one. */
  function sectionsOnPage() {
    const body = document.querySelector(ARTICLE_BODY);
    if (!body) return null;
    const found = [], stack = [];
    for (const el of body.querySelectorAll(SECTION_SEL)) {
      // The promoted-articles block is user-generated content too, and it is
      // not the article.
      if (el.closest('.snippet, .expandable')) continue;
      const level = TAG_LEVEL[el.tagName];
      if (!level) continue;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      const parent = stack.length ? stack[stack.length - 1].title : null;
      const title = tidy(el.textContent);
      stack.push({ level, title });
      found.push({ el, level, title, parent });
    }
    return { body, found };
  }

  /* Which rows of the canon the page's headings are. Keyed by the row, so that
   * "is `Pathology` there?" is one lookup and not a scan. */
  function matchUp(found, canonName) {
    const byText = CANON.index[canonName] || CANON.index.standard;
    const seen = new Map();
    for (const s of found) {
      const title = canonicalHeading(s.title, canonName);
      if (!title) continue;
      const rows = byText.get(normaliseHeading(title)) || [];
      const parent = s.parent ? canonicalHeading(s.parent, canonName) : null;
      // Two `Complications` in the canon: the parent picks. Matching neither,
      // it goes on the first and is reported as sitting in the wrong place.
      const row = rows.find((c) => c.p === parent) || rows[0];
      if (!row || seen.has(row.v)) continue;   // repeated: the first one counts
      seen.set(row.v, { el: s.el, written: s.title,
                        misplaced: row.l !== s.level || row.p !== parent });
    }
    return seen;
  }

  /* The required headings this article has not got.
   *
   * Under `Radiographic features` you do not need every modality, you need
   * one: an article with no imaging at all is incomplete however long it is,
   * and an article with a CT section cannot be asked for an MRI by a machine.
   * That is the one synthetic row, and it disappears the moment any modality
   * is there.
   *
   * A profile with no obligations produces nothing at all, and that is
   * Radiopaedia's doing, not a gap here. Of signs it says they are "in general
   * short articles and do not usually require subheadings"; of devices, that
   * the articles "will vary depending on the device". Asking a sign for
   * `Pathology` would be inventing an obligation that does not exist. */
  function whatIsMissing(profileName, found) {
    const profile = CANON.profiles[profileName] || CANON.profiles[CANON.fallback];
    if (!profile || !profile.required.length) return { rows: [], seen: new Map(), profile };

    const canonName = profile.canon;
    const rows = CANON.canons[canonName] || [];
    const seen = matchUp(found, canonName);
    const required = new Set(profile.required);
    const hushed = new Set(hushedHere());
    // Which sections the article HAS, by name, so that an optional subsection
    // can ask whether the section it belongs under is there at all.
    const present = new Set([...seen.keys()].map((v) => v.split('/').pop()));
    const out = [];

    rows.forEach((c, i) => {
      if (seen.has(c.v) || hushed.has(c.v)) return;
      const must = required.has(c.v) || required.has(c.t);
      if (!must && !offerable(c, present, canonName)) return;
      out.push({ entry: c.v, title: c.t, level: c.l, parent: c.p, order: i, required: must });
    });

    if (profile.modality && !hushed.has(CANON.modalityEntry)) {
      const any = (CANON.modalities[canonName] || [])
        .some((m) => seen.has(`Radiographic features/${m}`));
      if (!any) {
        const at = rows.findIndex((c) => c.t === 'Radiographic features');
        out.push({ entry: CANON.modalityEntry, title: CANON.modalityTitle,
                   level: 2, parent: 'Radiographic features', required: true,
                   order: (at < 0 ? rows.length : at) + 0.5, modality: true });
      }
    }

    out.sort((a, b) => a.order - b.order);
    return { rows: out, seen, profile, canonName, jumbled: jumbled(seen, canonName) };
  }

  /* Is this optional heading worth offering at all?
   *
   * Every canon has thirty-odd optional rows and most of them are subsections
   * of sections the article has not got. Offering `Pathology/Immunophenotype`
   * to an article with no `Pathology` is offering the leaf before the branch —
   * so a subsection is only offered once the section it belongs under is
   * there, and top-level rows are always offered.
   *
   * The modalities are the exception, and they have to be: they are all
   * children of `Radiographic features`, so on any article that has that
   * section all nine of them would qualify at once. What Radiopaedia asks for
   * there is one, and that is already its own row. */
  function offerable(row, present, canonName) {
    if (row.p === 'Radiographic features') return false;
    return !row.p || present.has(row.p);
  }

  /* Are the article's sections in the canon's order?
   *
   * `matchUp` walks the page from top to bottom, so its keys are in document
   * order; if the canon's index ever goes backwards along that walk, two
   * sections are the wrong way round. This does not change what is missing —
   * it changes how much the placements below can be trusted, which is why it
   * is said in the header rather than acted on. */
  function jumbled(seen, canonName) {
    const rows = CANON.canons[canonName] || [];
    const at = new Map(rows.map((c, i) => [c.v, i]));
    let last = -1;
    for (const v of seen.keys()) {
      const i = at.get(v);
      if (i == null) continue;
      if (i < last) return true;
      last = i;
    }
    return false;
  }

  /* Where a missing heading belongs on the page: beside the first heading the
   * canon puts AFTER it that the article actually has. Miss `Pathology` and
   * the chip lands next to `Radiographic features`, which is exactly where the
   * section would go. Miss something the article has nothing after — or have
   * no headings at all — and it lands at the end of the text, which is also
   * where it would go.
   *
   * The missing modality is the exception: it belongs under `Radiographic
   * features` itself, not after whatever follows it. */
  function anchorFor(row, seen, canonName) {
    const rows = CANON.canons[canonName] || [];

    /* A SUBSECTION goes beside the section it belongs under, whenever that
       section is there.
       
       What identifies `Complications` is not what comes after it, it is what
       it sits inside: under `Clinical presentation` it is the complication of
       the disease, under `Treatment and prognosis` the complication of the
       treatment. Anchored by the rule below it would land beside `Pathology`,
       which is the next section the canon names and reads as though it
       belonged to it — and `Risk factors` and `Associations`, whose parent is
       `Epidemiology`, would line up against `Clinical presentation`.
       
       The missing modality is this same rule and not a case of its own: its
       parent is `Radiographic features`. */
    if (row.parent) {
      for (const [v, hit] of seen) {
        if (v.split('/').pop() === row.parent) return { el: hit.el, inside: true };
      }
    }

    /* A SECTION goes beside the sections it comes before — and of those, the
       one HIGHEST ON THE PAGE, not the one the canon happens to name first.
       
       The two are the same answer on an article whose sections are in order,
       and they part company on one that is not. Take an article that runs
       `Radiographic features` and then `Clinical presentation`, which is
       backwards, and a missing `Epidemiology`: the canon names Clinical
       presentation first, so reading the order off the canon put the chip
       below Radiographic features — beside the second of the two sections it
       is supposed to come before. Epidemiology goes above BOTH, so the anchor
       has to be whichever of them the reader meets first. */
    let best = null;
    for (let j = Math.ceil(row.order); j < rows.length; j++) {
      const hit = seen.get(rows[j].v);
      if (!hit) continue;
      if (!best) { best = hit; continue; }
      const after = hit.el.compareDocumentPosition(best.el) & Node.DOCUMENT_POSITION_FOLLOWING;
      if (after) best = hit;
    }
    // Nothing after it: the end of the article, which it also goes above.
    return { el: best ? best.el : null, inside: false };
  }

  // ————————————————————————————————————————————— what you have said about it

  /* Three preferences, three lifetimes. The rail is on or off for good, like
   * `auto`. The kind an article is, and the sections you have said it does not
   * need, are per article and kept for good too — a judgement you made once
   * should not have to be made again on the next visit. All of it is keyed on
   * the slug, and none of it ever leaves the browser. */
  function railOn() {
    try {
      const v = localStorage.getItem(RAIL_KEY);
      if (v !== null) return v === '1';
    } catch { /* fall through to the default */ }
    return true;
  }

  function setRailOn(on) {
    try { localStorage.setItem(RAIL_KEY, on ? '1' : '0'); } catch { /* this session only */ }
    paintRailToggle();
    if (on) railSoon();
    else closeRail();
  }

  function readMap(key) {
    try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; }
    catch { return {}; }
  }

  function writeMap(key, map) {
    try { localStorage.setItem(key, JSON.stringify(map)); } catch { /* this session only */ }
  }

  /* The optional headings, shown or not. Off to begin with, and a preference
   * rather than a per-article choice: whether you want Radiopaedia's
   * suggestions alongside its requirements is a way of working, not a fact
   * about one article. */
  function showOptional() {
    try { return localStorage.getItem(OPTIONAL_KEY) === '1'; }
    catch { return false; }
  }

  function setShowOptional(on) {
    try { localStorage.setItem(OPTIONAL_KEY, on ? '1' : '0'); } catch { /* this session only */ }
    railSoon();
  }

  function chosenProfile() {
    const slug = currentSlug();
    return slug ? readMap(PROFILE_KEY)[slug] || null : null;
  }

  function chooseProfile(name) {
    const slug = currentSlug();
    if (!slug) return;
    const map = readMap(PROFILE_KEY);
    if (name) map[slug] = name; else delete map[slug];
    writeMap(PROFILE_KEY, map);
    // A judgement about `Epidemiology` means nothing once you have said the
    // article is an anatomy article, whose canon has no such row.
    const hushes = readMap(HUSHED_KEY);
    delete hushes[slug];
    writeMap(HUSHED_KEY, hushes);
    railSoon();
  }

  function hushedHere() {
    const slug = currentSlug();
    return slug ? readMap(HUSHED_KEY)[slug] || [] : [];
  }

  function hush(entry) {
    const slug = currentSlug();
    if (!slug) return;
    const map = readMap(HUSHED_KEY);
    const list = new Set(map[slug] || []);
    list.add(entry);
    map[slug] = [...list];
    writeMap(HUSHED_KEY, map);
    railSoon();
  }

  function unhushAll() {
    const slug = currentSlug();
    if (!slug) return;
    const map = readMap(HUSHED_KEY);
    delete map[slug];
    writeMap(HUSHED_KEY, map);
    railSoon();
  }

  // ————————————————————————————————————————————————————————————— the rail

  const rail = { layer: null, rows: [], seen: null, canonName: null, profile: null,
                 body: null, title: null, head: null, thread: null, lit: null };

  function closeRail() {
    rail.layer?.remove();
    rail.layer = null;
    rail.rows = [];
    rail.title = null;
    rail.thread = null;
    rail.lit = null;
    removeEventListener('scroll', placeRail, true);
    removeEventListener('resize', placeRail);
  }

  /* Draw once, place on every frame that moves. Same bargain the highlights
   * make: the chips are `position:fixed` and their tops are read off the
   * headings they belong to, so scrolling is a matter of moving them, not of
   * building them again. The article DOM is never touched — a chip that lived
   * inside the text would be one more thing to go wrong on the day somebody
   * opens the editor. */
  /* What the rail would put on screen, given what is missing and what you have
   * said about it — and whether that comes to anything.
   *
   * Out here rather than inside `openRail` because the last line of it is the
   * one that has already been wrong: every control the rail has lives in its
   * header, so a rail that decides not to exist takes them all with it, and
   * the article where that happened was the one where you most wanted them. It
   * is four lines and no DOM, so it can be checked without a browser. */
  function railContent(rows, aside, optionalShown) {
    const optional = rows.filter((r) => !r.required);
    const shown = optionalShown ? rows : rows.filter((r) => r.required);
    return { optional, shown,
             need: rows.length - optional.length,
             worth: !!(shown.length || aside || optional.length) };
  }

  function openRail({ rows, seen, canonName, profile, body, jumbled }) {
    closeRail();

    const aside = hushedHere().length;
    const { optional, shown, need, worth } = railContent(rows, aside, showOptional());

    /* The header stays for as long as there is anything to say, and "there are
     * nineteen optional ones you are not looking at" is something to say.
     *
     * Every control the rail has lives in the header, so a header that leaves
     * takes them with it. Turn the optional ones off on an article that had
     * only optional ones and the rail had nothing to show, so it went — and
     * with it the button that turns them back on, on the one article where
     * that button was the only thing you wanted. The same trap, more quietly,
     * for the sections you have set aside.
     *
     * So: silence only when there is genuinely nothing — nothing required
     * missing, nothing offered, nothing set aside. Which is still the whole of
     * what a sign or a device gets, because Radiopaedia asks nothing of them
     * and so nothing is offered either. */
    if (!worth) return;

    rail.rows = shown;
    rail.seen = seen;
    rail.canonName = canonName;
    rail.profile = profile;
    rail.body = body;
    rail.title = visibleTitle();

    rail.layer = document.createElement('div');
    rail.layer.id = 'rlx-gutter';
    rail.layer.style.setProperty('--rlx-miss', MISS.ink);

    const head = document.createElement('div');
    head.className = 'rlx-rail-head';
    head.innerHTML = `
      <span title="${
        rows.map((r) => (r.required ? '' : '· ') + r.title).join('\n').replace(/"/g, '')
      }" class="rlx-rail-n${need ? '' : ' rlx-rail-none'}">${need}</span>
      <span class="rlx-rail-what">${need
        ? `section${need > 1 ? 's' : ''} missing`
        : (aside ? 'all set aside' : 'nothing required')}</span>
      ${jumbled ? '<span class="rlx-rail-jumbled" title="Some sections are not in the order the canon puts them in, which the linter reports separately. The placements below are approximate on this article.">&#8645;</span>' : ''}
      <button class="rlx-rail-off" title="Hide the structure rail everywhere">&times;</button>
      <span class="rlx-rail-hidden" hidden title="Chips whose heading is off screen. Scroll to them."></span>
      <select class="rlx-rail-kind" title="What kind of article this is. The canon follows from it."></select>
      ${optional.length || showOptional()
        ? `<button class="rlx-rail-more${showOptional() ? ' rlx-on' : ''}">${
             showOptional() ? '\u2212 hide' : '+ show'} ${optional.length} optional</button>`
        : ''}
      ${aside ? `<button class="rlx-rail-undo" title="Bring back the ${aside} you set aside">&#8635; ${aside}</button>` : ''}`;

    const kind = head.querySelector('.rlx-rail-kind');
    for (const [name, p] of Object.entries(CANON.profiles)) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = p.label || name;
      opt.selected = name === profile;
      kind.appendChild(opt);
    }
    kind.addEventListener('change', () => chooseProfile(kind.value));
    head.querySelector('.rlx-rail-off').addEventListener('click', () => setRailOn(false));
    head.querySelector('.rlx-rail-more')?.addEventListener('click', () => setShowOptional(!showOptional()));
    head.querySelector('.rlx-rail-undo')?.addEventListener('click', unhushAll);
    rail.layer.appendChild(head);
    rail.head = head;

    rail.thread = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    rail.thread.id = 'rlx-thread';
    rail.thread.innerHTML = '<path/>';
    rail.layer.appendChild(rail.thread);

    for (const row of shown) {
      const chip = document.createElement('div');
      chip.className = 'rlx-chip';
      if (!row.required) chip.classList.add('rlx-chip-optional');
      if (row.level > 1) chip.classList.add('rlx-chip-sub');
      chip.innerHTML = `
        <span class="rlx-chip-rel"></span>
        <span class="rlx-chip-name"></span>
        <button class="rlx-chip-hush" title="This article does not need it">&times;</button>`;
      chip.querySelector('.rlx-chip-name').textContent = row.title;

      const where = anchorFor(row, seen, canonName);
      row.anchor = where.el;
      row.inside = where.inside;

      const beside = row.anchor ? tidy(row.anchor.textContent) : null;
      const goes = !beside ? 'Goes at the end of the article'
        : (row.inside ? `Goes inside "${beside}"` : `Goes above "${beside}"`);
      chip.querySelector('.rlx-chip-rel').textContent =
        !beside ? '\u2193' : (row.inside ? '\u21b3' : '\u2191');
      chip.title = `${goes}. ${row.modality
        ? 'Radiographic features has no modality under it'
        : `${row.required ? 'Required' : 'Offered'} by the ${canonName} structure: ${row.entry}`
        }. Click to copy the heading.`;

      chip.addEventListener('click', (e) => {
        if (e.target.closest('.rlx-chip-hush')) return hush(row.entry);
        copyHeading(chip, row);
      });
      chip.addEventListener('mouseenter', () => { rail.lit = row; placeRail(); });
      chip.addEventListener('mouseleave', () => {
        if (rail.lit === row) { rail.lit = null; placeRail(); }
      });
      row.el = chip;
      rail.layer.appendChild(chip);
    }

    document.body.appendChild(rail.layer);
    addEventListener('scroll', placeRail, true);
    addEventListener('resize', placeRail);
    placeRail();
  }

  /* The heading, on the clipboard, ready to be pasted into the editor. The
   * modality row has no name to copy — `‹any imaging modality›` is a question,
   * not a heading — so it offers its parent instead. */
  function copyHeading(chip, row) {
    const text = row.modality ? 'Radiographic features' : row.title;
    navigator.clipboard?.writeText(text).then(() => {
      chip.classList.add('rlx-chip-copied');
      setTimeout(() => chip.classList.remove('rlx-chip-copied'), 900);
    }, () => { /* no clipboard: the name is on screen anyway */ });
  }

  let placePending = null;
  function placeRail() {
    if (placePending) return;
    placePending = requestAnimationFrame(() => { placePending = null; layOut(); });
  }

  /* The grey margin to the left of the text, and how much of it there is.
   *
   * Radiopaedia centres a fixed 612px column, so the margin is whatever the
   * window has left over: about 490px at 1920, 250 at 1440, 175 at 1280, and
   * nothing at all once the layout folds to one column. Below `GUTTER_MIN`
   * there is no room for words, and the chips go slim — a coloured tab against
   * the edge of the text, with the heading in its tooltip. Lying about the
   * space by letting the chips overlap the article would be worse than saying
   * less. */
  function layOut() {
    if (!rail.layer || !rail.body?.isConnected) return closeRail();

    const box = rail.body.getBoundingClientRect();
    const room = box.left - GUTTER_GAP - GUTTER_EDGE;
    const slim = room < GUTTER_MIN;
    const width = slim ? 8 : Math.min(CHIP_MAX, room);
    const left = Math.max(GUTTER_EDGE, box.left - GUTTER_GAP - width);

    /* The header sits level with the title, not with the top of the text.
     *
       It is the same object as the Lint button — something about the article
       as a whole — so it belongs on the article's own top line, and putting it
       there is not only tidiness. Every chip is kept below the header, and the
       header standing on the first paragraph pushed the first chips down past
       the section they belong beside: `Terminology` and `Usage` go above
       `Epidemiology`, and an opening paragraph is usually two lines, so there
       was never room. Level with the title there is a title's worth of margin
       above the text, and they land where they mean. */
    const crown = rail.title?.isConnected ? rail.title.getBoundingClientRect() : box;

    rail.layer.classList.toggle('rlx-rail-slim', slim);
    rail.head.style.left = `${left}px`;
    rail.head.style.width = slim ? 'auto' : `${width}px`;
    rail.head.style.top = `${Math.max(8, Math.min(crown.top, innerHeight - 40))}px`;

    /* A chip is beside a heading or it is nowhere.
     *
     * The first version clamped every chip to just under the header, so that
     * scrolling down a long article swept them all into a pile at the top left
     * — twenty headings stacked against a paragraph none of them had anything
     * to do with — and on a short article with the optional ones showing, the
     * stack ran off the bottom of the window and kept going.
     *
     * Both are the same mistake: a margin note whose text has gone is not a
     * margin note any more. The heading scrolled past, the chip goes with it;
     * the stack reaching the bottom of the window, the rest wait their turn. It
     * costs nothing to scroll back, and the header's count still says how many
     * there are altogether. */
    const headBottom = rail.head.getBoundingClientRect().bottom;
    const fold = innerHeight - 8;
    let floor = headBottom + 6;
    let above = 0, below = 0;

    for (const row of rail.rows) {
      const rect = row.anchor?.isConnected ? row.anchor.getBoundingClientRect() : null;
      const target = rect ? rect.top : box.bottom;
      const gone = rect ? rect.bottom < 0 : box.bottom < 0;
      if (gone) { row.el.hidden = true; above++; continue; }

      row.el.hidden = false;
      row.el.style.left = `${left}px`;
      row.el.style.width = slim ? '8px' : `${width}px`;
      row.el.style.top = `${Math.max(floor, target)}px`;

      // Measured where it has been put, not before: the width decides how many
      // lines the heading takes, and that decides where the next one starts.
      const placed = row.el.getBoundingClientRect();
      if (placed.top > fold) { row.el.hidden = true; below++; continue; }
      floor = placed.bottom + 4;
    }

    const hidden = rail.head.querySelector('.rlx-rail-hidden');
    if (hidden) {
      const said = [above ? `${above} above` : '', below ? `${below} below` : '']
        .filter(Boolean).join(', ');
      hidden.textContent = said ? `\u2195 ${said}` : '';
      hidden.hidden = !said;
    }

    drawThread(box);
  }

  /* The elbow from the chip under the pointer to the heading it belongs to.
   *
   * Two straight runs and a corner rather than a diagonal: it has to stay
   * readable crossing a column of other chips, and a slanted line through them
   * is not. It lands on the TOP of the heading for a section — the line the
   * new heading would take — and on its BOTTOM for a subsection, where that
   * section's own text begins. So the thread says the same thing as the glyph
   * on the chip, in the place it is talking about. */
  function drawThread(box) {
    const path = rail.thread?.firstElementChild;
    if (!path) return;

    const row = rail.lit;
    if (!row || row.el.hidden) return void path.removeAttribute('d');

    const chip = row.el.getBoundingClientRect();
    const rect = row.anchor?.isConnected ? row.anchor.getBoundingClientRect() : null;
    const tx = Math.round(box.left - 4);
    const ty = Math.round(rect ? (row.inside ? rect.bottom - 2 : rect.top + 1) : box.bottom);
    const cx = Math.round(chip.right);
    const cy = Math.round(chip.top + chip.height / 2);
    // The corner sits in the corridor rather than halfway to the chip, so the
    // vertical run is always in the same place whatever the window is doing.
    const mx = tx - 8;

    rail.thread.classList.toggle('rlx-thread-offered', !row.required);
    path.setAttribute('d', `M${cx},${cy} H${mx} V${ty} H${tx}`
                         + ` M${tx - 4},${ty - 3} L${tx},${ty} L${tx - 4},${ty + 3}`);
  }

  // ———————————————————————————————————————————————————————— the citations

  /* The other half of a Radiopaedia article, and the half no linter check
   * covers: the reference list at the bottom. A reference is right when it is
   * word for word what the databases say about that paper, numbered in the
   * order it appears — and there is a tool that knows, `radiopaedia.work/cite`,
   * which takes a reference and gives back the canonical form of it.
   *
   * So: a `Lint citation` chip beside every reference in the editor, and one
   * press asks that tool about that one reference. What comes back is a
   * verdict — matches, differs, nothing to look up — and, when it differs, the
   * two forms side by side with the words that changed lit up, and the
   * corrected line on the clipboard. Nothing is ever written into the editor:
   * you paste it yourself, which is also the last chance to disagree.
   */

  /* A reference, on the edit page, is a `<textarea>`. The form keeps one per
   * reference, holding the citation as source — the number, the text, and the
   * `<a>` tags spelled out rather than rendered — with Radiopaedia's own
   * "Format citation" link underneath it.
   *
   * That link is what marks a box as a reference box, and it is where the chip
   * goes: beside it, because it is already where a person looks for something
   * to press about this citation. Behind it, for the day it is renamed or
   * moved, the shape of the value answers instead — a box whose text opens
   * with its own number and carries a DOI, a PMID, an ISBN. A renamed link
   * costs the placement then, not the feature.
   *
   * This is also why nothing is drawn in a layer here, unlike the highlights
   * and the rail: the chip is a button in the form around the editor, not a
   * mark on the article. The form is not what gets saved. */
  const CITE_NUM = /^(\d{1,3})\s*[.)]\s+(?=\S)/;
  const CITE_SIGNS =
    /(?:\bdoi[:.]|10\.\d{4,9}\/|pubmed|ncbi\.nlm\.nih\.gov|\bisbn\b|books\.google|\b(?:19|20)\d{2}[;:(]|\((?:19|20)\d{2}\))/i;
  const FORMAT_LINK = 'format citation';

  function referenceFields() {
    const anchors = new Map();          // the box → the link to stand beside
    for (const link of document.querySelectorAll('a, button')) {
      if (tidy(link.textContent).toLowerCase() !== FORMAT_LINK) continue;
      const input = fieldFor(link);
      if (input && !anchors.has(input)) anchors.set(input, link);
    }

    /* Walked in document order rather than link order, because `pos` is the
     * whole point of one of the verdicts: a reference's number is right when
     * it is the number of its place in the list, and the list is the page. */
    const rows = [];
    for (const input of document.querySelectorAll('textarea')) {
      const text = tidy(input.value);
      const numbered = CITE_NUM.exec(text);
      const known = anchors.has(input);
      if (text.length < 12) continue;   // an empty box is a reference nobody has written yet
      if (!known && (text.length < 24 || !numbered || !CITE_SIGNS.test(text))) continue;
      rows.push({ input, after: anchors.get(input) || input,
                  typed: !!numbered, n: numbered ? +numbered[1] : null,
                  pos: rows.length + 1 });
    }
    return rows;
  }

  /* The box a link belongs to: the nearest ancestor holding a textarea, within
   * a few steps. Not `previousElementSibling` — the link sits under the box on
   * screen, and whatever markup lies between them is Radiopaedia's business
   * and not something to depend on. */
  function fieldFor(link) {
    let node = link;
    for (let up = 0; up < 4 && node; up++) {
      node = node.parentElement;
      const input = node?.querySelector('textarea');
      if (input) return input;
    }
    return null;
  }

  /* The number and the text as they are NOW. Typing in a textarea changes no
   * DOM and fires no mutation, so a row built when the page settled would
   * still be describing what the reference said then. */
  function refresh(row) {
    const numbered = CITE_NUM.exec(tidy(row.input.value));
    row.typed = !!numbered;
    row.n = numbered ? +numbered[1] : null;
    return row;
  }

  /* What gets sent: the box, as it stands, whole.
   *
   * Which is markup, and that is not a detail. The tool works out for itself
   * what to look up in a reference — but WHICH identifier it finds decides
   * which database answers, and they do not word things the same way. The
   * GenBank reference sent with its Pubmed link comes back from PubMed as
   * "Nucleic Acids Res. 2013;41(Database issue)" and matches; the same
   * reference stripped to plain text is resolved through its DOI instead and
   * comes back from Crossref as "Nucleic Acids Research. 2012;41(D1)", which
   * does not. The form holds the source, links and all, so this is one read. */
  const citeMarkup = (row) => fold(row.input.value);

  /* Livewire keeps a component's state in a `wire:snapshot` attribute, as
   * JSON, and the page `?search=…` renders already has the answer in it.
   *
   * `DOMParser` rather than a regular expression over the HTML: the document
   * it builds is inert — nothing in there runs, loads or fetches — and it
   * unescapes the attribute for us, which done by hand is exactly where this
   * would quietly break.
   *
   * Four fields are taken and the rest ignored: `citation`, the canonical
   * form; `error`, what it says when it could not resolve anything; and, off
   * the result it worked out, `match` and `index`. Livewire tags its arrays as
   * it serialises them — `[value, {"s":"arr"}]` — so the result is searched
   * for the first object carrying a verdict rather than reached at down a
   * fixed path that a version bump would move. */
  function citeState(html) {
    let node;
    try {
      node = new DOMParser().parseFromString(html, 'text/html')
        .querySelector('[wire\\:snapshot]');
    } catch { return null; }
    if (!node) return null;
    let snap;
    try { snap = JSON.parse(node.getAttribute('wire:snapshot')); } catch { return null; }
    const data = snap && typeof snap === 'object' ? snap.data : null;
    if (!data || typeof data !== 'object') return null;
    const item = deepFind(data.result, 'match') || {};
    return {
      citation: typeof data.citation === 'string' ? data.citation : null,
      error: typeof data.error === 'string' ? data.error : null,
      match: item.match === true,
      index: item.index == null ? null : String(item.index),
    };
  }

  /* The first object in there that has this key, however deep it was buried. */
  function deepFind(node, key, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 6) return null;
    if (!Array.isArray(node) && Object.prototype.hasOwnProperty.call(node, key)) return node;
    for (const v of Array.isArray(node) ? node : Object.values(node)) {
      const hit = deepFind(v, key, depth + 1);
      if (hit) return hit;
    }
    return null;
  }

  /* One request, one reference, one press. `@connect radiopaedia.work` already
   * covers it: this is the same host the linter answers from, and this is a
   * GET — the one POST in the file is the ↻, and it is up in `postForce`. */
  function askCite(search) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: CITE_URL + encodeURIComponent(search),
        timeout: CITE_TIMEOUT,
        onload: (r) => {
          const body = r.responseText || '';
          if (CHALLENGE.some((m) => body.includes(m))) {
            return reject(new Error(
              'Cloudflare bot check. Open radiopaedia.work in a tab, clear the check, ' +
              'then try again.'));
          }
          if (r.status >= 400) return reject(new Error(`The citation tool answered ${r.status}.`));
          if (body.length > CITE_MAX) return reject(new Error('That answer was not a page.'));
          const said = citeState(body);
          if (!said) {
            return reject(new Error(
              'The citation tool answered with a page this script could not read. ' +
              'Open it in a tab and check by hand.'));
          }
          resolve(said);
        },
        onerror: () => reject(new Error('The citation tool could not be reached.')),
        ontimeout: () => reject(new Error('The citation tool took too long to answer.')),
      });
    });
  }

  /* Kept for the tab, under a short key made from what was asked. The worker
   * caches behind the same URL — there is a "force regenerate" on its own page
   * for when that is wrong — but this saves the round trip when you press the
   * same chip twice, which is what happens the moment you go back to compare
   * once more. */
  function citeCached(search) {
    try {
      const raw = sessionStorage.getItem(CITE_KEY + shortHash(search));
      const said = raw ? JSON.parse(raw) : null;
      return said && typeof said === 'object' ? said : null;
    } catch { return null; }
  }

  function rememberCite(search, said) {
    try { sessionStorage.setItem(CITE_KEY + shortHash(search), JSON.stringify(said)); }
    catch { /* quota: never mind, it is one more request */ }
  }

  // Not a checksum: a short, stable key for a long string.
  function shortHash(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36);
  }

  /* What to say about one reference.
   *
   * Three things can be wrong and they are not the same thing: nothing in it
   * could be looked up, the words differ from what the database says, or the
   * words are right and the NUMBER in front of them is not the one this
   * reference is. The last is worth its own verdict — a list that runs
   * 1, 2, 2, 4 sends every citation marker in the article to the wrong paper,
   * and it is the one thing here that can be told without asking anybody. */
  function citeVerdict(row, said) {
    const misnumbered = row.typed && row.n != null && row.pos != null && row.n !== row.pos;
    if (said.error || !said.citation) {
      return { state: 'unknown', head: 'Nothing to look up',
               why: said.error
                 ? tidy(said.error)
                 : 'The tool found no DOI, PMID, ISBN or URL in this reference.' };
    }
    if (said.match) {
      return misnumbered
        ? { state: 'differs', head: `Numbered ${row.n}, and it is the ${ordinal(row.pos)}`,
            why: 'The reference itself is right; the number in front of it is not.' }
        : { state: 'match', head: 'Matches',
            why: 'Word for word what the citation tool returns for it.' };
    }
    return { state: 'differs', head: misnumbered ? `Differs, and numbered ${row.n}` : 'Differs',
             why: misnumbered
               ? `The tool returns this instead — and this is the ${ordinal(row.pos)} reference.`
               : 'The tool returns this instead.' };
  }

  const ordinal = (n) => {
    const tens = n % 100, ones = n % 10;
    const suffix = tens >= 11 && tens <= 13 ? 'th'
      : ones === 1 ? 'st' : ones === 2 ? 'nd' : ones === 3 ? 'rd' : 'th';
    return `${n}${suffix}`;
  };

  /* The words that changed, not the paragraphs that contain them.
   *
   * A reference is eighty words long and what is wrong with it is usually one
   * of them — a journal abbreviated where it should be spelled out, a year off
   * by one, three authors where the style wants "et al". Printing both forms
   * and leaving the reader to find the difference is printing the problem
   * twice; this is the longest common subsequence of the two word lists, which
   * turns them into runs of "same", "was" and "now".
   *
   * Quadratic, and capped for it: at 400 words a side the table is 160k cells
   * and still under a millisecond, and a reference that long is not one. */
  function wordDiff(before, after) {
    const A = before.split(' '), B = after.split(' ');
    const m = A.length, n = B.length;
    if (!m || !n || m > 400 || n > 400) return null;

    const L = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
      }
    }

    const runs = [];
    const add = (kind, word) => {
      const last = runs[runs.length - 1];
      if (last && last.kind === kind) last.words.push(word);
      else runs.push({ kind, words: [word] });
    };
    let i = 0, j = 0;
    while (i < m && j < n) {
      if (A[i] === B[j]) { add('same', A[i]); i++; j++; }
      else if (L[i + 1][j] >= L[i][j + 1]) add('was', A[i++]);
      else add('now', B[j++]);
    }
    while (i < m) add('was', A[i++]);
    while (j < n) add('now', B[j++]);
    return runs;
  }

  /* One of the two sides of the comparison, built out of the runs: the article
   * shows what it has with the words that go highlighted, the tool shows what
   * it says with the words that arrive highlighted. Text nodes and `<span>`s,
   * never `innerHTML` — what is being displayed here came off somebody else's
   * page. */
  function diffLine(runs, keep, mark, fallback) {
    const line = document.createElement('div');
    line.className = 'rlx-cite-text';
    if (!runs) { line.textContent = fallback; return line; }
    for (const run of runs) {
      if (run.kind !== 'same' && run.kind !== keep) continue;
      const text = run.words.join(' ') + ' ';
      if (run.kind === 'same') { line.appendChild(document.createTextNode(text)); continue; }
      const hit = document.createElement('span');
      hit.className = mark;
      hit.textContent = text;
      line.appendChild(hit);
    }
    if (!line.childNodes.length) line.textContent = fallback;
    return line;
  }

  // ————————————————————————————————————————— the chips and their answer

  const cites = { rows: [], note: null, open: null, watch: null, settle: null };

  const citesOn = () => localStorage.getItem(CITES_KEY) !== '0';
  function setCitesOn(on) {
    try { localStorage.setItem(CITES_KEY, on ? '1' : '0'); } catch { /* this session only */ }
    paintCitesToggle();
    if (on) citesSoon(); else closeCites();
  }

  function paintCitesToggle() {
    citesToggle?.classList.toggle('rlx-on', citesOn());
  }

  /* The form is not there when the page is. Polled for its first sighting
   * rather than observed, on the same clock the findings wait on: a page that
   * never grows a reference box costs one poll every 400ms for half a minute
   * and then stops. */
  function awaitReferences() {
    return new Promise((resolve) => {
      const deadline = Date.now() + EDITOR_TIMEOUT;
      (function poll() {
        const rows = referenceFields();
        if (rows.length || Date.now() > deadline) return resolve(rows);
        setTimeout(poll, 400);
      })();
    });
  }

  let citesRun = 0;
  async function citesSoon() {
    if (!inEditor() || !citesOn()) return closeCites();
    const run = ++citesRun;
    const rows = await awaitReferences();
    if (run !== citesRun || !citesOn() || !rows.length) return;
    openCites(rows);
  }

  function openCites(rows) {
    closeCites();
    if (!rows.length) return;
    cites.rows = rows;

    for (const row of rows) {
      const chip = document.createElement('button');
      chip.type = 'button';               // inside somebody else's form: never a submit
      chip.className = 'rlx-cite';
      chip.textContent = 'Lint citation';
      chip.title = 'Check this reference against radiopaedia.work/cite' +
        (row.typed ? ` (it is the ${ordinal(row.pos)} in the list)` : '');
      chip.addEventListener('click', (e) => { e.preventDefault(); lintCitation(row); });
      row.chip = chip;
      row.after.insertAdjacentElement('afterend', chip);

      // Answered before, in this tab: it comes back answered, at no cost.
      const said = citeCached(citeMarkup(row));
      if (said) setChip(row, citeVerdict(refresh(row), said).state);
    }

    /* References come and go while you work — one added, one removed — and
     * chips left behind would point at boxes that are gone. The page is
     * watched for it, well after the change has settled, and only the shape of
     * the list is compared: typing inside a box changes no DOM and needs no
     * rebuild, which is the whole reason `refresh()` exists. */
    cites.watch = new MutationObserver(() => {
      clearTimeout(cites.settle);
      cites.settle = setTimeout(() => {
        if (!cites.rows.length) return;
        const now = referenceFields();
        const same = now.length === cites.rows.length &&
                     now.every((r, i) => r.input === cites.rows[i].input);
        if (!same) openCites(now);
      }, 1200);
    });
    cites.watch.observe(document.body, { childList: true, subtree: true });
  }

  function closeCites() {
    closeCiteNote();
    cites.watch?.disconnect();
    cites.watch = null;
    clearTimeout(cites.settle);
    for (const row of cites.rows) row.chip?.remove();
    cites.rows = [];
  }

  const CHIP_WORD = { asking: 'Lint citation', match: '✓ citation',
                      differs: '≠ citation', unknown: '? citation' };

  function setChip(row, state) {
    const chip = row.chip;
    if (!chip) return;
    for (const k of ['asking', 'match', 'differs', 'unknown']) {
      chip.classList.toggle(`rlx-cite-${k}`, k === state);
    }
    chip.textContent = CHIP_WORD[state] || 'Lint citation';
    chip.disabled = state === 'asking';
  }

  /* The press. The reference goes to the clipboard on the way out — the tool
   * is one tab away and sometimes what you want is to look at it yourself —
   * and then one question is asked about it. */
  async function lintCitation(row) {
    refresh(row);
    const search = citeMarkup(row);
    if (!search) return;
    navigator.clipboard?.writeText(search).catch(() => { /* the chip still works */ });

    const cached = citeCached(search);
    if (cached) return void showCite(row, cached, search);

    setChip(row, 'asking');
    showCiteNote(row, { state: 'asking', head: 'Asking…',
                        why: 'radiopaedia.work is looking this reference up.' }, null, search);
    try {
      const said = await askCite(search);
      rememberCite(search, said);
      showCite(row, said, search);
    } catch (err) {
      setChip(row, 'unknown');
      showCiteNote(row, { state: 'unknown', head: 'Could not ask', why: err.message },
                   null, search);
    }
  }

  function showCite(row, said, search) {
    const verdict = citeVerdict(row, said);
    setChip(row, verdict.state);
    showCiteNote(row, verdict, said, search);
  }

  /* The answer, beside the chip that asked for it. Built node by node: the
   * canonical citation came off another site's page, and the one place it is
   * ever allowed to be is inside a text node. */
  function showCiteNote(row, verdict, said, search) {
    closeCiteNote();

    const note = document.createElement('div');
    note.id = 'rlx-cite-note';
    note.style.borderLeftColor =
      verdict.state === 'match' ? '#059669'
        : verdict.state === 'differs' ? '#b45309' : '#6b7280';

    const head = document.createElement('div');
    head.className = 'rlx-cite-head';
    const what = document.createElement('strong');
    what.textContent = verdict.head;
    const where = document.createElement('span');
    where.textContent = `reference ${row.pos}`;
    head.append(what, where);

    const why = document.createElement('div');
    why.className = 'rlx-cite-why';
    why.textContent = verdict.why;
    note.append(head, why);

    // The comparison, on the two occasions there is one to make.
    if (said?.citation && verdict.state !== 'match') {
      // Read off the editor now, not off the scan: you may have edited the
      // reference between the chip being drawn and the chip being pressed.
      const mine = fold(plain(row.input.value).replace(CITE_NUM, ''));
      const theirs = fold(plain(said.citation));
      const runs = wordDiff(mine, theirs);

      const a = document.createElement('div');
      a.className = 'rlx-cite-label';
      a.textContent = 'in the article';
      const b = document.createElement('div');
      b.className = 'rlx-cite-label';
      b.textContent = 'radiopaedia.work/cite';
      note.append(a, diffLine(runs, 'was', 'rlx-was', mine),
                  b, diffLine(runs, 'now', 'rlx-now', theirs));
    }

    const acts = document.createElement('div');
    acts.className = 'rlx-cite-acts';

    if (said?.citation) {
      const copy = document.createElement('button');
      copy.textContent = row.typed ? `Copy as ${row.pos}.` : 'Copy citation';
      copy.title = row.typed
        ? 'The corrected reference on the clipboard exactly as the box holds it — tags and ' +
          'all — numbered by where it stands. Paste it over the old one yourself.'
        : 'The corrected reference on the clipboard exactly as the box holds it, tags and all. ' +
          'It carries no number, so none is added. Paste it over the old one yourself.';
      copy.addEventListener('click', () => copyCitation(copy, row, said));
      acts.appendChild(copy);
    }

    const open = document.createElement('button');
    open.textContent = 'Open in cite';
    open.title = 'The same question, in the tool’s own page';
    open.addEventListener('click', () => {
      window.open(CITE_URL + encodeURIComponent(search), '_blank', 'noopener');
    });

    const shut = document.createElement('button');
    shut.textContent = 'Close';
    shut.addEventListener('click', closeCiteNote);
    acts.append(open, shut);
    note.appendChild(acts);

    document.body.appendChild(note);
    cites.note = note;
    cites.open = row;
    placeCiteNote();
    document.addEventListener('keydown', onCiteKey, true);
    addEventListener('scroll', placeCiteNote, true);
    addEventListener('resize', placeCiteNote);
  }

  /* Under the chip, and inside the window: a note pushed off the bottom edge
   * is a note nobody reads. */
  function placeCiteNote() {
    const note = cites.note, row = cites.open;
    if (!note || !row?.chip?.isConnected) return closeCiteNote();
    const c = row.chip.getBoundingClientRect();
    const box = note.getBoundingClientRect();
    const left = Math.max(6, Math.min(c.left, innerWidth - box.width - 6));
    const below = c.bottom + 6;
    const top = below + box.height < innerHeight - 6
      ? below
      : Math.max(6, c.top - box.height - 6);
    note.style.left = `${Math.round(left)}px`;
    note.style.top = `${Math.round(top)}px`;
  }

  function closeCiteNote() {
    cites.note?.remove();
    cites.note = null;
    cites.open = null;
    document.removeEventListener('keydown', onCiteKey, true);
    removeEventListener('scroll', placeCiteNote, true);
    removeEventListener('resize', placeCiteNote);
  }

  function onCiteKey(e) {
    if (e.key === 'Escape' && cites.note) { e.preventDefault(); closeCiteNote(); }
  }

  /* The corrected reference on the clipboard, as source and nothing else.
   *
   * What it is being pasted into decides this. The box is a `<textarea>` that
   * holds the citation the way it is stored — `<a href="…">doi:…</a>` spelled
   * out, tags and all — so the thing to hand over is exactly the string the
   * tool returned. Offering it as `text/html` too would be worse than useless
   * here: a textarea takes the plain flavour of whatever is on the clipboard,
   * and a "plain flavour" with the tags taken out is a reference with its
   * links deleted, pasted by somebody who had every reason to think they were
   * pasting the right thing.
   *
   * The number is the one it ought to have — where it stands in the list —
   * and only where the reference carries one at all.
   *
   * Writing it into the box ourselves would be the obvious next step and it is
   * not taken: this script has never put a character inside the editor, and a
   * citation is not the place to start. */
  function copyCitation(button, row, said) {
    const text = (row.typed ? `${row.pos}. ` : '') + said.citation;
    navigator.clipboard?.writeText(text).then(() => {
      const was = button.textContent;
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = was; }, 900);
    }, () => { /* no clipboard: the citation is on screen anyway */ });
  }

  // ————————————————————————————————————————————————————————————— wiring

  /* The rail waits for the linter, and asks it for nothing.
   *
   * `article_type` arrives inside the lint answer, which is already cached for
   * the session — so the rail costs no request of its own, and it appears when
   * a lint answer for this article exists: on load with `auto` on, on the
   * click without it. Drawing it any earlier would mean guessing the kind of
   * article from the title alone, and the title alone cannot tell an anatomy
   * article from a disease. Six wrong chips are worse than none. */
  let lastArticleType;
  let railRun = 0;
  async function railSoon(articleType) {
    if (!railOn() || inEditor() || !currentSlug()) return closeRail();
    if (articleType !== undefined) lastArticleType = articleType;
    if (lastArticleType === undefined) return;

    const run = ++railRun;
    if (!await canon()) return;          // unreadable file: say nothing
    if (run !== railRun) return;         // overtaken while fetching

    const page = sectionsOnPage();
    if (!page) return closeRail();

    const name = profileFor(articleTitle(), lastArticleType);
    const measured = whatIsMissing(name, page.found);
    openRail({ ...measured, profile: name, body: page.body,
               canonName: measured.canonName || CANON.profiles[name]?.canon });
  }

  function paintRailToggle() {
    railToggle?.classList.toggle('rlx-on', railOn());
  }

  // ——————————————————————————————————————————————————————————— startup

  function setButtonState(label, busy) {
    if (!button) return;
    button.textContent = label;
    button.disabled = !!busy;
  }

  /* Only the last article is kept. This is here so that reloading the edit
   * page does not ask the linter a second time, not to build an archive — and
   * the answer is now tens of kB rather than hundreds, which makes it a
   * comfortable fit in `sessionStorage` rather than a tight one. */
  function remember(slug, json) {
    for (const k of Object.keys(sessionStorage)) {
      if (k.startsWith(CACHE_KEY) && k !== CACHE_KEY + slug) sessionStorage.removeItem(k);
    }
    try { sessionStorage.setItem(CACHE_KEY + slug, json); } catch { /* quota: never mind */ }
  }

  /* The cache first, the API only if it has to. Both the preflight on the
   * article page and the lint on the edit page come through here, which is
   * what keeps a click at one request: the article page asks, the edit page
   * finds the answer already sitting in `sessionStorage`. */
  async function lintResult(slug, { force } = {}) {
    const cached = force ? null : sessionStorage.getItem(CACHE_KEY + slug);
    if (cached) {
      try { return JSON.parse(cached); } catch { sessionStorage.removeItem(CACHE_KEY + slug); }
    }
    const data = await askLinter(slug);
    remember(slug, JSON.stringify(data));
    return data;
  }

  /* The findings, with the names list read alongside them. Two requests to
   * two hosts, asked at once because neither waits on the other, and the list
   * is the smaller of the two by an order of magnitude.
   *
   * Everything downstream — the colour of the button, the all-clear banner,
   * the walk through the stage — goes through here, so a name in the file is
   * hidden in all three or in none. That is the point of putting it this far
   * up: a button that counts a finding the stage refuses to show is a button
   * that lies. */
  async function findingsFor(slug, opts = {}) {
    const [data] = await Promise.all([lintResult(slug, opts), lists(opts)]);
    // The kind of article travels in the lint answer, so the rail rides along
    // on a request that was going to be made anyway. Not awaited: the findings
    // are what the caller is waiting for.
    railSoon(data.article_type ?? null);
    return fromApi(data);
  }

  /* The ones there is something to do about. A word one of the lists knows is
   * not one of them: the linter is right that the item starts with a capital,
   * right that the acronym is nowhere spelled out, and right that it cannot
   * tell which of those are names and which acronyms every reader already
   * reads — these files can, and the answer is "that one is fine". */
  const actionable = (findings) => findings.filter((f) => !f.known);

  /* Zero findings is now simply zero findings. Reading the linter's HTML page,
   * an empty result and a parser that had stopped working looked exactly the
   * same, and the doubt had to be written into the code; `askLinter` refuses
   * anything that is not a lint result, so an empty `lints[]` that gets this
   * far is an article with nothing wrong with it. */
  const ALL_CLEAR = 'Nothing to lint.';

  /* "No issues" is not quite true when the only findings were words sitting in
   * `proper-nouns.txt` or `acronyms.txt`, and the difference is worth a
   * clause: the linter did say something, and what became of it is not a
   * mystery. */
  const allClearSub = (slug, tally = {}) => {
    const said = knownSaid(tally);
    return `The linter found no issues in "${slug}".` +
           (said.length ? ` (Set aside: ${said.join(', ')}.)` : '');
  };

  /* Outside the editor the linter is asked *before* navigating. An article
   * with nothing wrong with it used to cost you the trip to the edit page and
   * the trip back; now it costs a sentence. The answer is kept either way, so
   * this is not an extra request — it is the same one, made earlier. */
  async function preflight(slug) {
    if (!slug) return;
    hideBanner();
    setButtonState('Lint…', true);
    try {
      const all = await findingsFor(slug);
      const findings = actionable(all);
      if (!findings.length) {
        showBanner(ALL_CLEAR, allClearSub(slug, knownTally(all)));
        return;
      }
      // Go to the editor and let the lint start there — this way navigation
      // cannot abort anything halfway.
      sessionStorage.setItem(PENDING_KEY, slug);
      location.href = `https://radiopaedia.org/articles/${encodeURIComponent(slug)}/edit`;
    } catch (err) {
      alert(`Lint failed.\n\n${err.message}`);
    } finally {
      setButtonState('Lint', false);
    }
  }

  async function runLint(slug, { force } = {}) {
    if (!slug) return;
    stage.slug = slug;
    hideBanner();
    setButtonState('Lint…', true);
    try {
      const all = await findingsFor(slug, { force });
      const findings = actionable(all).map((f) => ({ ...f, state: 'open', range: null, frame: null }));
      const hidden = knownTally(all);

      // Also the answer to "Re-lint" on an article you have just finished
      // fixing: no stage, one sentence.
      if (!findings.length) {
        destroyStage();
        showBanner(ALL_CLEAR, allClearSub(slug, hidden));
        return;
      }

      const roots = await awaitEditor();
      if (!roots.length) {
        alert('Cannot find the editor text: open the edit page and try again.');
        return;
      }
      destroyStage();
      stage.roots = roots;
      stage.findings = findings;
      stage.hidden = hidden;
      anchor(stage.findings, stage.roots);
      createStage();
      listenToFrames();
      stage.i = -1;
      step(1);
    } catch (err) {
      alert(`Lint failed.\n\n${err.message}`);
    } finally {
      setButtonState('Lint', false);
    }
  }

  // ——————————————————————————————————————————————————————— bootstrap

  mountButton();
  // Radiopaedia remounts parts of the page on its own: the button has to be
  // put back whenever it disappears.
  new MutationObserver(() => mountButton())
    .observe(document.body, { childList: true, subtree: true });

  /* One line in the console at startup. If the button is nowhere to be seen,
   * this is the first thing to look at: no line means the problem is not where
   * the button gets put — it is that the script is not running at all.
   *
   * `@match` takes the whole site rather than just `/articles/*`: running on a
   * page with nothing to do costs a couple of microseconds, while a `@match`
   * that misses by a hair costs an afternoon of wondering where the button
   * went. What decides where to mount it is `currentSlug()`. */
  console.info('[Radiopaedia Lint] active ·', location.pathname,
               '· slug:', currentSlug(),
               '· mode:', auto() ? 'automatic' : 'manual',
               '· button:', group
                 ? (group.classList.contains('rlx-btn-float')
                     ? 'floating, top right' : 'next to the title')
                 : (currentSlug() ? 'NOT MOUNTED' : 'not needed here'),
               button ? button.getBoundingClientRect() : '');

  // The chips do not wait for the linter: they are about the references, and
  // the references are on the page whether anybody pressed Lint or not.
  citesSoon();

  if (inEditor()) {
    const pending = sessionStorage.getItem(PENDING_KEY);
    if (pending && pending === currentSlug()) {
      sessionStorage.removeItem(PENDING_KEY);
      runLint(pending, {});
    }
  }

  /* The article page and nothing else: `/articles/<slug>` exactly, so the
   * revisions, the cases and the editor do not each cost their own lint run.
   * In the editor the click does the asking, as it always did. */
  const onArticlePage = () => /^\/articles\/[^/?#]+\/?$/.test(location.pathname);

  function previewSoon() {
    const slug = currentSlug();
    if (!slug || !onArticlePage() || inEditor()) return;
    /* Two ways of being looked at, and either will do. A page can hold the
     * focus while `visibilityState` says otherwise — that is also what makes
     * the switch work: clicking it IS somebody looking, and waiting for an
     * event that has already happened would leave the button uncoloured until
     * the next reload. */
    if (document.visibilityState === 'visible' || document.hasFocus()) return void preview(slug);

    /* Neither: a tab you cannot see may be one the browser opened on a guess
     * and you will never look at — cmd-clicking a dozen links opens a dozen of
     * them. Asking would be a request to Radiopaedia for an article nobody is
     * reading, so it waits until somebody is. */
    const wake = () => {
      if (document.visibilityState !== 'visible' && !document.hasFocus()) return;
      document.removeEventListener('visibilitychange', wake);
      removeEventListener('focus', wake);
      const slugNow = currentSlug();
      if (slugNow && onArticlePage() && !inEditor()) preview(slugNow);
    };
    document.addEventListener('visibilitychange', wake);
    addEventListener('focus', wake);
  }

  if (auto()) previewSoon();
})();
