// ==UserScript==
// @name         Radiopaedia Lint
// @namespace    https://radiopaedia.work/
// @homepageURL  https://github.com/gmadevs/radiopaedia-lint-userscript
// @supportURL   https://github.com/gmadevs/radiopaedia-lint-userscript/issues
// @downloadURL  https://raw.githubusercontent.com/gmadevs/radiopaedia-lint-userscript/main/radiopaedia-lint.user.js
// @updateURL    https://raw.githubusercontent.com/gmadevs/radiopaedia-lint-userscript/main/radiopaedia-lint.user.js
// @license      MIT
// @version      3.21.0
// @description  A Lint button next to the article title, coloured by what the radiopaedia.work linter found: red for errors, amber for warnings, blue for suggestions, grey for nothing to fix. Click it and the findings light up on the text in the editor, one at a time. In the margin, the sections this kind of article should have and has not got. Beside any heading whose newest citation is more than five years old, a chip with the year. And beside every reference, a Lint citation chip: it checks that one against radiopaedia.work/cite and shows, word by word, what differs. One more button asks the Retraction Watch index and PubMed whether any of the references has since been retracted. Where a finding has one right answer — a missing Oxford comma, a hyphen that should not be there, italics on a word that should not have them, an acronym the shared file knows the expansion of, and where it knows two it asks which — a Fix button writes it into the editor, the smallest change that does it and nothing else — and pointing at it shows the words that would go and the words that would arrive, lit red and green. Five checks ask for the sentence to be written again instead, and on those a Prompt button puts the question on the clipboard — the paragraph with its links and references replaced by markers, the check, and what a Radiopaedia sentence has to hold on to — for you to take wherever you like, and a box to paste the answer back into, which puts the markup where the markers came back. A link button lists the words in the text that are the title of another Radiopaedia article and are not linked to it anywhere, and links the first occurrence of one when you press Link. And where a rule is simply wrong on the case in front of you, a Log button writes down which rule, which words and why, so that a month of those can go to the editorial team as one document.
// @match        https://radiopaedia.org/*
// @connect      radiopaedia.work
// @connect      raw.githubusercontent.com
// @connect      eutils.ncbi.nlm.nih.gov
// @connect      127.0.0.1
// @connect      localhost
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
 * The highlight never touches the editor DOM. No `<mark>` wrapped around the
 * text: those would end up inside the article the first time you save. It is a
 * layer of rectangles laid over the page, drawn from the `getClientRects()` of
 * the Ranges and redrawn on every scroll — the content stays exactly as it was.
 *
 * `f` is the one thing in this script that does write to the editor, and it is
 * described further down. Everything else here — the highlights, the rail, the
 * citation chips, the retraction sweep — only ever reads.
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
 * `acronym-expansions.txt` is a third file and the opposite of the second:
 * `acronyms.txt` holds the ones that need no spelling out, and that one holds
 * what the letters stand for, for the ones that do. What goes in it is a fact
 * about medicine that will be written into somebody's article word for word.
 *
 * An acronym that means two things gets two lines — `RV = right ventricle`
 * and `RV = residual volume` — and `f` asks which before it writes anything.
 * Nothing is guessed from the article, because the thing that would have to
 * be read to guess is the sentence. `e` is how a meaning is proposed, the
 * same gesture as `p` next to it and the other answer to the same finding.
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
 * The third is the Log button, which is about the rules themselves rather than
 * about one word. Where a finding is the rule meeting a case it was not
 * written for, pressing it records the rule, the article, the line, the words
 * and why it does not hold there; Copy Markdown gives the lot back grouped by
 * rule, which is the shape an argument for changing one has to be in. Nothing
 * is sent from there either — see `the disagreement log`, further down.
 *
 * Twenty-five of the checks have one right answer rather than a judgement to
 * make. Twenty-one are about the words — the Oxford comma, the two hyphen rules,
 * a list item's capital, an e.g. list ending in 'and', the Latin forms, the
 * isotope notation, a comma inside a quotation mark, two references written as
 * a range, a full stop on a list item, a possessive eponym, a range with
 * 'between' in front of it, a missing space after a full stop, an en-dash, and
 * a bracketed e.g., and an acronym `acronym-expansions.txt` knows the
 * expansion of — and on those `f` writes the SMALLEST edit that does it,
 * the comma or the hyphen or the one letter, never the phrase, so a link
 * inside the phrase is not selected and not touched. A change that would cross
 * a tag is refused rather than flattened; where a rule really does need two
 * changes at either end of a phrase, they are made as two, in two text nodes
 * that cannot disturb each other.
 *
 * One more puts a space in front of a reference marker, which is a place
 * rather than a change to any word.
 *
 * Nothing is written that would empty a tag: `<a>PSMA</a>` with the whole of
 * PSMA replaced is, to the browser, a link whose contents have all been
 * deleted, and it takes the link out with them. Changing PART of a tag's text
 * is what nearly every rule does and is always allowed.
 *
 * Three are about the markup: italics and bold taken off a word, and the colon
 * of a bold intro moved outside it. Those have no corrected string to show —
 * `<em>TERT</em>` reads the same either way — so the note describes them, and
 * they go in through `bold` and `italic`. Those commands TOGGLE, which is the
 * whole difficulty: the selection has to be exactly the formatted run, or a
 * phrase that is half italic comes out all italic.
 *
 * All of it is written with the editor's own commands rather than by touching
 * the DOM, so TinyMCE marks the form dirty and Ctrl + Z takes it back. What is
 * proposed is read off the EDITOR and not off the linter's quote, because the
 * quote is of the article as published and the text in the form has moved on.
 * See `the fixes`.
 *
 * Five more ask for the sentence again rather than for a correction —
 * Semicolons, ThereIs, Commas, Parentheses, Litotes, seventy-two findings in
 * the sample — and not one of them has an answer a rule could write. `r`
 * builds the question instead: the paragraph, the check, the linter's own
 * words, and the things a Radiopaedia sentence must not lose on the way
 * through somebody else's model. It goes on the clipboard, and a box opens to
 * paste the answer into.
 *
 * The tags do not travel. A paragraph that leaves as plain text comes back as
 * plain text with its references gone, so each piece of markup is replaced by
 * a marker before it goes and put back when it returns — a reference is one
 * opaque marker that may move but not change, a link or an emphasis is a pair
 * around its own words, which may be rewritten inside a tag that is kept. The
 * markers that come back are counted, and a paragraph that lost one is
 * refused rather than patched up.
 *
 * Which is the property worth stating: NO TAG A MODEL WROTE EVER REACHES THE
 * ARTICLE. What comes back is read as text, and every element in what gets
 * written is a clone of an element that was already in that paragraph.
 *
 * Nothing is sent by default: there is no model at the other end of this
 * script and no key in it. `tools/claude-bridge.py` is the opt-in — a loopback
 * server that runs the `claude` CLI you are already logged in to, which the
 * box can ask instead of waiting for you to carry the prompt somewhere. It is
 * off until you paste in the address it prints, the address only exists while
 * it is running, and `askBridge` refuses anything that is not 127.0.0.1 or
 * localhost whatever has been pasted. See `keeping the markup out of the round
 * trip`.
 *
 * The references at the bottom of the article are checked by a second tool at
 * the same host, `radiopaedia.work/cite`: it takes a reference, works out what
 * to look up in it, asks Crossref or PubMed or Google Books, and gives back the
 * canonical form. The edit page keeps each reference in a box of its own with
 * a "Format citation" link under it, and a `Lint citation` chip goes beside
 * that link: one press asks about that one reference — matches, differs, or
 * nothing in there to look up. Where it differs the two forms are shown
 * with the words that changed lit up, and the corrected line, numbered by
 * where it stands in the list, goes to the clipboard for you to paste.
 * Nothing is written to the editor from there: a reference is eighty words of
 * somebody's work and a chip beside it is not the place to replace them.
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
   * word the same, however much the text moved on in between. `cache=refresh`
   * is what clears that copy: a parameter of the API itself, which has the
   * linter read the article from Radiopaedia again before it answers. It costs
   * about a second over the cached reply, and that second is the whole reason
   * for pressing the button.
   *
   * Until 3.21.0 this was done the long way round, because the parameter did
   * not exist: read the linter's own page, find the CSRF token and the `lint`
   * component's Livewire snapshot in its HTML, and post back the `forceReload`
   * that the ⟳ there posts. That page has since gone behind a login —
   * `/lint/linter?slug=…` answers 302 to `/login` — so the script was reading a
   * login form, finding no snapshot in it, and refusing the press. One
   * documented parameter does the same work in one request, and nothing here
   * reads somebody else's HTML any more. */

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
  const DISPUTES_KEY = 'rlx-disputes';   // {article|finding: what you said about it}
  const MEANINGS_KEY = 'rlx-meanings';   // {acronym: the day you proposed a meaning for it}

  /* The bridge, if you are running one.
   *
   * `tools/claude-bridge.py` in this repository is a loopback server with one
   * route that runs the `claude` CLI you are already logged in to, with the
   * prompt on its standard input. With it running, the box that takes a
   * rewritten paragraph can ask for one instead of waiting for you to carry
   * the prompt somewhere and bring the answer back.
   *
   * It is OFF unless you have pasted its address in, and the address only
   * exists while the thing is running: the key in it is made fresh on every
   * start. `@connect 127.0.0.1` and `@connect localhost` are in the header
   * for it, and they are the two hosts a request can reach — see `askBridge`,
   * which refuses anything else whatever has been pasted.
   *
   * The address carries the key as a FRAGMENT, after a '#'. A fragment is
   * never sent in an HTTP request, so an address pasted into the wrong box,
   * or sitting in a browser history, is an address with the key stripped out
   * of every request it could possibly make. The script splits it off and
   * sends it as a header. */
  const BRIDGE_KEY = 'rlx-bridge';     // the address you pasted, if you did
  const BRIDGE_TIMEOUT = 200_000;      // the CLI is allowed three minutes at the far end
  const BRIDGE_HOST = /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/[^#]*$/;

  const bridgeAddress = () => {
    try { return localStorage.getItem(BRIDGE_KEY) || ''; } catch { return ''; }
  };

  function rememberBridge(address) {
    try {
      if (address) localStorage.setItem(BRIDGE_KEY, address);
      else localStorage.removeItem(BRIDGE_KEY);
    } catch { /* this session only */ }
  }

  /* One paragraph out, one paragraph back. Resolves either way — a bridge
   * that is not running is an ordinary thing to say, not an exception to
   * throw, and the box carries on with the clipboard. */
  function askBridge(address, prompt) {
    return new Promise((resolve) => {
      const at = String(address || '').indexOf('#');
      const url = at < 0 ? '' : address.slice(0, at);
      const key = at < 0 ? '' : address.slice(at + 1);
      if (!key || !BRIDGE_HOST.test(url)) {
        resolve({ trouble: 'that is not an address the bridge printed' });
        return;
      }
      GM_xmlhttpRequest({
        method: 'POST',
        url,
        timeout: BRIDGE_TIMEOUT,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Bridge-Key': key,
        },
        data: JSON.stringify({ prompt }),
        onload: (r) => {
          let said = null;
          try { said = JSON.parse(r.responseText || ''); } catch { /* said below */ }
          if (!said) return resolve({ trouble: 'the bridge answered something that is not an answer' });
          if (said.error) return resolve({ trouble: said.error });
          const text = typeof said.text === 'string' ? said.text.trim() : '';
          resolve(text ? { text } : { trouble: 'the bridge answered with nothing' });
        },
        onerror: () => resolve({ trouble: 'the bridge is not running, or it is not on a loopback address' }),
        ontimeout: () => resolve({ trouble: 'the bridge did not answer in time' }),
      });
    });
  }

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

  /* What the acronyms stand for.
   *
   * Not a `LISTS` entry, because it does not answer a finding: the lists say
   * "this word is fine as it is" and hide it, and this says "here is what it
   * stands for" and offers to write it in. The two are opposite sets — a word
   * in `acronyms.txt` never reaches the walk at all — and keeping them apart
   * is what keeps either file readable by the person editing it.
   *
   * What an acronym stands for is a fact about medicine and about the house
   * style, and the expansion goes into somebody's article word for word, so
   * nothing goes in that is not certain: an acronym whose expansion depends on
   * which article it is in is left out, and stays a finding to answer by hand.
   * An acronym the file does not name is offered no fix, which is exactly what
   * the check had before this existed. */
  const EXPANSIONS = {
    file: 'acronym-expansions.txt',
    cache: 'rlx-expansions',
    url: RAW_URL + 'acronym-expansions.txt',
    editUrl: EDIT_URL + 'acronym-expansions.txt',
    entries: null,      // Map, or `null` for "we could not read it"
    asked: null,
  };

  /* `EGFR = epidermal growth factor receptor`. Keyed in `flat()` shape, so
   * the file can be written in the case anybody likes and still answer the
   * acronym as the article spells it. An expansion with nothing after the
   * equals sign is a line somebody started and did not finish, and is not an
   * instruction to replace a word with nothing.
   *
   * One acronym may have SEVERAL lines, and that is the whole provision for
   * the words that mean two things:
   *
   *     RV = right ventricle
   *     RV = residual volume
   *
   * Which makes the value a list rather than a string. A word with one meaning
   * is a list of one and is written in without asking; a word with more is a
   * question, and `f` asks it — see `openChoice`. Nothing is guessed from the
   * article, because the thing that would have to be read to guess is the
   * sentence, and a file cannot see it.
   *
   * The same meaning written twice is one meaning: the file is edited by hand
   * by several people and a duplicate is a mistake, not a second option. */
  function parseExpansions(text) {
    const out = new Map();
    for (const line of String(text ?? '').split(/\r?\n/)) {
      const bare = line.replace(/#.*$/, '');
      const at = bare.indexOf('=');
      if (at < 1) continue;
      const word = flat(bare.slice(0, at));
      const says = tidy(bare.slice(at + 1));
      if (!word || !says) continue;

      const already = out.get(word);
      if (!already) out.set(word, [says]);
      else if (!already.some((one) => fold(one) === fold(says))) already.push(says);
    }
    return out;
  }

  // The same bargain the lists get: once per tab, again on Re-lint, silent on
  // failure — an unreadable file is "we do not know", and nothing is offered.
  async function readExpansions({ force } = {}) {
    if (!force && EXPANSIONS.entries) return EXPANSIONS.entries;
    if (!force && EXPANSIONS.asked) return EXPANSIONS.asked;

    EXPANSIONS.asked = (async () => {
      let text = force ? null : sessionStorage.getItem(EXPANSIONS.cache);
      if (text == null) {
        text = await askList(EXPANSIONS);
        if (text != null) {
          try { sessionStorage.setItem(EXPANSIONS.cache, text); } catch { /* quota */ }
        }
      }
      EXPANSIONS.entries = text == null ? null : parseExpansions(text);
      if (EXPANSIONS.entries) forgetMeanings([...EXPANSIONS.entries.keys()]);
      return EXPANSIONS.entries;
    })();
    return EXPANSIONS.asked;
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

  /* `flat` with the case left alone. Only `pick` asks for it: the search
   * itself stays blind to case, but where the article holds the same words
   * twice, once as "frontal lobe" and once as "Frontal lobe", the capital is
   * what says which one the linter quoted. */
  function cased(s) {
    return fold(s).replace(/\s+/g, '');
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
  /* The checks whose subject IS a reference marker, and which therefore must
   * be allowed to narrow onto one. */
  const ABOUT_CITATIONS = new Set([
    'Radiopaedia.CitationPrecedingSpace',
    'Radiopaedia.CitationPunctuationSup',
    'Radiopaedia.CitationSyntax',
    'Radiopaedia.ListPunctuation',
  ]);

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
     * superscript points at the one place the reader cannot act on.
     *
     * Unless the check is about the citation. On those the position lands in
     * a `<sup>` because that is where the thing being reported IS, and
     * refusing to narrow leaves a finding spread over a whole paragraph with
     * nothing to act on — which is how "Do not put full stops at the end of a
     * list item" came to offer no fix on a list item whose full stop follows a
     * reference. */
    if (!ABOUT_CITATIONS.has(lint.condition) && inCitation(lint.match, position - 1)) return 0;

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
   * the article from top to bottom — within each severity, since the walk
   * takes the errors first (see `byWeight`).
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
  /* The line, as long as the linter really has it.
   *
   * `trimmed` is `match` with the tags taken out, done at the far end, and it
   * is cut short wherever the prose itself contains a '<'. "paediatric-onset
   * multiple sclerosis (onset <16-18 years of age)" ends the string at
   * "(onset", and two hundred characters of paragraph go with it — five
   * findings in two hundred and twenty did that in the sample.
   *
   * `plain()` here does not make that mistake, because DOMParser follows the
   * HTML rule the hand-written strip does not: a '<' is only a tag when a
   * LETTER follows it, so "<16" is three characters of text. So where the
   * markup yields more of the same line, the longer one is the line.
   *
   * Only ever an extension, never a replacement: the longer string has to
   * begin with the shorter one, or this is not the same line and the
   * linter's own answer stands. */
  function fullLine(lint) {
    const trimmed = plain(lint.trimmed || lint.display || lint.match);
    const whole = plain(lint.match);
    return whole.length > trimmed.length && whole.startsWith(trimmed) ? whole : trimmed;
  }

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
      const snippet = fullLine(lint);
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

      out.push({ check, condition: lint.condition || '', severity, line: where,
                 message, snippet, words: plain(lint.matched),
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
          if (r.status >= 400 || body.length > (list.max || LIST_MAX)) return resolve(null);
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
  const lists = (opts) => Promise.all([
    ...Object.values(LISTS).map((l) => readList(l, opts)),
    readExpansions(opts),
  ]);

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

  /* The acronyms you have offered a meaning for, and the day you did. The
   * same bargain as `proposed()` next door, kept in its own store because the
   * two files are different files: a word can be waiting on a pull request to
   * `acronyms.txt` and on another to `acronym-expansions.txt` at the same
   * time, and they are opposite claims about it.
   *
   * Keyed in `flat()` shape, which is also the shape the expansions file is
   * read into — so a meaning that has landed can be recognised and forgotten
   * without a second pass over the words. */
  function proposedMeanings() {
    try { return JSON.parse(localStorage.getItem(MEANINGS_KEY) || '{}') || {}; }
    catch { return {}; }
  }

  function rememberMeaning(word) {
    const all = proposedMeanings();
    all[flat(word)] = new Date().toISOString().slice(0, 10);
    try { localStorage.setItem(MEANINGS_KEY, JSON.stringify(all)); }
    catch { /* this session only */ }
  }

  function forgetMeanings(words) {
    const all = proposedMeanings();
    let changed = false;
    for (const word of words) {
      if (word in all) { delete all[word]; changed = true; }
    }
    if (!changed) return;
    try { localStorage.setItem(MEANINGS_KEY, JSON.stringify(all)); }
    catch { /* never mind */ }
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
   * `refresh` is the ↻: it appends `cache=refresh`, which is the API's own way
   * of saying "read the article again rather than answer from the copy".
   * Omitted everywhere else, so an ordinary press costs the cached reply.
   *
   * Nothing that is not a lint result gets out of here. That is what lets the
   * rest of the file read an empty `lints[]` as an article with nothing wrong
   * with it, rather than as an answer it failed to understand. */
  function askLinter(slug, { refresh } = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: API_URL + encodeURIComponent(slug) + (refresh ? '&cache=refresh' : ''),
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

  /* What stops the text being seen, from the text outwards.
   *
   * A highlight is `position:fixed` on a layer over the page, so the only
   * thing that clips it is the window. The text is clipped by whatever scrolls
   * it, which is a smaller box than that: an iframe, or any ancestor with an
   * `overflow` of its own. Those two were treated as one thing for as long as
   * the editor was a TinyMCE iframe — the iframe's rectangle is both where
   * its coordinates start and where its content stops — and in a
   * contenteditable, which has no iframe, there was nothing to clip against at
   * all. Scroll such an editor and the words went under its top edge while the
   * line under them stayed on screen, drawn across whatever is above.
   *
   * So: every ancestor that clips its children, the iframe among them, and the
   * highlight is drawn inside all of them at once. Walked from the element
   * rather than guessed at, because which box scrolls is the editor's business
   * and it has been three different ones.
   *
   * `overflow: clip` and `hidden` and `auto` and `scroll` all clip; only
   * `visible` does not. An iframe clips whatever its own `overflow` says, so it
   * is taken without asking. */
  function clipChain(start) {
    const chain = [];
    for (let el = start; el && el !== document.documentElement; el = el.parentElement) {
      if (el.tagName === 'IFRAME') { chain.push(el); continue; }
      let style = null;
      try { style = getComputedStyle(el); } catch { break; }
      if (!style) break;
      if (style.overflowX !== 'visible' || style.overflowY !== 'visible') chain.push(el);
    }
    return chain;
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
    let s = '', cs = '';
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
        // The same character with its case kept, for `pick`. A letter whose
        // lower case is longer than itself would put the two strings out of
        // step, and there the lowercase one stands in.
        const k = cased(raw[i]);
        cs += k.length === c.length ? k : c;
        nodes.push(n);
        offsets.push(i);
        owners.push(owner);
        cited.push(isCitation);
        const b = blocks.get(owner);
        if (b) b.to = at; else blocks.set(owner, { from: at, to: at });
      }
    }
    return { root, s, cs, nodes, offsets, owners, cited, blocks };
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
   * onto a heading that happens to repeat the word.
   *
   * And before either, the copies written in the same case as the snippet.
   * The index is lowercase, so "Frontal lobe" also matches "frontal lobe", and
   * kipps-scale has it three times as a list item: lowercase under Stage 1 and
   * Stage 3, capitalised under Stage 4. The linter's finding was about the
   * Stage 4 one. Without this the first copy won, and that was the Stage 1
   * one, which has no capital to take off, so the finding pointed at a
   * lowercase item and offered no fix.
   *
   * `strict` is for the checks whose subject is the case itself. On those, no
   * copy in the same case means the capital is gone and the finding is fixed,
   * and a lowercase copy somewhere else is exactly what it must not land on. */
  const CASE_IS_THE_FINDING = new Set(['Radiopaedia.ListCaps']);

  function pick(index, needle, occurrence, exactCase, strict) {
    const hits = locateAll(index, needle);
    if (!hits.length) return null;
    const blocksFirst = (list) => {
      const exact = list.filter((h) => fillsBlock(index, h));
      return (exact.length >= occurrence ? exact : list)[occurrence - 1] || null;
    };
    if (exactCase) {
      const same = hits.filter((h) => index.cs.slice(h.from, h.to + 1) === exactCase);
      const hit = same.length ? blocksFirst(same) : null;
      if (hit || strict) return hit;
    }
    return blocksFirst(hits);
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
   * puts the reader's eye on the one thing they must not touch.
   *
   * The other way round for a check about what is INSIDE a marker: the `1.`
   * of `<sup>1.</sup>` is what the finding is about, and a `type 1.` in the
   * prose of the same paragraph is not. */
  const INSIDE_CITATIONS = new Set(['Radiopaedia.CitationPunctuationSup']);

  function within(index, wide, needle, nth, inside) {
    if (!needle || nth === 0) return -1;
    const hay = index.s.slice(wide.from, wide.to + 1);
    const hits = [];
    for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) hits.push(at);
    if (!hits.length) return -1;
    const wanted = hits.filter((at) => !!index.cited[wide.from + at] === !!inside);
    const list = wanted.length ? wanted : hits;
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
    /* Once per root rather than once per finding per frame: walking ancestors
       and asking each for its computed style, sixty times a second during a
       scroll, is work nobody would ever see. Re-walked whenever the findings
       are re-anchored, which is after every edit, so an editor that changes
       shape — going full screen, say — is picked up by the next keystroke. */
    const chains = roots.map((r) => clipChain(r.frame || r.root));
    for (const f of findings) {
      f.range = null; f.frame = null; f.clips = null; f.narrowed = false; f.caret = null;
      if (f.state === 'ignored' || f.state === 'done') continue;
      const needle = flat(f.snippet);
      if (!needle) continue;
      const exactCase = cased(f.snippet);
      const strict = CASE_IS_THE_FINDING.has(f.condition);
      for (let i = 0; i < indices.length; i++) {
        const wide = pick(indices[i], needle, f.occurrence || 1, exactCase, strict);
        if (!wide) continue;

        let spot = wide;
        const rel = within(indices[i], wide, f.target, f.targetNth,
          INSIDE_CITATIONS.has(f.condition));
        if (rel >= 0) {
          spot = { from: wide.from + rel, to: wide.from + rel + f.target.length - 1 };
          f.narrowed = true;
        }
        f.range = rangeFrom(indices[i], spot);
        f.frame = roots[i].frame;
        f.clips = chains[i];

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

  // ——————————————————————————————————————————————————— the fixes

  /* A good few findings have exactly one right answer, and it is not a matter
   * of taste: `post-biopsy` loses its hyphen, `68Ga` becomes `Ga-68`, `aka`
   * becomes `a.k.a.`, a comma goes in before the last `and`. Those are the
   * ones this section writes, and the list is short on purpose — everything
   * that needs a sentence rewritten, a word looked up or a judgement made
   * stays yours.
   *
   * Three rules hold all of them together, and they are what keeps this from
   * being a bot:
   *
   * The proposal is read off the EDITOR, not off the linter. The linter
   * quotes the article as it was published; the text you are looking at has
   * moved on, and a replacement built from the quote would paste the old
   * spacing, the old wording and sometimes an old sentence back in. So the
   * input is `range.toString()` — the characters actually under the
   * highlight — and the output is what those characters should read instead.
   *
   * Only a NARROWED finding is offered one. Where the highlight is still the
   * whole paragraph, the words the rule is about were not found inside it, and
   * "remove the hyphen" would remove some other line's hyphen.
   *
   * What gets written is the SMALLEST edit that turns one into the other — the
   * comma, the hyphen, the letter — and never the whole phrase. A phrase with
   * a link in the middle of it, replaced wholesale, comes back as plain text
   * with the link gone. `narrow()` below finds that smallest edit, and the fix
   * is refused outright unless it lands inside a single text node, which is
   * the one shape that cannot disturb the markup around it. */

  /* 'post-biopsy' → 'postbiopsy'. One hyphen or none: a word with two of them
   * is not the compound this rule is about, and guessing which to take out is
   * exactly the kind of guess that does not belong here. */
  function dropHyphen(text) {
    const parts = text.split('-');
    return parts.length === 2 && parts[0] && parts[1] ? parts[0] + parts[1] : null;
  }

  /* 'Balthazar score' → 'balthazar score', and a hard no on an acronym. The
   * rule is about a sentence started with a capital; `MRI findings` starts
   * with a word that is capitals all the way down, and `mRI findings` is not
   * what anybody meant. Whether `Balthazar` is a name is a question this
   * cannot answer — but `p` is on the bar next to this, which is the answer. */
  function lowerFirst(text) {
    const first = text.split(/\s+/)[0] || '';
    if (first.length > 1 && first === first.toUpperCase()) return null;
    const low = text[0].toLowerCase();
    return low === text[0] ? null : low + text.slice(1);
  }

  /* 'e.g. donepezil, rivastigmine, and' → 'e.g. donepezil, rivastigmine,'.
   *
   * The comma has to survive the conjunction leaving, and it is not always
   * there to begin with: a list of two reads 'e.g. A and B', and dropping the
   * word alone would leave 'e.g. A B'. So the comma is kept where there is one
   * and put in where there is not. */
  const TRAILING_CONJUNCTION = /[,;]?\s+(?:and|or)$/i;

  function dropTrailingConjunction(text) {
    const m = TRAILING_CONJUNCTION.exec(text);
    if (!m) return null;
    const head = text.slice(0, m.index).trimEnd();
    return /[,;]$/.test(head) ? head : `${head},`;
  }

  /* 'aka' → 'a.k.a.', 'vs.' → 'vs'. The message carries the answer —
   * "Use appropriate Latin forms: 'a.k.a.' rather than 'aka'." — so this reads
   * it out of there rather than keeping a table of its own that could disagree
   * with the linter's. The form it says to replace has to be the text under
   * the highlight, or this is not the finding we think it is. */
  /* The three wordings the linter uses for "this, not that" — "'X' rather
   * than 'Y'", "'X' in place of 'Y'", "'X' instead of 'Y'" — and nine checks
   * between them.
   *
   * The quoted word may itself hold an apostrophe, because one of those
   * checks is the contractions one and `don't` is what it is about. An
   * apostrophe is read as part of the word only with a word character on
   * BOTH sides of it. With only the one — "a quote counts as the closing one
   * unless a letter follows" was the first attempt — the spelling check's own
   * message swallows its first pair whole: "advises the '-eous' form:
   * 'homogeneous' rather than 'Homogenous'" has a quote followed by a letter
   * in the middle of it, and the answer came back as " form: 'homogeneous".
   *
   * Which of the two is the answer is not taken on trust. Every caller
   * checks that the SECOND is the text under the highlight before writing
   * the first, so a message built the other way round offers no fix at all
   * rather than writing the mistake back in. */
  const QUOTED = "'((?:[^']|(?<=\\w)'(?=\\w))+)'";
  const LATIN_FORM = new RegExp(
    `${QUOTED}\\s+(?:rather than|in place of|instead of)\\s+${QUOTED}`, 'i');

  function latinForm(text, f) {
    const m = LATIN_FORM.exec(f.message || '');
    return m && fold(m[2]) === fold(text) ? m[1] : null;
  }

  // '68Ga' → 'Ga-68'.
  const ISOTOPE = /^(\d{1,3})([A-Za-z]{1,2})$/;

  function isotope(text) {
    const m = ISOTOPE.exec(text);
    return m ? `${m[2]}-${m[1]}` : null;
  }

  // '"washout."' → '"washout".'
  const QUOTE_MARK = '[\'"‘’“”]';
  const QUOTED_PUNCT = new RegExp(`^(${QUOTE_MARK})([\\s\\S]+?)([,.])(${QUOTE_MARK})$`);

  function punctuationOutside(text) {
    const m = QUOTED_PUNCT.exec(text);
    return m ? m[1] + m[2] + m[4] + m[3] : null;
  }

  /* 'tissue, citrate and polyamine' → 'tissue, citrate, and polyamine'. The
   * comma goes before the LAST conjunction, which is the one the phrase ends
   * on — `CONJUNCTION` is the same expression `insertion()` uses to draw the
   * caret, so the mark on the text and the text written in are the same
   * reading of the same phrase. */
  function oxfordComma(text) {
    let at = -1;
    for (const m of text.matchAll(CONJUNCTION)) at = m.index;
    if (at <= 0 || text[at - 1] === ',') return null;
    return text.slice(0, at) + ',' + text.slice(at);
  }

  /* '1-2' → '1,2'. Two references in a row are a list and not a range, which
   * is what "except when the range is over 2" means: 1-5 stays as it is. The
   * separator carries no space, because that is how the rest of them are
   * written — `<sup>26,27</sup>`.
   *
   * The pair can be one piece of a longer list, and the check quotes the whole
   * of it: '1-2,4,5' → '1,2,4,5', '1-2,4-8' → '1,2,4-8'. A list with no such
   * pair in it is not this fix's business, and is left as it came. */
  const TWO_IN_A_ROW = /^(\d+)\s*[-–]\s*(\d+)$/;

  function citationList(text) {
    if (!CITATION_NUMBERS.test(text)) return null;
    let found = false;
    const pieces = text.split(',').map((piece) => {
      const m = TWO_IN_A_ROW.exec(piece.trim());
      if (!m || Number(m[2]) - Number(m[1]) !== 1) return piece.trim();
      found = true;
      return `${m[1]},${m[2]}`;
    });
    return found ? pieces.join(',') : null;
  }

  // 'fluorinated tracers.' → 'fluorinated tracers'. An ellipsis is not a full
  // stop and is left where it is.
  function dropFullStop(text) {
    return /[^.]\.$/.test(text) ? text.slice(0, -1) : null;
  }

  // "Crohn's disease" → 'Crohn disease'. The eponym only: a possessive
  // anywhere else in the phrase is somebody's grammar, not an eponym.
  const POSSESSIVE = /^(\p{Lu}[\p{L}'’-]*?)['’]s\b/u;

  function dropPossessive(text) {
    const m = POSSESSIVE.exec(text);
    return m ? m[1] + text.slice(m[0].length) : null;
  }

  // 'between 10-17' → '10-17'.
  const RANGE_WORD = /^(?:from|between)\s+/i;

  function dropRangeWord(text) {
    return RANGE_WORD.test(text) ? text.replace(RANGE_WORD, '') : null;
  }

  /* 's.A' → 's. A'. The linter quotes the three characters either side of the
   * join, which is the whole of what has to change. */
  const NO_SPACE_AFTER = /^(\S)([.,;:])(\S)$/;

  function oneSpace(text) {
    const m = NO_SPACE_AFTER.exec(text);
    return m ? `${m[1]}${m[2]} ${m[3]}` : null;
  }

  /* '–' → '-'. `flat()` folds the dashes onto one another, which is how the
   * en-dash was found at all; `range.toString()` gives back the character that
   * is really in the text, and this is the one case where which of them it is
   * decides the answer. */
  function hyphenMinus(text) {
    return /^[–—−]+$/.test(text) ? '-' : null;
  }

  /* 'EGFR' → 'epidermal growth factor receptor (EGFR)', where the expansions
   * file says what the letters stand for.
   *
   * The commonest finding the linter has, and the only one whose answer is a
   * fact about the world rather than about the text. `acronym-expansions.txt`
   * is where that fact is kept, and it ships empty: until somebody writes the
   * line, this offers nothing.
   *
   * Only on the FIRST use in the article. The check reports every occurrence —
   * in the sample, 76 of 141 findings were a repeat of an acronym already
   * reported higher up the same article, `PSMA` eight times in one of them —
   * and spelling it out at the fifth is not what was asked for: the article
   * would define a word it has been using for three paragraphs. Written at the
   * first, all the others answer themselves.
   *
   * The expansion is written as the file has it. It goes into an article word
   * for word, which is why the file says to put nothing in it that is not
   * certain. */
  function spellOut(text, f) {
    const says = meanings(text);
    if (!says.length || !firstUse(f)) return null;
    // One meaning is written in; several are a question, and `f.chosen` is
    // your answer to it. Until that is there, this has nothing to say.
    const one = says.length === 1 ? says[0] : f.chosen;
    return one && says.includes(one) ? `${one} (${text})` : null;
  }

  // What the file says this acronym stands for. Never `null`: "we could not
  // read the file" and "the file does not name it" are both nothing to offer.
  const meanings = (text) => EXPANSIONS.entries?.get(flat(text)) || [];

  /* Fixes that are a question before they are an answer.
   *
   * One table because one condition needs it, and it is here as a table
   * rather than an `if` inside `proposal` so that the next one is a line. */
  const CHOICES = {
    'Radiopaedia.Acronyms': (text, f) => {
      const says = meanings(text);
      return says.length > 1 && firstUse(f) ? says : null;
    },
  };

  /* Is this the first finding in the article quoting this word?
   *
   * `stage.findings` is in document order — `fromApi` sorts it that way so
   * that walking with `j` walks the article from top to bottom — so the first
   * one that quotes the word is the first use of it. State is not consulted on
   * purpose: an occurrence you have marked done, or ignored, is still an
   * occurrence standing in the text above this one. */
  function firstUse(f) {
    const word = fold(f.words || '');
    if (!word) return false;
    for (const other of stage.findings) {
      if (other === f) return true;
      if (other.condition === f.condition && fold(other.words || '') === word) return false;
    }
    return true;
  }

  /* '50 - 60' → '50-60'.
   *
   * Left out of the first pass because the only examples to hand were the
   * `10<sup>-6</sup>` ones, where the linter reads the superscript as prose
   * and asks for a space to be closed that is not in the text. Fifty articles
   * later there are real ones, and the false ones turn out to refuse
   * themselves: in the editor `10<sup>-6</sup>` reads as "10-6" with nothing
   * between, so this gives back what it was given and nothing is offered. */
  const AROUND_HYPHEN = /^(\d+)\s*[-–]\s*(\d+)$/;

  function closeRange(text) {
    const m = AROUND_HYPHEN.exec(text);
    return m ? `${m[1]}-${m[2]}` : null;
  }

  /* ': This article' → ': this article'.
   *
   * The same two refusals as the capital on a list item, for the same two
   * reasons: an acronym would come back as `mRI`, and a proper noun is not a
   * mistake. The names file is asked here as well — it is already loaded, and
   * "American College of Cardiology" after a colon is as much a name as it is
   * at the start of a list item. */
  const AFTER_COLON = /^(\s*:\s*)(\S+)([\s\S]*)$/;
  const TWO_CAPITALS = /^\p{Lu}[\p{L}'\u2019-]*\s+\p{Lu}/u;

  function lowerAfterColon(text) {
    const m = AFTER_COLON.exec(text);
    if (!m) return null;

    const word = m[2];
    if (word.length > 1 && word === word.toUpperCase()) return null;

    /* Optional chaining and not a plain lookup: this runs inside `proposal`,
       which runs on every redraw, and a throw in there takes the note and the
       bar with it. */
    const names = LISTS.names?.entries;
    if (names && startsWithEntry(word + m[3], names)) return null;

    /* And a second capital right after the first is a name the file has not
       been told about. ": This article" is a sentence — one capital, then
       lower case. ": American College of Cardiology" is not, and the names
       file cannot be relied on to say so: it has "American College of Chest
       Physicians" in it, which does not cover "of Cardiology" and never
       could, because the list is of the names somebody has met. Two capitals
       running is the shape itself. */
    if (TWO_CAPITALS.test(word + m[3])) return null;

    const low = word[0].toLowerCase();
    return low === word[0] ? null : m[1] + low + word.slice(1) + m[3];
  }

  /* 'Homogenous' → 'Homogeneous'. The message names the form Radiopaedia
   * wants, the same shape the Latin rule reads — and the same reading is used
   * for it. The capital is the article's and stays the article's: the word is
   * quoted in the message in lower case because that is how a dictionary
   * writes it, not because the sentence should start in lower case. */
  function preferredSpelling(text, f) {
    const m = LATIN_FORM.exec(f.message || '');
    if (!m || fold(m[2]) !== fold(text)) return null;
    const want = m[1];
    return /^\p{Lu}/u.test(text) ? want.charAt(0).toUpperCase() + want.slice(1) : want;
  }

  /* 'more complete' → 'complete'. A thing is complete or it is not, and the
   * word in front of it is the whole of what the check is objecting to. */
  const NOT_COMPARABLE = /^(?:more|most|less|least|very|quite|rather|somewhat)\s+/i;

  function dropIntensifier(text) {
    return NOT_COMPARABLE.test(text) ? text.replace(NOT_COMPARABLE, '') : null;
  }

  /* '5mm' → '5 mm'.
   *
   * The one rule here written from the check's own definition rather than
   * from findings: it fires rarely enough not to appear in fifty articles of
   * output, so there was nothing to read it off. Its tokens say what counts
   * as a unit, and this is that list — ns, ms, min, h, d, y, s, mm, cm, km,
   * m, mL, L — with the longest taken first, `min` before `m` and `mm`
   * before `m`.
   *
   * The unit has to END where it ends. "30minutes" is a word and not thirty
   * minutes; "5mmHg" is a unit of its own, and millimetres of mercury with a
   * space dropped into the middle would be worse than the thing complained
   * of. Both come back with nothing offered.
   *
   * The space goes in at the FIRST join, because the check can quote a run
   * wider than the number and its unit: its last token takes the word
   * characters on either side, so "3mm-thick" arrives whole and leaves as
   * "3 mm-thick".
   *
   * The exceptions — Tc-99m, technetium-99m, 99m-methyl, the H3K27m
   * mutations, and `[2-9]0s` for a decade — are the check's own and never
   * reach us. Where one did, the letter after it would not be a unit's end
   * and nothing would be offered anyway. */
  const NUMBER_AND_UNIT = /(\d)(min|ns|ms|mm|cm|km|mL|L|m|h|d|y|s)(?![A-Za-z])/;

  function spaceBeforeUnit(text) {
    const m = NUMBER_AND_UNIT.exec(text);
    if (!m) return null;
    const at = m.index + 1;
    return `${text.slice(0, at)} ${text.slice(at)}`;
  }


  /* ——— the ones read off the check listing rather than off its findings
   *
   * Everything above was written from output: fifty articles' worth of
   * findings, with the shape of `matched` read off what actually arrived.
   * These came the other way, from the linter's own listing of its checks —
   * every rule's tokens, exceptions and message, which is the thing that says
   * what a check means rather than what it happened to catch. Where the two
   * disagree the findings win, and three of these are narrower than their
   * definition for exactly that reason.
   *
   * The listing is also what says which of these can be answered at all. A
   * check whose message is "check this against the style guide" is not a
   * fix, whatever its tokens say. */

  /* The character standing in front of the highlight, read out of the
   * editor rather than out of the quoted line: the quoted line may hold the
   * same few characters several times over, and this is the one occurrence
   * being talked about. Empty at the start of a run, which the two callers
   * read as "nothing in the way". */
  function charBefore(range) {
    const node = range.startContainer;
    if (!node || node.nodeType !== 3 || range.startOffset < 1) return '';
    return (node.nodeValue || '')[range.startOffset - 1] || '';
  }

  /* The substitution checks: nine of them, one fix.
   *
   * 'sulphate' → 'sulfate', 'foetus' → 'fetus', 'disk' → 'disc', 'don't' →
   * 'do not'. Each of these carries a table of swaps in the linter, and the
   * swap it chose is in the message it sends — "use 'X' rather than 'Y'",
   * "use 'X' in place of 'Y'", "use 'X' instead of 'Y'". Reading it out of
   * there rather than keeping nine tables of our own is the whole point:
   * a copy here could disagree with the linter's, and the one on the server
   * is the one that is right by definition.
   *
   * `preferredSpelling` already did this for one of them. It is unchanged;
   * it is simply pointed at the rest, and the phrase it reads now covers all
   * three wordings. The capital stays the article's: the words are quoted in
   * the message the way a dictionary writes them, not the way the sentence
   * starts. */
  const SAYS_THE_ANSWER = [
    'Radiopaedia.Contractions',
    'Radiopaedia.FetusSpelling',
    'Radiopaedia.MedicalMisspellings',
    'Radiopaedia.SulfurSpelling',
    'Radiopaedia.WordsWeNeverUse',
    'Radiopaedia.DiscSpelling',
    'Radiopaedia.GreySpelling',
    'Radiopaedia.GreaterLessThanEqualTo',
    'Radiopaedia.HeterogeneousSpelling',
  ];

  /* Litotes is the one substitution check left out, and on purpose. It is a
   * swap in the same shape — "Consider using 'lack(s)' instead of 'not
   * have'" — but it is a swap of meaning rather than of spelling, and the
   * sentence it lands in decides whether it is right. The three in the
   * sample make the case on their own: writing in `lack(s)` would trip
   * OptionalPlurals, which forbids exactly that, on the next run. */

  // '~ 15' → '~15'. The symbol and the number it belongs to, and the check
  // objects to what is between them.
  const AFTER_SYMBOL = /^([~≈])\s+(\d)/;

  function closeApproximation(text) {
    return AFTER_SYMBOL.test(text) ? text.replace(AFTER_SYMBOL, '$1$2') : null;
  }

  // '< 5' → '<5'. The same thing one symbol along.
  const AFTER_COMPARISON = /^([<>])\s+(\d)/;

  function closeComparison(text) {
    return AFTER_COMPARISON.test(text) ? text.replace(AFTER_COMPARISON, '$1$2') : null;
  }

  /* 'ratio :' → 'ratio:'. The check's token is `\w +:` — a word, one or more
   * spaces, the colon — so the space is all of what is wrong. Its own
   * description says the matching rule for the space AFTER a colon is
   * deliberately not enforced, because `albumin:globulin` and `grey:white`
   * are ratios and are written closed up; nothing here touches that side. */
  const SPACE_BEFORE_COLON = /(\S)\s+:$/;

  function closeColon(text) {
    return SPACE_BEFORE_COLON.test(text) ? text.replace(SPACE_BEFORE_COLON, '$1:') : null;
  }

  // 'T4 - 5' → 'T4-5'. A spinal level, where the hyphen is a joiner and not
  // a range: 'T12 - L1' and 'L5 - conus' come through the same way.
  const SPACED_LEVEL = /^([CTLS]\d+)\s*-\s*([CTLS]?\d+|conus)$/i;

  function closeLevel(text) {
    const m = SPACED_LEVEL.exec(text);
    return m ? `${m[1]}-${m[2]}` : null;
  }

  /* 'T2-T3' → 'T2-3'. The second reference repeats the letter the first one
   * already gave, and the check asks for it to go — but only where it is the
   * SAME letter. 'T12-L1' crosses from the thoracic spine to the lumbar and
   * every character of it is carrying weight; the check's own tokens say as
   * much, pairing each letter with itself. */
  const DOUBLED_LEVEL = /^([CTLS])(\d+)-\1(\d+)$/i;

  function dropRepeatedLevel(text) {
    const m = DOUBLED_LEVEL.exec(text);
    return m ? `${m[1]}${m[2]}-${m[3]}` : null;
  }

  // 'lesion(s)' → 'lesions'. The brackets go and the plural stays, which is
  // the reading the check's description gives: the s is not optional.
  const BRACKETED_S = /^(\w+)\((s)\)$/i;

  function plainPlural(text) {
    const m = BRACKETED_S.exec(text);
    return m ? m[1] + m[2] : null;
  }

  /* 'C.T.' → 'CT'. The check takes three or more of letter-and-stop in a
   * row, so what it quotes is the whole initialism and the stops are the
   * whole of what is wrong with it. Nothing else in the run is touched: the
   * letters keep their case, because an initialism's case is not this
   * check's business. */
  const LETTER_STOPS = /^(?:[A-Z]\.){3,}$/;

  function dropStops(text) {
    return LETTER_STOPS.test(text) ? text.replace(/\./g, '') : null;
  }

  /* 'Dr.' → 'Dr', and 'R.F. Player' → 'R F Player'. Two tokens, two
   * readings: a title that has taken a full stop, and initials that have
   * taken stops instead of the space between them. The check's description
   * gives the finished form — "Dr R F Player" — and both of these are one
   * step towards it. */
  const TITLE_STOP = /^(Dr|Prof|Mr|Mrs|Ms|Sir|St)\.$/;
  const STOPPED_INITIALS = /^([A-Z])\.\s?([A-Z])\.(\s?)$/;

  function dropNameStops(text) {
    if (TITLE_STOP.test(text)) return text.slice(0, -1);
    const m = STOPPED_INITIALS.exec(text);
    return m ? `${m[1]} ${m[2]}${m[3] || ''}` : null;
  }

  /* 'PET/CT' → 'PET-CT'. The slash reads as a choice between the two and
   * they are not a choice: the description says a hyphen is what shows they
   * are a true combination. */
  const MODALITY_SLASH = /^(PET|SPECT)\/(CT|MRI?)$/;

  function hyphenateHybrid(text) {
    const m = MODALITY_SLASH.exec(text);
    return m ? `${m[1]}-${m[2]}` : null;
  }

  // 'meningocoele' → 'meningocele'. The suffix sits inside the word, which
  // is why the check is an existence rule rather than one of the swaps.
  function celeSuffix(text) {
    return /coele/i.test(text) ? text.replace(/coele/gi, (s) => s[0] + 'ele') : null;
  }

  // 'between 3 to 5' → 'between 3 and 5'.
  const BETWEEN_TO = /^(between\s+\S+\s+)to(\s+\S+)$/i;

  function betweenAnd(text) {
    const m = BETWEEN_TO.exec(text);
    return m ? `${m[1]}and${m[2]}` : null;
  }

  /* 'cases — including' → 'cases - including'. The check's token takes the
   * spaces on either side of the dash along with it, and its message says
   * what to put back: a hyphen-minus with a space on either side. Written
   * out in full rather than swapping the one character, because the dash
   * sometimes arrives with no space beside it at all. */
  const EM_DASH = /^(\s*)—(\s*)$/;

  function spacedHyphen(text) {
    return EM_DASH.test(text) ? ' - ' : null;
  }

  // 'head & neck' → 'head and neck'. The exceptions the style guide names —
  // H&E, initials either side, head & neck itself — are the check's own and
  // never reach here.
  const LONE_AMPERSAND = /^(\s)&(\s)$/;

  function spellAnd(text) {
    const m = LONE_AMPERSAND.exec(text);
    return m ? `${m[1]}and${m[2]}` : null;
  }

  /* 'redundant!' → 'redundant.' The check quotes the character in front of
   * the mark along with it — `t!` — and its token only fires where a space
   * or the end of the line follows, so the mark is ending a sentence and a
   * full stop is what ends one instead. Taking it out altogether was the
   * other reading and is worse: it leaves the sentence with no end at all. */
  const EXCLAMATION = /!$/;

  function fullStopInstead(text) {
    return EXCLAMATION.test(text) ? text.slice(0, -1) + '.' : null;
  }

  /* 'Imaging features:' → 'Imaging features'. The check's token is a letter
   * or digit, then a stop or a colon, at the end of a heading — so the last
   * character is the whole of it. */
  const HEADING_TAIL = /^([A-Za-z0-9])[.:](\s*)$/;

  function dropHeadingPunctuation(text) {
    const m = HEADING_TAIL.exec(text);
    return m ? m[1] + (m[2] || '') : null;
  }

  /* '12000' → '12,000'. Five digits or more, which is where the check starts
   * asking — ten thousand and up — and the separators go in from the right.
   * The check quotes the number with its word boundaries, so there is
   * nothing else in the run to preserve. */
  const BARE_THOUSANDS = /^\d{5,}$/;

  function thousandsSeparators(text) {
    if (!BARE_THOUSANDS.test(text)) return null;
    return text.replace(/\B(?=(\d{3})+$)/g, ',');
  }

  /* '4PM' → '4 PM'; '4pm' → '4 PM'; '4 p.m.' → '4 PM'. All three of the
   * check's tokens, and its message gives the finished form: the two letters
   * in capitals with a space in front of them. */
  const CLOCK = /^(\d{1,2})\s*([aApP])\.?\s?[mM]\.?$/;

  function spaceBeforeMeridiem(text) {
    const m = CLOCK.exec(text);
    return m ? `${m[1]} ${m[2].toUpperCase()}M` : null;
  }

  /* '3 Tesla' → '3 tesla', and '5 ml' → '5 mL'. Two tokens with one idea
   * between them, which the check's description states: a unit named after
   * somebody is still a unit and is written in lower case, and the litre is
   * the one that takes a capital because a lower-case l is a figure one.
   *
   * It is anchored to the number in front of it for a reason the check gives
   * itself — every eponymous unit is also a surname, correctly capitalised
   * when it is the person. Only the quoted run is touched, and the quoted run
   * starts at the number. */
  const EPONYMOUS_UNIT =
    /^(\d+(?:\.\d+)?\s?)(Tesla|Sievert|Gray|Becquerel|Curie|Hertz|Kelvin|Newton|Pascal|Watt|Volt|Ampere)$/;
  const SMALL_LITRE = /^(\d+\s?)ml$/;

  function unitCase(text) {
    const m = EPONYMOUS_UNIT.exec(text);
    if (m) return m[1] + m[2].toLowerCase();
    const l = SMALL_LITRE.exec(text);
    return l ? `${l[1]}mL` : null;
  }

  /* '½' → '1/2', and '.5' → '0.5'.
   *
   * Two tokens again, and the second one needs watching. The check's rule is
   * a dot with digits after it and no digit or dot in front — which catches
   * a decimal that has lost its zero, and also catches `c.2023`, an
   * abbreviation with a year after it. The sample has one finding of this
   * check and it is that one: writing `0.2023` into "in common usage
   * (c.2023)" would be worse than anything the linter is complaining about.
   *
   * So the zero goes in only where a LETTER is not standing in front of the
   * dot. A decimal in prose follows a space, a bracket or the start of a
   * run; `c.`, `fig.` and `approx.` are what the letter means, and those are
   * left alone. The character is read out of the editor rather than out of
   * the quoted line, because the line may hold several of them. */
  const GLYPH_FRACTIONS = { '¼': '1/4', '½': '1/2', '¾': '3/4', '⅓': '1/3', '⅔': '2/3', '⅛': '1/8' };
  const LEADING_DOT = /^\.(\d+)$/;

  function numberFormat(text, f) {
    if (GLYPH_FRACTIONS[text]) return GLYPH_FRACTIONS[text];
    const m = LEADING_DOT.exec(text);
    if (!m) return null;
    if (/[A-Za-z]/.test(charBefore(f.range))) return null;
    return `0.${m[1]}`;
  }

  /* 'X-ray' → 'x-ray'; 'xray' → 'x-ray'; 'et.c.' → 'etc.'
   *
   * The abbreviations check covers several forms under one message — "check
   * the abbreviation form against the style guide" — which is not an answer,
   * so most of what it catches gets none here. Three of its tokens do say
   * what is wrong on their own:
   *
   *   X-ray   its token carries a lookbehind, a lower-case letter or a comma
   *           and then a space, which is the check saying in its own tokens
   *           that the capital is wrong where the word is not starting a
   *           sentence
   *   xray    the hyphen is missing and there is one spelling to miss it
   *   et.c.   three ways of writing etc. wrong, and `etc..` which is the
   *   &c.     abbreviation with the sentence's own full stop left on it
   *
   * `XRAY` is a token too and is left alone: it is caught wherever it
   * appears, and whether it should come back as `x-ray` or `X-ray` depends
   * on whether it begins the sentence, which the finding does not say.
   * `c.2023` is the other form in the sample and the guide's answer for it
   * is not in the listing, so it goes the way the number check sends it. */
  const ABBREVIATIONS = {
    'X-ray': 'x-ray',
    xray: 'x-ray',
    'etc..': 'etc.',
    'et.c.': 'etc.',
    '&.t.c.': 'etc.',
    '&c.': 'etc.',
  };

  function abbreviationForm(text) {
    return ABBREVIATIONS[text] || null;
  }

  /* The whole list. A condition that is not in here has no fix, and that is
   * the usual case: of the thirty-odd checks the linter runs, these are the
   * ones where the answer does not depend on knowing what the sentence is
   * trying to say. */
  const TEXT_FIXES = {
    'Radiopaedia.OxfordComma': oxfordComma,
    'Radiopaedia.AdjectivalHyphens': dropHyphen,
    'Radiopaedia.PrefixHyphens': dropHyphen,
    'Radiopaedia.ListCaps': lowerFirst,
    'Radiopaedia.EGListAnd': dropTrailingConjunction,
    'Radiopaedia.Latin': latinForm,
    'Radiopaedia.IsotopeNotation': isotope,
    'Radiopaedia.Quotes': punctuationOutside,
    'Radiopaedia.CitationSyntax': citationList,
    'Radiopaedia.ListPunctuation': dropFullStop,
    'Radiopaedia.EponymApostrophe': dropPossessive,
    'Radiopaedia.Ranges': dropRangeWord,
    'Radiopaedia.Spacing': oneSpace,
    'Radiopaedia.EnDash': hyphenMinus,
    'Radiopaedia.InlineEG': inlineEG,
    'Radiopaedia.Acronyms': spellOut,
    'Radiopaedia.NumberSpacing': closeRange,
    'Radiopaedia.Colons': lowerAfterColon,
    'Radiopaedia.Uncomparables': dropIntensifier,
    'Radiopaedia.Units': spaceBeforeUnit,

    // read off the check listing — see the block above
    'Radiopaedia.ApproximationSpacing': closeApproximation,
    'Radiopaedia.NumberComparisons': closeComparison,
    'Radiopaedia.ColonSpacing': closeColon,
    'Radiopaedia.SpinalLevelSpacing': closeLevel,
    'Radiopaedia.SpinalLevelFormat': dropRepeatedLevel,
    'Radiopaedia.OptionalPlurals': plainPlural,
    'Radiopaedia.Periods': dropStops,
    'Radiopaedia.PersonalNames': dropNameStops,
    'Radiopaedia.HybridImagingSlash': hyphenateHybrid,
    'Radiopaedia.CeleSuffix': celeSuffix,
    'Radiopaedia.BetweenAnd': betweenAnd,
    'Radiopaedia.EmDash': spacedHyphen,
    'Radiopaedia.Ampersand': spellAnd,
    'Radiopaedia.Exclamation': fullStopInstead,
    'Radiopaedia.HeadingPunctuation': dropHeadingPunctuation,
    'Radiopaedia.NumbersOver10000': thousandsSeparators,
    'Radiopaedia.AMPM': spaceBeforeMeridiem,
    'Radiopaedia.UnitCapitalisation': unitCase,
    'Radiopaedia.NumberFormatting': numberFormat,
    'Radiopaedia.AcceptedAbbreviations': abbreviationForm,
  };

  // The nine that say the answer in their own message, all answered by the
  // one reading of it. Registered here rather than written out above so that
  // the list and the fix cannot drift apart.
  for (const condition of SAYS_THE_ANSWER) TEXT_FIXES[condition] = preferredSpelling;

  /* Fixes that need the character standing before the highlight as well.
   *
   * `deep location (e.g. thalamus)` has to come out as `deep location, e.g.
   * thalamus`, and the space in front of the bracket has to go with the
   * bracket — leave it and the comma lands with a space in front of it. The
   * linter's words stop at the bracket, so this is the one place the fix
   * reaches outside them, and it reaches exactly one character. */
  const TAKES_THE_SPACE_BEFORE = new Set(['Radiopaedia.InlineEG']);

  function withSpaceBefore(range) {
    const node = range.startContainer;
    if (node.nodeType !== 3 || range.startOffset < 1) return null;
    if (!/\s/.test((node.nodeValue || '')[range.startOffset - 1] || '')) return null;
    const r = range.cloneRange();
    try { r.setStart(node, range.startOffset - 1); } catch { return null; }
    return r;
  }

  /* ' (e.g. thalamus)' → ', e.g. thalamus'.
   *
   * Two changes rather than one, and they are given as two on purpose: eight
   * of the twenty-five in the sample have a link inside the brackets — `(e.g.
   * <a>ECOG performance status</a>)` — and replacing the phrase wholesale
   * would flatten it. The bracket at one end and the bracket at the other are
   * in different text nodes, and each of them is one character.
   *
   * Only where the brackets END the paragraph or list item. All twenty-five
   * do, which is presumably what the check is looking for, and it matters:
   * `X (e.g. Y) is common` would come out as `X, e.g. Y is common`, where the
   * comma that should close the aside has nowhere to go.
   *
   * Brackets inside the brackets are left alone — "(e.g. intra-arterial
   * delivery of vasodilating agents (such as …))" is a sentence to rewrite,
   * not a pair of characters to delete. */
  const BRACKETED_EG = /^(\s?)\((e\.g\.[^()]+)\)$/i;

  function inlineEG(text, f) {
    const m = BRACKETED_EG.exec(text);
    if (!m) return null;
    if (!fold(f.snippet || '').endsWith(fold(text).trim())) return null;
    return [
      { at: 0, remove: m[1].length + 1, insert: ', ' },
      { at: text.length - 1, remove: 1, insert: '' },
    ];
  }

  /* ————— and two that are a character in a place, rather than a change to
     the words under the highlight.

   * Each supplies its own range, because the gap in front of a tag, and the
   * space at either end of a heading, are not inside the words the highlight
   * is drawn on. */
  const SPOT_FIXES = {
    'Radiopaedia.CitationPrecedingSpace':
      { find: spaceBeforeCitation, say: 'Puts a space before the citation.' },
    'Radiopaedia.HeadingsSpacing':
      { find: headingEnds, say: 'Takes the space off the ends of the heading.' },
  };

  /* The space at either end of a heading: `<h4>Practical points </h4>`.
   *
   * That space is invisible to the editor, and every command aimed at it
   * alone misses. Measured, on TinyMCE in Chrome: `delete` on the space eats
   * the `s` before it, `insertText` over the last word and the space comes
   * back with a non-breaking space in its place, and `forwardDelete` pulls
   * the next paragraph up into the heading. What works is the whole text of
   * the heading selected and written again without the space — once the
   * selection starts and ends on visible letters, there is nothing for the
   * browser to move.
   *
   * Only where that text is one run, sitting directly in the heading. A
   * heading with a link or a bold word in it has its ends in two different
   * runs, or inside a tag, and writing a tag's whole text again is how a link
   * goes missing — see `wouldEmpty`. Those stay a thing to fix by hand.
   *
   * `show` is what the text draws, which is the space and not the heading:
   * the fix writes the whole run again, but what changes is the space. */
  function headingEnds(f) {
    const node = f.range.startContainer;
    const h = (node.nodeType === 1 ? node : node.parentElement)?.closest('h1,h2,h3,h4,h5,h6');
    if (!h) return null;
    const run = h.firstChild;
    if (!run || run !== h.lastChild || run.nodeType !== 3) return null;

    const text = run.nodeValue || '';
    const lead = /^\s*/.exec(text)[0].length;
    const trail = /\s*$/.exec(text)[0].length;
    if (lead === text.length || (!lead && !trail)) return null;

    const doc = run.ownerDocument;
    const span = (from, to) => {
      const r = doc.createRange();
      r.setStart(run, from);
      r.setEnd(run, to);
      return r;
    };
    const show = [];
    if (lead) show.push({ target: span(0, lead), insert: '' });
    if (trail) show.push({ target: span(text.length - trail, text.length), insert: '' });
    return { target: span(0, text.length), insert: text.slice(lead, text.length - trail), show };
  }

  /* A `HeadingsSpacing` finding whose heading has no space left at either
   * end in the editor.
   *
   * The usual case, not a rare one. TinyMCE drops an ordinary space at the
   * end of a block when it loads the article (tried on TinyMCE 6.8.3 with
   * kipps-scale: `<h4>Usage </h4>` comes into the editor as `Usage`, and
   * `getContent()` gives `<h4>Usage</h4>` back). The linter reads the
   * published article, which still has the space, so the finding is real,
   * and saving the article is the fix. A non-breaking space survives the
   * load, and that is the case `headingEnds` takes off. */
  function headingClean(f) {
    if (f?.condition !== 'Radiopaedia.HeadingsSpacing' || !f.range) return false;
    const node = f.range.startContainer;
    const h = (node.nodeType === 1 ? node : node.parentElement)?.closest('h1,h2,h3,h4,h5,h6');
    const text = h?.textContent || '';
    return !!text.trim() && text === text.replace(/^\s+|\s+$/g, '');
  }

  /* The gap in front of a reference marker — but only where the marker is a
   * reference.
   *
   * Two of the five in the sample are `<sup>-6</sup>`: the article says
   * 10⁻⁶, the check reads the superscript as prose and asks for a space that
   * would be wrong in the text. A citation is digits, and commas or hyphens
   * between digits; an exponent that opens with a minus sign is not one. */
  const CITATION_NUMBERS = /^\d+(?:\s*[,–-]\s*\d+)*$/;
  /* And a superscript on a unit is not a citation either.
   *
   * `cm<sup>3</sup>` is cubic centimetres, and the check reports it as a
   * reference with no space in front of it — three of the six findings of
   * this kind in the sample were exactly that. Writing the space would make
   * "cm 3" out of a volume.
   *
   * Both halves have to hold before it is taken for a unit: the superscript
   * is a plain 2 or 3, and the letters it sits on are a unit symbol. A
   * reference numbered 2 is common; one written directly against the letters
   * "cm" is not a thing that happens. */
  const SQUARED_OR_CUBED = /^[23]$/;
  const UNITS = new Set([
    'm', 'cm', 'mm', 'km', 'um', 'µm', 'nm',
    'l', 'ml', 'dl', 'cc', 's', 'ms',
    'g', 'kg', 'mg', 'ug', 'gy', 'sv', 'msv', 't', 'hz', 'khz', 'mhz',
  ]);

  function unitExponent(sup) {
    if (!SQUARED_OR_CUBED.test(tidy(sup.textContent || ''))) return false;
    const before = sup.previousSibling;
    if (!before || before.nodeType !== 3) return false;
    const m = /([\p{L}µ]+)$/u.exec(before.nodeValue || '');
    return !!m && UNITS.has(m[1].toLowerCase());
  }

  function spaceBeforeCitation(f) {
    const node = f.range.startContainer;
    const sup = (node.nodeType === 1 ? node : node.parentElement)?.closest('sup');
    if (!sup || !CITATION_NUMBERS.test(tidy(sup.textContent || ''))) return null;
    if (unitExponent(sup)) return null;

    /* Only where the thing in front of the marker is TEXT.
     *
     * The space belongs between the words and the marker, and getting it
     * there turns out to depend entirely on what is immediately in front.
     * Four ways of asking, all measured on a page with ordinary white-space
     * handling, which is what an article is:
     *
     *   a caret at the end of the text before it, insertHTML " "
     *       → a plain space, both sides untouched. This one.
     *   replacing the marker with " " + the marker
     *       → a plain space in front, and the space AFTER the marker rewritten
     *         to a non-breaking one, because the text following it moved.
     *   a caret between two tags (before the marker, after the link, or a
     *   fresh empty text node in the gap)
     *       → all three slide the caret into the link, and the space lands
     *         inside it: `<a>CT </a>`, a link whose words now end in a space.
     *   replacing the marker and the text after it, writing both out
     *       → the leading space is dropped on the way in.
     *
     * So where a citation sits directly against a tag — `…</a><sup>4</sup>` —
     * this offers nothing rather than one of those three. An editor can put
     * that space in by hand in a second; none of the three is a second's work
     * to undo. */
    const before = sup.previousSibling;
    if (!before || before.nodeType !== 3) return null;
    const text = before.nodeValue || '';
    if (!text || /\s$/.test(text)) return null;

    const target = sup.ownerDocument.createRange();
    try {
      target.setStart(before, text.length);
      target.setEnd(before, text.length);
    } catch { return null; }
    /* A space, through `insertHTML`, because `insertText` would put a
       non-breaking one here. The value is this constant and nothing else: no
       part of it comes from the article or from the linter. */
    return { target, insert: ' ', html: true };
  }


  /* ————— and the four that are about the markup rather than the words.

   * `<em>TERT</em>` with the italics taken off reads exactly as it did
   * before: the change is to the tags, and there is no corrected string to
   * show. So these are described rather than quoted, and they are applied
   * with `bold` and `italic` — the editor's own commands again, for the same
   * three reasons `insertText` was chosen over touching the DOM.
   *
   * Those commands TOGGLE. Run `italic` over a selection that is half
   * italicised and the whole of it comes out italic, which is the opposite of
   * what was asked for, so everything here is about making sure the selection
   * is exactly the formatted run and nothing else.
   */
  const MARKUP_FIXES = {
    'Radiopaedia.Emphasis': { tags: 'em, i', command: 'italic', say: 'Takes the italics off.' },
    'Radiopaedia.Strong': { tags: 'strong, b', command: 'bold', say: 'Takes the bold off.' },
    'Radiopaedia.StrongListColonPosition':
      { colon: true, command: 'bold', say: 'Moves the colon out of the bold.' },
    'Radiopaedia.CitationPunctuationSup':
      { find: supPunctuation, command: 'superscript',
        say: 'Moves the punctuation out of the superscript.' },
  };

  /* `<sup>1.</sup>` → `<sup>1</sup>.`: the full stop, comma, semicolon or
   * colon at the end of a citation, out of the superscript and onto the line.
   *
   * The superscript is toggled off over the punctuation alone, the way the
   * bold comes off a colon. Measured on TinyMCE in Chrome against the other
   * way of doing it — writing the citation out again with `insertHTML` — and
   * the toggle is the one that leaves nothing behind: `<sup>1</sup>.` at the
   * end of a paragraph, before a space, after a link, and after `12,13`
   * alike, where `insertHTML` turned the space after it into a non-breaking
   * one, or wrapped both halves in a span carrying the editor's font.
   *
   * Which citation: the one the highlight is in, when it is in one. The
   * finding is narrowed onto the quoted `1.`, and that is usually the
   * citation itself; when the same characters also occur in the prose, the
   * narrowing can land there instead, and then the paragraph is searched for
   * a citation that ends in punctuation and reads what the finding quoted —
   * and only one such citation will do. Two of them and this cannot tell
   * which was meant.
   *
   * `show` is what the text draws: the punctuation struck through inside the
   * superscript, and the same punctuation on a green tag after it. */
  const TRAILING_PUNCTUATION = /[.,;:]+\s*$/;

  function supPunctuation(f) {
    const supOf = (n) => (n.nodeType === 1 ? n : n.parentElement)?.closest('sup');
    const ends = (sup) => !sup.children.length && TRAILING_PUNCTUATION.test(sup.textContent || '');

    let sup = supOf(f.range.startContainer);
    if (!sup || !ends(sup)) {
      const all = f.home?.el ? [...f.home.el.querySelectorAll('sup')].filter(ends) : [];
      const same = all.filter((s) => flat(s.textContent || '') === flat(f.words || ''));
      const list = same.length ? same : all;
      if (list.length !== 1) return null;
      sup = list[0];
    }

    const run = sup.lastChild;
    if (!run || run.nodeType !== 3) return null;
    const text = run.nodeValue || '';
    const m = TRAILING_PUNCTUATION.exec(text);
    // A superscript that is nothing but punctuation is not a citation.
    if (!m || !text.slice(0, m.index).trim()) return null;

    const doc = run.ownerDocument;
    const target = doc.createRange();
    const after = doc.createRange();
    try {
      target.setStart(run, m.index);
      target.setEnd(run, text.length);
      after.setStart(run, text.length);
      after.collapse(true);
    } catch { return null; }
    return { target, show: [{ target, insert: '' }, { target: after, insert: m[0].trim() }] };
  }

  /* The element whose formatting this finding is about, as a range over its
   * whole contents — or nothing, which is the answer surprisingly often.
   *
   * Two conditions, and both earn their place on the real findings. The words
   * have to sit inside ONE `em`/`strong`: a third of the Emphasis findings
   * quote two of them with plain text in between — `<em>Neu</em> or receptor
   * tyrosine-protein kinase <em>erbB-2</em>` — and a toggle across that would
   * italicise the words between them. And the element has to hold exactly the
   * words the linter quoted, which is what tells `<strong>ovarian torsion</strong>`
   * from the `<strong> </strong>` sitting in the middle of a sentence that the
   * same check also reports.
   *
   * The whole element rather than the highlighted part of it, because the
   * trailing space inside `<em>Tityus trinitatis </em>` is inside the italics
   * too, and leaving it behind as `<em> </em>` would swap one finding for
   * another — that stray bold space is itself what half the Strong findings
   * are about.
   *
   * An element with tags inside it is refused. `<em>Buthus quinquestriatus
   * <sup>31</sup></em>` comes back from the command with an empty `style`
   * attribute on the `<sup>`, and an attribute this script did not mean to
   * add is not something to publish into somebody's article. */
  function wrapping(f, tags) {
    const node = f.range.commonAncestorContainer;
    const el = (node.nodeType === 1 ? node : node.parentElement)?.closest(tags);
    if (!el || el.children.length) return null;
    if (fold(el.textContent || '') !== fold(f.words || '')) return null;
    const r = el.ownerDocument.createRange();
    try { r.selectNodeContents(el); } catch { return null; }
    return r;
  }

  /* The colon at the end of a bold intro, and the whitespace after it: the
   * one stretch of that `<strong>` that should not be bold.
   *
   * `<strong>DWI: </strong>intratumoural` has the space inside the bold as
   * well, and unbolding the colon alone would leave `<strong> </strong>`
   * behind. Taking both is what makes `<strong>DWI</strong>: intratumoural`
   * rather than a second finding.
   *
   * The colon has to be in the LAST text of the element, with nothing but
   * space after it — which is what `/:\s*$/` on the whole element says. A
   * colon in the middle of a bold run is somebody's prose, not an intro. */
  function boldColon(range) {
    for (const piece of piecesOf(range)) {
      const el = piece.node.parentElement?.closest('strong, b');
      if (!el || !/:\s*$/.test(el.textContent || '')) continue;

      const text = piece.node.nodeValue || '';
      const at = text.lastIndexOf(':');
      if (at < piece.from || at >= piece.to) continue;
      // Anything after it inside the element would be left dangling.
      if (!/^\s*$/.test(text.slice(at + 1))) continue;

      const r = piece.node.ownerDocument.createRange();
      try {
        r.setStart(piece.node, at);
        r.setEnd(piece.node, text.length);
      } catch { return null; }
      return r;
    }
    return null;
  }

  /* What this finding would have the text read instead, or nothing at all.
   *
   * Called on every draw, so it stays cheap: a lookup, a `toString()` and a
   * handful of string operations on a phrase. It deliberately re-reads the
   * range every time rather than caching — the text under the highlight is
   * being edited while you look at it, and a proposal built a minute ago is a
   * proposal for a sentence that may no longer be there. */
  function proposal(f) {
    if (!f || f.state !== 'open' || !f.range || !f.narrowed) return null;

    const text = TEXT_FIXES[f.condition];
    if (text) {
      const range = (TAKES_THE_SPACE_BEFORE.has(f.condition) && withSpaceBefore(f.range))
        || f.range;
      let before;
      try { before = range.toString(); } catch { return null; }
      if (!before) return null;

      /* More than one reading, and none of them picked yet: there is nothing
         to write until you say which. The button still appears, because there
         IS a fix here — it is just that the next press opens the question
         rather than the editor. */
      const pick = CHOICES[f.condition]?.(before, f);
      if (pick && !pick.includes(f.chosen)) {
        /* Asked again where the answer is not one of the readings on offer.
           It cannot be, the way `openChoice` works — but a stale answer, to a
           file that has been edited since, should put the question back rather
           than quietly leave the finding with no fix at all. */
        return { say: `${pick.length} meanings — f to choose`, choose: pick };
      }

      /* A fix answers with the words as they should read, or — where one
         replacement would have to span a link — with the handful of separate
         changes that get there. */
      const out = text(before, f);
      if (!out) return null;
      const edits = Array.isArray(out) ? out : null;
      const after = edits ? applyEdits(before, edits) : out;
      if (!after || after === before) return null;

      /* Worked out here and not only on the press, so that a fix the editor
         would refuse is never offered in the first place. A button that
         appears and then says "fix it by hand" is worse than no button. The
         plan is worked out AGAIN on the press, because the paragraph is being
         edited while you look at it and the one made on the last redraw is a
         plan for the text as it was. */
      const plan = planText(range, before, after, edits);
      if (plan.trouble) return null;
      return {
        say: after,
        before,          // for the comparison the note draws on hover
        spots: plan.spots,   // for the same comparison, drawn in the text
        apply: () => {
          const now = planText(range, before, after, edits);
          return now.trouble || writeText(now);
        },
      };
    }

    const spot = SPOT_FIXES[f.condition];
    if (spot) {
      const where = spot.find(f);
      if (!where) return null;
      return { say: spot.say, spots: where.show || [where], apply: () => writeSpot(where) };
    }

    const spec = MARKUP_FIXES[f.condition];
    if (!spec) return null;
    if (spec.find) {
      const where = spec.find(f);
      if (!where) return null;
      return { say: spec.say, spots: where.show, apply: () => unformat(where.target, spec.command) };
    }
    const target = spec.colon ? boldColon(f.range) : wrapping(f, spec.tags);
    if (!target) return null;
    return { say: spec.say, apply: () => unformat(target, spec.command) };
  }

  /* The smallest edit that turns one string into the other: the common start
   * and the common end are not touched, and what is left in the middle is the
   * whole of the change. For the Oxford comma that is one character inserted
   * into a phrase of forty, and the thirty-nine others — links, abbreviations,
   * superscripts and all — are never selected, never replaced and never
   * noticed by the editor. */
  function narrow(before, after) {
    let head = 0;
    while (head < before.length && head < after.length && before[head] === after[head]) head++;
    let tail = 0;
    while (tail < before.length - head && tail < after.length - head &&
           before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
    return { at: head, remove: before.length - head - tail,
             insert: after.slice(head, after.length - tail) };
  }

  /* The pieces of text a Range actually covers, in order. Their contents
   * concatenated ARE `range.toString()`, which is what makes an offset into
   * that string something this can turn back into a place in the document. */
  function piecesOf(range) {
    const start = range.startContainer, end = range.endContainer;
    if (start === end && start.nodeType === 3) {
      return [{ node: start, from: range.startOffset, to: range.endOffset }];
    }
    const walker = range.commonAncestorContainer.ownerDocument
      .createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT);
    const out = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!range.intersectsNode(n)) continue;
      const from = n === start ? range.startOffset : 0;
      const to = n === end ? range.endOffset : (n.nodeValue || '').length;
      if (to > from) out.push({ node: n, from, to });
    }
    return out;
  }

  /* An offset into that concatenation, as a node and an offset in it.
   *
   * `bind` is what to do where the offset falls exactly between two pieces,
   * which is a place that exists twice: the end of one text node and the
   * start of the next are the same point in the string. The START of an edit
   * belongs to the piece that follows and the END of it to the piece before.
   * Read the other way round, an edit wholly inside one text node is taken
   * for one spanning two — which is how `<sup>21</sup>.` came to refuse the
   * deletion of a full stop that was never inside the superscript. */
  function placeAt(pieces, offset, bind) {
    let seen = 0;
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i];
      const len = p.to - p.from;
      const mine = bind === 'start' && i < pieces.length - 1
        ? offset < seen + len
        : offset <= seen + len;
      if (mine) return { node: p.node, offset: p.from + (offset - seen) };
      seen += len;
    }
    return null;
  }

  /* Write it.
   *
   * `insertText` rather than touching the DOM: it is the editor's own editing
   * command, so TinyMCE hears it, marks the form dirty and puts the change on
   * ITS undo stack — which means ctrl+Z works afterwards exactly as it does
   * for something you typed. A `textNode.nodeValue = …` would be invisible to
   * all three: the text would change on screen and the editor would go on
   * believing the article was untouched, which is how you press Save and save
   * nothing.
   *
   * It is also the reason nothing here needs `unsafeWindow`. Reaching into the
   * page's `tinymce` object would do the same job and would mean this script
   * could reach everything else in there too.
   *
   * The selection is left on what was written. That is not a flourish: you
   * asked for a change to a sentence you are reading, and the cursor sitting
   * on it is how you see which words moved. */
  /* `null` is what a successful write returns, so this cannot be written with
   * `??` — that would turn every success into the refusal below. */
  function applyFix(f) {
    const p = proposal(f);
    return p ? p.apply() : 'no fix for this one — it needs a person';
  }

  // The same change, done to a string: what the note prints.
  function applyEdits(text, edits) {
    let out = text;
    for (const e of [...edits].sort((a, b) => b.at - a.at)) {
      out = out.slice(0, e.at) + e.insert + out.slice(e.at + e.remove);
    }
    return out;
  }

  /* One edit, as a place in the document — or nothing, when it would have to
   * span more than one text node. That refusal is the whole guard on the
   * markup: a selection that stays inside one run of text cannot take a link
   * or a superscript with it. */
  function place(pieces, edit) {
    const from = placeAt(pieces, edit.at, 'start');
    const to = placeAt(pieces, edit.at + edit.remove, 'end');
    if (!from || !to || from.node !== to.node) return null;
    if (wouldEmpty(from.node, from.offset, to.offset)) return null;
    const doc = from.node.ownerDocument;
    if (!doc) return null;
    const target = doc.createRange();
    try {
      target.setStart(from.node, from.offset);
      target.setEnd(to.node, to.offset);
    } catch { return null; }
    return { target, insert: edit.insert, at: edit.at };
  }

  /* Would this edit take a tag with it?
   *
   * Staying inside one text node is not enough on its own. `<a>PSMA</a>` with
   * the whole of PSMA replaced is, to the browser, a link whose contents have
   * all been deleted — and it removes the link along with them. Measured, and
   * it was the right words with the link gone out of the article.
   *
   * So an edit covering the WHOLE text of an inline tag is refused. Changing
   * part of it is fine, and that is what nearly every rule does: the comma,
   * the hyphen, the first letter of a linked list item. */
  const INLINE_TAGS = 'a, em, i, strong, b, sup, sub, abbr, code, mark';

  function wouldEmpty(node, from, to) {
    const el = node.parentElement?.closest(INLINE_TAGS);
    if (!el || el.children.length) return false;
    return node === el.firstChild && node === el.lastChild
      && from === 0 && to === (node.nodeValue || '').length;
  }

  /* Taking a hyphen out is a deletion, not an insertion of nothing:
     `insertText` with an empty string is a no-op in some browsers, and a
     no-op that reports success is worse than a refusal.

     `html` is for one case and one value — see `spaceBeforeCitation`. Measured
     as well: `insertText` with a space at the end of a run of text writes a
     NON-BREAKING space, the browser being helpful about a space that would
     otherwise collapse. `insertHTML` with the same character writes the
     character. */
  const writeSpot = (spot) => spot.insert
    ? runCommand(spot.target, spot.html ? 'insertHTML' : 'insertText', spot.insert)
    : runCommand(spot.target, 'delete');

  const CROSSES = 'that change crosses the markup — fix it by hand';

  function planText(range, before, after, edits) {
    const pieces = piecesOf(range);

    /* One edit if one will do, and nearly always one will: the comma, the
       hyphen, the single letter. */
    const one = place(pieces, narrow(before, after));
    if (one) return { spots: [one] };

    /* Otherwise the fix's own account of what changes — which for the
       bracketed e.g. is two single characters at either end of a phrase with
       a link in the middle of it.

       They have to land in DIFFERENT text nodes, and they are applied back to
       front. Both conditions are about the same risk: a command rewrites the
       node it runs in, so an edit counted in a node that an earlier edit has
       already touched is counted in a node that may no longer be there. Edits
       sharing a node are the case `narrow` above already covers, and if that
       was refused for crossing the markup then these would be too. */
    if (!edits || edits.length < 2) return { trouble: CROSSES };

    const spots = edits.map((e) => place(pieces, e));
    if (spots.some((spot) => !spot)) return { trouble: CROSSES };
    if (new Set(spots.map((spot) => spot.target.startContainer)).size !== spots.length) {
      return { trouble: CROSSES };
    }

    spots.sort((a, b) => b.at - a.at);
    return { spots };
  }

  function writeText(plan) {
    for (const spot of plan.spots) {
      const trouble = writeSpot(spot);
      if (trouble) return trouble;
    }
    return null;
  }

  /* Bold or italics off the selection. The command is a toggle and the
   * selection was built to be exactly the formatted run, so off is what it
   * does — see `wrapping` and `boldColon` for how much work that is.
   *
   * `styleWithCSS` is turned off around it and put back as it was found.
   * With it on, taking the bold off a few words leaves
   * `<span style="font-weight:normal">` behind instead of simply ending the
   * `<strong>`, and a span carrying a style is not what the rule was asking
   * for. It is the editor's setting, not ours, which is why it is restored. */
  function unformat(target, command) {
    const doc = target.startContainer.ownerDocument;
    let was = null;
    try { was = doc.queryCommandState('styleWithCSS'); } catch { /* never mind */ }
    try { doc.execCommand('styleWithCSS', false, false); } catch { /* never mind */ }
    const trouble = runCommand(target, command);
    if (was !== null) {
      try { doc.execCommand('styleWithCSS', false, was); } catch { /* never mind */ }
    }
    return trouble;
  }

  /* Select it, and let the editor do it. Shared by both, because the part
   * that matters is the same either way: the editable has to hold the focus
   * or the command is run against whatever else does and lands somewhere
   * else entirely. */
  function runCommand(target, command, value) {
    const doc = target.startContainer.ownerDocument;
    const win = doc?.defaultView;
    if (!doc || !win) return 'the editor is not there any more';

    const node = target.startContainer;
    const host = (node.nodeType === 1 ? node : node.parentElement)
      ?.closest('[contenteditable="true"], body');
    try { win.focus(); } catch { /* another document's window: never mind */ }
    try { host?.focus({ preventScroll: true }); } catch { host?.focus(); }

    const sel = doc.getSelection();
    if (!sel) return 'the editor is not there any more';
    sel.removeAllRanges();
    sel.addRange(target);

    let wrote = false;
    try {
      wrote = value === undefined
        ? doc.execCommand(command)
        : doc.execCommand(command, false, value);
    } catch { wrote = false; }
    if (!wrote) {
      sel.removeAllRanges();
      return 'the editor refused the change — fix it by hand';
    }
    return null;
  }

  // ———————————————————————————————————————————————————————————— the stage

  GM_addStyle(`
    /* ————— Radiopaedia's own look, for the things of ours that sit on it.

       The button beside the title has copied their "Edit article" since it was
       written — ".btn.btn-flat", down to the numbers read off it. What did not
       was everything that FLOATS: the bar, the note, the banner, the two
       panels. Those were a dark tool parked on somebody else's page.

       These are the rest of the numbers, read off radiopaedia.org the same
       way rather than guessed:

         .btn.btn-default  #333, white, a 1px corner, 0 4px 8px of lift —
                           the one RadioUpdater's "Check all references" is,
                           and the one a button of ours is
         .btn.btn-flat     #ededed on #555, a 2px corner, a hairline border
                           going darker along the bottom, an inset highlight —
                           their "Edit article", which the button by the title
                           has copied since it was written
         .btn-primary      #a172f8, white, a 1px corner, 0 4px 8px of lift
         h1                #65419b
         body              "Open Sans", 12px on an 18px line
         a                 #41699b

       Two button faces, and which is which matters. The one by the TITLE sits
       among their own article buttons and is flat grey like them; everything
       on the bar and in the panels is an action of ours and wears their dark
       one. Hovering is the one number not theirs: their dark button does not
       change colour, and a bar you press a hundred times an afternoon has to
       answer when you point at it.

       The site is light and has no dark mode, and all of this sits ON the
       site, so neither does any of this any more. A dark panel over a white
       article is the thing that looks out of place, whatever the browser has
       been told to prefer. */
    :root {
      --rlx-face: #fff;              /* a surface of ours */
      --rlx-text: #555;              /* their body ink */
      /* Their hairline is for things that sit IN the page, where the page
         around them does the separating. Ours float over an article and have
         to draw their own edge, so this is darker than theirs on purpose, and
         the shadow under them is deeper than the one under a button. */
      --rlx-edge: rgba(0,0,0,.22);
      --rlx-lift: 0 4px 8px rgba(0,0,0,.1);     /* theirs, under a button */
      --rlx-float: 0 6px 20px rgba(0,0,0,.18);  /* ours, under a panel */
      /* A point over their body copy. Theirs is 12px because it is set in
         columns of prose; a bar of controls read at arm's length is not. 13 is
         one of their own sizes even so — it is what their Submit button uses. */
      --rlx-size: 13px;
      --rlx-line: 19px;
      --rlx-flat: #ededed;           /* their flat button, by the title */
      --rlx-btn: #333;               /* their default button, on ours */
      --rlx-btn-lit: #4a4a4a;        /* ours: they do not light up */
      --rlx-key: #a172f8;            /* their primary */
      --rlx-head: #65419b;           /* their headings */
      --rlx-type: "Open Sans", system-ui, -apple-system, sans-serif;
    }

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
    /* The same box in the editor's margin, dressed as the bar it turns into:
       its width, its purple edge along the top, Lint as wide as Done is, and
       the three small ones at the end as they are at the foot of the bar. */
    .rlx-btn-float.rlx-btn-margin { right:auto; display:flex; gap:4px; box-sizing:border-box;
      padding:.55em .6em; border:1px solid rgba(0,0,0,.3); border-top:3px solid var(--rlx-head);
      box-shadow:0 8px 28px rgba(0,0,0,.28); }
    .rlx-btn-margin .rlx-btn { flex:1 1 auto; justify-content:center; }

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

    /* A section with only old citations. The blue of a linter suggestion and
       not the amber, because the section is there and may well be fine: this
       is something to look at, not something Radiopaedia requires. */
    .rlx-chip-stale { border-left-color:var(--rlx-stale, #2563eb); font-weight:400; cursor:default; }
    .rlx-chip-stale:hover { background:#f7faff; }
    .rlx-chip-stale .rlx-chip-rel, .rlx-chip-stale:hover .rlx-chip-rel { color:var(--rlx-stale, #2563eb); }
    #rlx-thread.rlx-thread-stale path { stroke:var(--rlx-stale, #2563eb); }
    .rlx-rail-stale { flex:1 1 100%; }
    .rlx-rail-stale .rlx-rail-n { background:var(--rlx-stale, #2563eb); margin-right:2px; }
    .rlx-rail-slim .rlx-rail-stale { font-size:0; }
    .rlx-rail-slim .rlx-rail-stale .rlx-rail-n { font-size:12px; margin:0; }

    /* No room for words. A tab against the edge of the text and the heading in
       the tooltip: less than the chip said, and none of it a lie about where
       the section goes. */
    .rlx-rail-slim .rlx-chip { padding:0; border-left-width:8px; height:22px; }
    .rlx-rail-slim .rlx-chip-name, .rlx-rail-slim .rlx-chip-hush { display:none; }
    .rlx-rail-slim .rlx-rail-what, .rlx-rail-slim .rlx-rail-kind,
    .rlx-rail-slim .rlx-rail-more { display:none; }
    .rlx-rail-slim .rlx-chip-sub { margin-left:6px; }
    .rlx-rail-slim .rlx-rail-head { padding:2px 3px; gap:2px; }

    /* The line the copied heading goes on, drawn on the editor text itself.
       The chip's amber, because it is the same fact the chip was stating: a
       section Radiopaedia asks for that is not there yet. Fixed like
       everything else of ours — this marker never writes to the article DOM,
       not even here, where what you are looking at is somebody's unsaved
       work. */
    #rlx-paste { position:fixed; inset:0; pointer-events:none; z-index:99996;
      font-family:"Open Sans", system-ui, -apple-system, sans-serif; }
    #rlx-paste[hidden] { display:none; }
    #rlx-paste .rlx-paste-line {
      position:fixed; height:2px; border-radius:1px;
      background:var(--rlx-miss, #d97706);
    }
    /* The label hangs under its line and at the END of it. Over the line it
       covered the last sentence of the paragraph the new section comes after —
       the one that tells you whether this is really the right place — and at
       the near end it covered the heading the line is measured against, which
       is the landmark the whole thing is about. Headings are short and the
       column is wide, so the far end is the one place on that line where there
       is usually nothing at all. */
    #rlx-paste .rlx-paste-tag {
      position:fixed; display:flex; align-items:center; gap:6px;
      max-width:min(34em, 86vw); padding:3px 4px 3px 7px; border-radius:2px;
      background:var(--rlx-miss, #d97706); color:#fff; pointer-events:auto;
      box-shadow:0 1px 3px rgba(0,0,0,.25);
      font-size:12px; line-height:16px; font-weight:600;
    }
    #rlx-paste .rlx-paste-what { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    #rlx-paste .rlx-paste-where { font-weight:400; opacity:.85; white-space:nowrap; }
    #rlx-paste .rlx-paste-off {
      flex:0 0 auto; padding:0 3px; border:0; background:transparent; color:#fff;
      opacity:.75; font:inherit; font-size:13px; line-height:14px; cursor:pointer;
    }
    #rlx-paste .rlx-paste-off:hover { opacity:1; }

    #rlx-layer { position:fixed; inset:0; pointer-events:none; z-index:99997; }
    .rlx-mark { position:fixed; border-radius:1px; opacity:.5; }
    .rlx-mark.rlx-current { opacity:1; }

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

    /* The change Fix would make, in the text: the red of radioUpdater's
       renumbering preview over what goes, its green on what arrives. */
    .rlx-del { position:fixed; border-radius:2px; background:rgba(220,38,38,.2); }
    .rlx-del::after { content:''; position:absolute; left:0; right:0; top:55%;
      border-top:2px solid #b91c1c; }
    .rlx-ins-at { position:fixed; border-radius:1px; background:#15803d; }
    .rlx-ins, .rlx-gone {
      position:fixed; padding:0 4px; border-radius:2px; white-space:pre;
      background:#dcfce7; color:#15803d; text-decoration:none;
      box-shadow:0 0 0 1px currentColor inset;
      font:700 14px/18px "Open Sans", system-ui, -apple-system, sans-serif;
    }
    .rlx-gone { background:#fde2e2; color:#b91c1c; text-decoration:line-through; }

    #rlx-note {
      /* Border-box, so that a width set from the script (the margin it has to
         fit in) is the width it takes, padding and border included. */
      position:fixed; z-index:99999; max-width:min(30em, 78vw); box-sizing:border-box;
      padding:.6em .8em; border-radius:2px; border:1px solid var(--rlx-edge);
      border-left:4px solid;
      background:var(--rlx-face); color:var(--rlx-text); box-shadow:var(--rlx-float);
      font:var(--rlx-size)/var(--rlx-line) var(--rlx-type);
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
      font-size:12px; font-weight:600; text-transform:uppercase;
      letter-spacing:1.1px; opacity:.8; }
    #rlx-note .rlx-msg { margin-top:.35em; }
    /* The arrow back to words scrolled out of sight: a strip across the edge
       of the note that faces them. */
    #rlx-note .rlx-away { margin:-.6em -.8em .5em; padding:.4em .8em; cursor:pointer;
      font-size:13px; font-weight:700; background:rgba(127,127,127,.1); }
    #rlx-note .rlx-away:last-child { margin:.5em -.8em -.6em; }
    #rlx-note .rlx-away:hover { background:rgba(127,127,127,.2); }
    #rlx-note .rlx-hint { margin-top:.4em; font-size:13px; opacity:.62; }
    #rlx-note .rlx-fix { margin-top:.4em; padding:.25em .5em; border-radius:6px;
      background:rgba(127,127,127,.14); font-weight:600; }
    /* The two lines of a comparison. No grey box and no bold on these: the
       washes are what is being read here, and a fill behind them fights. */
    #rlx-note .rlx-fix-label { margin-top:.5em; font-size:12px; font-weight:600;
      text-transform:uppercase; letter-spacing:1.1px; opacity:.55; }
    #rlx-note .rlx-fix-was, #rlx-note .rlx-fix-now {
      margin-top:.1em; padding:.1em 0; background:transparent; font-weight:400; }
    #rlx-note .rlx-snippet { margin-top:.4em; padding-left:.6em; border-left:2px solid #e5e7eb;
      color:#4b5563; font-style:italic; }
    /* Said only when the words cannot be found in the editor: the note has
       nothing to point at, so it stands in the corner and this explains why
       it is there and what to press. */
    #rlx-note .rlx-alert { margin-top:.5em; padding:.35em .55em; border-radius:6px;
      border:1px solid rgba(180,83,9,.35); background:rgba(245,158,11,.14);
      color:#92400e; font-size:13px; line-height:1.35; }

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
         margins give it the whole width to centre in.

         One width, always. It used to be fit-content, which meant the bar
         changed size every time a button came or went, and the whole thing
         slid sideways under the pointer while you worked. Every button is on
         it at all times now — greyed where it does not apply — so the row has
         one width anyway; stating it outright is what keeps the two ends still
         as well. Measured, not guessed: the full row of buttons wants 1034px,
         and 112em at 13px is 1456, which leaves the status a fifth of the bar
         to say its piece in, where 100em left it barely a hundred pixels.
         Narrower than about 1050 and the last buttons wrap onto a second
         row, which is still the same shape every time. */
      position:fixed; left:0; right:0; margin:0 auto; bottom:18px; z-index:99999;
      display:flex; align-items:center; gap:.45em; flex-wrap:wrap; justify-content:center;
      width:min(112em, 96vw); padding:.5em .7em; border-radius:2px;
      /* Louder than the rest of the floating layer, and deliberately: this one
         is always there while you work, over somebody's article, and it has to
         be findable at a glance rather than merely separated from the page.
         The purple along the top is theirs — the colour of their headings, and
         of the word Lint at the other end of the bar. */
      border:1px solid rgba(0,0,0,.3); border-top:3px solid var(--rlx-head);
      background:var(--rlx-face); color:var(--rlx-text);
      box-shadow:0 8px 28px rgba(0,0,0,.28);
      font:600 var(--rlx-size)/var(--rlx-line) var(--rlx-type);
    }
    /* Their ".btn-default", at the smaller padding a bar of a dozen of them
       wants: same fill, same white, same 1px corner, same lift. */
    #rlx-bar button { flex:0 0 auto; padding:5px 10px; border-radius:1px;
      border:1px solid transparent;
      background:var(--rlx-btn); color:#fff; font:inherit; cursor:pointer;
      box-shadow:var(--rlx-lift); }
    #rlx-bar button:hover:not([disabled]) { background:var(--rlx-btn-lit); }
    /* Grey, not faded. A black button at 40% opacity over a white bar is a
       grey button either way, but it is also a dimmer version of the thing
       next to it, and at a glance the row reads as half-lit rather than as
       some-of-these-apply. Their own flat grey says it in the site's own
       vocabulary, and the lift comes off: nothing is standing up to be
       pressed. The title still says why, so pointing at a dead button
       answers the question it raises. */
    #rlx-bar button[disabled] { background:var(--rlx-flat); color:#aaa;
      box-shadow:none; cursor:default; }
    /* The three that have no fill to lose — the arrows, the flip, the close —
       only go pale. Done is a filled button and greys like the rest. */
    #rlx-bar .rlx-step[disabled], #rlx-bar .rlx-close[disabled],
    #rlx-bar .rlx-flip[disabled] { background:transparent; color:#bbb; }

    /* Done is the one you press a hundred times an afternoon, and it was the
       same grey as Re-lint, which you press once. Green rather than the
       severity's own colour: red on the button you are meant to press reads as
       a warning about pressing it, and green is already what the finding turns
       when you do. */
    /* Shaped like their primary — the 1px corner and the lift — and filled
       green rather than their purple, which is the one place this parts from
       the site on purpose. Two languages are at work on this bar: theirs for
       the chrome, and this script's own for the VERDICTS, where red, amber,
       blue and green mean something and have meant it since the first
       version. Done is a verdict, and green is what the finding turns when you
       press it. (Their #a172f8 is one word away, in --rlx-key, for anyone who
       would rather have the site's.) */
    #rlx-bar .rlx-primary { background:#059669; color:#fff; border-radius:1px;
      border-color:transparent; box-shadow:var(--rlx-lift); }
    #rlx-bar .rlx-primary:hover:not([disabled]) { background:#047857; color:#fff; }

    /* The arrows are arrows, not buttons: no fill until you point at them,
       and the bar's own ink rather than the buttons' white. */
    #rlx-bar .rlx-step { background:transparent; border-color:transparent;
      box-shadow:none; color:var(--rlx-text);
      padding:.28em .5em; font-size:18px; line-height:1; }
    #rlx-bar .rlx-step:hover:not([disabled]) { background:rgba(0,0,0,.06); color:#333; }

    /* The counting and the sentence, in one zone of their own, and that zone
       is the only part of the bar that is elastic. Everything to the right of
       it — every button — therefore stands in the same place at all times,
       whatever the left-hand end has to say for itself. The counting is
       nowhere near one width — a position and up to four tallies, 152px at
       full stretch and 28 once a single severity is left. Without this, each
       of those changes pushed a dozen buttons along; with it they take their
       room from the sentence instead, which is the one thing here that can
       afford to be shorter. flex-basis 0 and
       min-width 0 so the zone is measured as though it were empty: the row's
       width is the buttons' width, and no amount of counting can wrap it. */
    #rlx-bar .rlx-left { display:flex; align-items:center; gap:.45em;
      flex:1 1 0; min-width:0; overflow:hidden; }
    /* Its natural width, and it never gives any of it up: whatever it has to
       say, it says, and the sentence next door pays for it. A fixed 12em
       reserve was tried here and taken out again — on a narrow window the
       reserve came to more than the whole zone, and the sentence was left
       with nothing at all. tabular-nums so that 1/34 and 12/34 are the same
       width, which is the only steadiness this needs. */
    #rlx-bar .rlx-count { display:flex; align-items:center; gap:.42em; flex:0 0 auto;
      font-variant-numeric:tabular-nums; }
    #rlx-bar .rlx-of { font-weight:600; }
    /* A severity is a colour in this script — on the highlight, on the note,
       on the button by the title. Here too, which is three words shorter. */
    #rlx-bar .rlx-tally { display:inline-flex; align-items:center; gap:.3em; }
    #rlx-bar .rlx-dot { width:.62em; height:.62em; border-radius:50%; }
    #rlx-bar .rlx-sepdot { opacity:.4; }
    #rlx-bar .rlx-known { opacity:.65; }
    /* Their headings are #65419b, and their own uppercase buttons carry a
       wide letter-spacing. One word in both says whose bar this is. */
    #rlx-bar .rlx-title { font-weight:600; flex:0 0 auto; color:var(--rlx-head);
      text-transform:uppercase; letter-spacing:1.3px; }
    /* flex-basis 0, so the line is measured as though the status were not
       there: it never pushes itself onto a second row, it takes whatever room
       is left over and ends in an ellipsis. Wrapping is still on for a window
       narrow enough that the buttons alone will not fit — better a second row
       than a button off the edge — but the sentence cannot cause it.

       It sits in the middle of the bar, sharing a zone with the counting,
       and that is the whole reason the controls hold still. It is the one
       part that gives ground: the counting beside it can grow and everything
       to its right stays where your hand left it, because the bar itself no
       longer changes size. Put the sentence at the far end instead and the
       arithmetic runs the other way — the count gains a digit and twelve
       buttons move. */
    #rlx-bar .rlx-status { flex:1 1 0; min-width:0; overflow:hidden;
      text-overflow:ellipsis; white-space:nowrap; color:#777; font-weight:400;
      padding:0 .4em; }
    /* Two labels that change while you walk: '+ Name' becomes '+ Acronym',
       and the log counts up. Held at the wider of each, so neither nudges the
       row along when it changes under the pointer. */
    #rlx-bar [data-act="propose"] { min-width:7.4em; }
    #rlx-bar [data-act="dispute"] { min-width:5.6em; }
    #rlx-bar .rlx-sep { width:1px; align-self:stretch; background:var(--rlx-edge);
      flex:0 0 auto; }

    /* The three buttons borrowed from the box by the title while the bar is
       up. Laid out as if they were the bar's own, and coloured as they were in
       the box when they are on. */
    #rlx-bar .rlx-borrowed { display:contents; }
    #rlx-bar .rlx-auto.rlx-on { background:var(--rlx-ink, #2563eb); color:#fff; }
    #rlx-bar .rlx-sweep-toggle.rlx-flagged { background:#dc2626; color:#fff; }
    .rlx-staged .rlx-group { display:none !important; }

    /* Groups of the bar: nothing of their own along the bottom. */
    #rlx-bar .rlx-g-head, #rlx-bar .rlx-g-walk, #rlx-bar .rlx-g-tools,
    #rlx-bar .rlx-g-extra { display:contents; }
    #rlx-bar .rlx-sep-extra { display:none; }

    /* The bar in the margin: a column as wide as the note under it, in
       blocks rather than in whatever rows the buttons happened to wrap into.

         LINT 3/14 ● ● ●            ×
         [‹] [    ✓ Done    ] [›]
         [  Ignore  ] [   Undo   ]
         ─────────────────────────
         [  ✎ Fix   ] [   Copy   ]
         [ ✎ Prompt ] [  ⚑ Log   ]
         [  + Name  ] [ + Meaning ]
         ─────────────────────────
                  Re-lint ↻ ❝ ⊘

       One filled button only, Done, in its green, and Fix in the bar's black
       when it has something to write: everything else is drawn in outline, so
       the eye finds the two presses that matter without reading the labels.
       Done sits between the arrows because walking is the thing done a
       hundred times. The four at the foot are settings more than actions and
       are small. The flip has nothing to flip to in the margin. */
    #rlx-bar.rlx-side { right:auto; margin:0; display:flex; flex-direction:column; flex-wrap:nowrap;
      align-items:stretch; gap:6px; padding:.55em .6em; }
    #rlx-bar.rlx-side .rlx-g-head { display:flex; align-items:baseline; gap:.5em;
      padding-right:1.6em; }
    #rlx-bar.rlx-side .rlx-left { flex:1 1 auto; flex-wrap:wrap; overflow:visible; }
    #rlx-bar.rlx-side .rlx-status { flex:1 0 100%; white-space:normal; padding:0; }
    #rlx-bar.rlx-side .rlx-status:empty { display:none; }
    #rlx-bar.rlx-side .rlx-close { position:absolute; top:.3em; right:.3em; }
    #rlx-bar.rlx-side .rlx-flip { display:none; }
    #rlx-bar.rlx-side .rlx-sep { display:block; width:auto; height:1px; align-self:stretch; }
    #rlx-bar.rlx-side .rlx-sep-nav { display:none; }

    #rlx-bar.rlx-side .rlx-g-walk { display:grid; gap:4px;
      grid-template-columns:2.4em 1fr 1fr 2.4em; }
    #rlx-bar.rlx-side [data-act="prev"] { grid-area:1 / 1; }
    #rlx-bar.rlx-side [data-act="done"] { grid-area:1 / 2 / 2 / 4; }
    #rlx-bar.rlx-side [data-act="next"] { grid-area:1 / 4; }
    #rlx-bar.rlx-side [data-act="ignore"] { grid-area:2 / 1 / 3 / 3; }
    #rlx-bar.rlx-side [data-act="undo"] { grid-area:2 / 3 / 3 / 5; }

    #rlx-bar.rlx-side .rlx-g-tools { display:grid; gap:4px;
      grid-template-columns:repeat(2, minmax(0, 1fr)); }
    #rlx-bar.rlx-side [data-act="propose"], #rlx-bar.rlx-side [data-act="meaning"] {
      order:1; min-width:0; }
    #rlx-bar.rlx-side [data-act="dispute"] { min-width:0; }

    #rlx-bar.rlx-side .rlx-g-extra { display:flex; justify-content:flex-end; gap:4px; }

    #rlx-bar.rlx-side button { padding:4px 6px; background:#fff; color:#333;
      border:1px solid #ccc; box-shadow:none; white-space:nowrap;
      overflow:hidden; text-overflow:ellipsis; }
    #rlx-bar.rlx-side button:where(:hover:not([disabled])) { background:#f2f2f2; color:#111; }
    #rlx-bar.rlx-side button[disabled] { background:#fff; color:#c4c4c4; border-color:#ebebeb; }
    #rlx-bar.rlx-side .rlx-step { font-size:16px; line-height:1; padding:3px 0; }
    #rlx-bar.rlx-side .rlx-primary:not([disabled]) { background:#059669; color:#fff;
      border-color:transparent; }
    #rlx-bar.rlx-side .rlx-primary:not([disabled]):hover { background:#047857; }
    #rlx-bar.rlx-side [data-act="fix"]:not([disabled]) { background:var(--rlx-btn); color:#fff;
      border-color:transparent; }
    #rlx-bar.rlx-side [data-act="fix"]:not([disabled]):hover { background:var(--rlx-btn-lit); }
    #rlx-bar.rlx-side .rlx-g-extra button { padding:2px 7px; font-size:12px;
      color:#555; border-color:#ddd; }
    #rlx-bar.rlx-side .rlx-g-extra .rlx-on,
    #rlx-bar.rlx-side .rlx-g-extra .rlx-flagged { color:#fff; border-color:transparent; }
    #rlx-bar.rlx-side .rlx-close { padding:0 .35em; border:none; color:#666;
      background:transparent; font-size:16px; }
    #rlx-bar .rlx-close, #rlx-bar .rlx-flip { background:transparent;
      border-color:transparent; box-shadow:none; color:var(--rlx-text);
      font-size:17px; line-height:1; padding:.3em .5em; }
    #rlx-bar .rlx-close:hover, #rlx-bar .rlx-flip:hover {
      background:rgba(0,0,0,.06); color:#333; }

    #rlx-banner {
      position:fixed; left:50%; top:18px; transform:translateX(-50%); z-index:99999;
      display:flex; align-items:center; gap:.6em;
      max-width:min(42em, 94vw); padding:.7em 1em; border-radius:2px;
      border:1px solid var(--rlx-edge);
      background:var(--rlx-face); color:var(--rlx-text); box-shadow:var(--rlx-float);
      font:600 var(--rlx-size)/var(--rlx-line) var(--rlx-type); cursor:pointer;
      animation: rlx-banner-in .18s ease-out;
    }
    #rlx-banner .rlx-tick { color:#059669; font-size:18px; line-height:1; }
    #rlx-banner .rlx-sub { display:block; margin-top:.15em; font-size:13px; opacity:.75; }
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
       be written into an article. Nothing is put inside the editor from a
       chip: the corrected reference goes to the clipboard instead. */
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

    /* The retraction chips. The same chip as above — same box, same place in
       the form — in the three colours it can mean something in. There is no
       fourth for "fine": a clean reference gets no chip at all, because forty
       greens are what teaches a person to stop reading the one red. */
    .rlx-flag-retracted  { background:rgba(220,38,38,.18); color:#dc2626; }
    .rlx-flag-retracted:hover { background:#dc2626; color:#fff; }
    .rlx-flag-concern    { background:rgba(217,119,6,.18); color:#b45309; }
    .rlx-flag-concern:hover { background:#b45309; color:#fff; }
    .rlx-flag-reinstated { background:rgba(37,99,235,.16); color:#2563eb; }
    .rlx-flag-reinstated:hover { background:#2563eb; color:#fff; }
    /* The count in the toolbar, which is red only when there is something to
       be red about: a sweep that found nothing is still a sweep that ran. */
    .rlx-sweep-toggle.rlx-flagged { background:rgba(220,38,38,.18); color:#dc2626; }

    #rlx-cite-note {
      position:fixed; z-index:99999; width:min(38em, 84vw);
      padding:.7em .9em; border-radius:2px; border:1px solid var(--rlx-edge);
      border-left:4px solid #6b7280;
      background:var(--rlx-face); color:var(--rlx-text); box-shadow:var(--rlx-float);
      font:var(--rlx-size)/var(--rlx-line) var(--rlx-type);
    }
    #rlx-cite-note .rlx-cite-head { display:flex; gap:.5em; align-items:baseline;
      font-size:12px; text-transform:uppercase; letter-spacing:.04em; opacity:.8; }
    #rlx-cite-note .rlx-cite-why { margin-top:.35em; }
    #rlx-cite-note .rlx-cite-label { margin-top:.7em; font-size:12px;
      text-transform:uppercase; letter-spacing:.04em; opacity:.55; }
    #rlx-cite-note .rlx-cite-text { margin-top:.15em; padding:.3em .5em; border-radius:6px;
      background:rgba(127,127,127,.10); word-break:break-word; }
    /* The two words that differ, rather than the two paragraphs that contain
       them: a reference is eighty words long and the thing wrong with it is
       usually one of them. Unscoped, because the note asks the same question
       about a correction that the citation panel asks about a reference. */
    .rlx-was { background:rgba(220,38,38,.18); border-radius:2px; }
    .rlx-now { background:rgba(5,150,105,.20); border-radius:2px; }
    #rlx-cite-note .rlx-cite-acts { display:flex; gap:.4em; margin-top:.7em; flex-wrap:wrap; }
    #rlx-cite-note button {
      padding:3px 8px; border-radius:1px; border:1px solid transparent;
      background:var(--rlx-btn); color:#fff; cursor:pointer;
      box-shadow:var(--rlx-lift);
      font:600 12px/17px var(--rlx-type);
    }
    #rlx-cite-note button:hover { background:var(--rlx-btn-lit); }

    /* ————— where the rewritten paragraph comes back in. */
    #rlx-answer {
      position:fixed; inset:0; z-index:100000; display:flex;
      align-items:center; justify-content:center; padding:1em;
      background:rgba(42,41,42,.42);
      font:var(--rlx-size)/var(--rlx-line) var(--rlx-type);
    }
    #rlx-answer .rlx-a-panel {
      width:min(46em, 94vw); max-height:88vh; overflow:auto;
      padding:.9em 1.1em 1em; border-radius:2px; border:1px solid var(--rlx-edge);
      background:var(--rlx-face); color:var(--rlx-text); box-shadow:0 10px 40px rgba(0,0,0,.3);
    }
    #rlx-answer .rlx-a-head { display:flex; align-items:baseline; gap:.6em; }
    #rlx-answer .rlx-a-title { flex:1 1 auto; font-size:12px; font-weight:600;
      text-transform:uppercase; letter-spacing:1.1px; color:var(--rlx-head); }
    #rlx-answer .rlx-a-x { background:transparent; border:0; color:inherit;
      font-size:19px; line-height:1; padding:0 .2em; cursor:pointer; opacity:.6; }
    #rlx-answer .rlx-a-x:hover { opacity:1; }
    #rlx-answer .rlx-a-hint { margin-top:.2em; font-size:13px; opacity:.6; }
    #rlx-answer .rlx-a-bridge { display:flex; gap:.45em; margin-top:.6em; align-items:stretch; }
    #rlx-answer .rlx-a-url { flex:1 1 auto; min-width:0; padding:.4em .55em;
      border:1px solid rgba(127,127,127,.45); border-radius:2px;
      background:transparent; color:inherit; font:inherit; font-size:12px; }
    #rlx-answer .rlx-a-url:focus { outline:2px solid var(--rlx-key); outline-offset:-1px; }
    #rlx-answer .rlx-a-text {
      display:block; width:100%; box-sizing:border-box; margin-top:.6em;
      padding:.5em .6em; border:1px solid rgba(127,127,127,.45); border-radius:2px;
      background:transparent; color:inherit; font:inherit; resize:vertical;
    }
    #rlx-answer .rlx-a-text:focus { outline:2px solid var(--rlx-key); outline-offset:-1px; }
    #rlx-answer .rlx-a-say { margin-top:.5em; font-size:13px; min-height:1.2em; }
    #rlx-answer .rlx-a-no { color:#b91c1c; font-weight:600; }
    #rlx-answer .rlx-a-yes { color:#047857; font-weight:600; }
    #rlx-answer .rlx-a-line { margin-top:.1em; padding:.1em 0; }
    #rlx-answer .rlx-fix-label { margin-top:.5em; font-size:12px; font-weight:600;
      text-transform:uppercase; letter-spacing:1.1px; opacity:.55; }
    #rlx-answer .rlx-a-acts { display:flex; align-items:center; gap:.45em; margin-top:.9em; }
    #rlx-answer button { flex:0 0 auto; padding:5px 10px; border-radius:1px;
      border:1px solid transparent;
      background:var(--rlx-btn); color:#fff; font:inherit; font-weight:600;
      cursor:pointer; box-shadow:var(--rlx-lift); }
    #rlx-answer button:hover:not([disabled]) { background:var(--rlx-btn-lit); }
    #rlx-answer button[disabled] { opacity:.4; cursor:default; }
    #rlx-answer .rlx-a-primary { background:var(--rlx-key); border-color:transparent; }
    #rlx-answer .rlx-a-primary:hover:not([disabled]) { background:#8f5cf0; }

    /* ————— the choice between two meanings.

       Same shape as the log below and for the same reason — it is a question,
       and a question cannot be asked by the note, which fades and lets the
       pointer through the moment you reach for it. Smaller, because it holds
       a handful of lines rather than a form. */
    #rlx-pick {
      position:fixed; inset:0; z-index:100000; display:flex;
      align-items:center; justify-content:center; padding:1em;
      background:rgba(42,41,42,.42);
      font:var(--rlx-size)/var(--rlx-line) var(--rlx-type);
    }
    #rlx-pick .rlx-p-panel {
      width:min(34em, 94vw); max-height:86vh; overflow:auto;
      padding:.9em 1.1em 1em; border-radius:2px; border:1px solid var(--rlx-edge);
      background:var(--rlx-face); color:var(--rlx-text); box-shadow:0 10px 40px rgba(0,0,0,.3);
    }
    #rlx-pick .rlx-p-head { font-size:12px; font-weight:600; text-transform:uppercase;
      letter-spacing:1.1px; color:var(--rlx-head); }
    #rlx-pick .rlx-p-word { margin-top:.2em; font-weight:700; }
    #rlx-pick .rlx-p-list { margin-top:.7em; display:flex; flex-direction:column; gap:.35em; }
    #rlx-pick button {
      display:flex; align-items:baseline; gap:.6em; width:100%; text-align:left;
      padding:6px 12px; border-radius:2px;
      border:1px solid rgba(0,0,0,.1); border-bottom-color:rgba(0,0,0,.25);
      background:var(--rlx-flat); color:var(--rlx-text); font:inherit; cursor:pointer;
      box-shadow:inset 0 1px 0 rgba(255,255,255,.2), 0 1px 2px rgba(0,0,0,.05);
    }
    #rlx-pick button:hover, #rlx-pick button:focus-visible {
      background:var(--rlx-key); border-color:transparent; color:#fff; outline:none;
    }
    #rlx-pick .rlx-p-key { flex:0 0 auto; width:1.4em; height:1.4em; border-radius:2px;
      background:rgba(0,0,0,.08); font-size:12px; font-weight:600;
      display:inline-flex; align-items:center; justify-content:center; }
    #rlx-pick button:hover .rlx-p-key, #rlx-pick button:focus-visible .rlx-p-key {
      background:rgba(255,255,255,.25); }
    #rlx-pick .rlx-p-hint { margin-top:.7em; font-size:13px; opacity:.6; }

    /* ————— the disagreement log.

       The one box in this script you type into, and that is why it is a box of
       its own and not a few more lines in the note. The note gets out of the
       way the moment the pointer comes near it — faded and click-through, so
       the text underneath stays selectable — which is exactly what a form must
       not do. So: a panel in the middle, with the page dimmed behind it, and
       the stage's own keys off while it is open.

       It is the only thing here that sits above the bar (z-index 100000 against
       99999): while you are writing down why a rule is wrong, the rule is the
       only thing on screen that matters. */
    #rlx-dispute {
      position:fixed; inset:0; z-index:100000; display:flex;
      align-items:center; justify-content:center; padding:1em;
      background:rgba(42,41,42,.42);
      font:var(--rlx-size)/var(--rlx-line) var(--rlx-type);
    }
    #rlx-dispute .rlx-d-panel {
      width:min(42em, 94vw); max-height:86vh; overflow:auto;
      padding:.9em 1.1em 1.1em; border-radius:2px; border:1px solid var(--rlx-edge);
      background:var(--rlx-face); color:var(--rlx-text); box-shadow:0 10px 40px rgba(0,0,0,.3);
    }
    #rlx-dispute .rlx-d-head { display:flex; align-items:baseline; gap:.6em; }
    #rlx-dispute .rlx-d-title { font-weight:600; flex:1 1 auto; color:var(--rlx-head);
      text-transform:uppercase; letter-spacing:1.1px; font-size:12px; }
    #rlx-dispute .rlx-d-x { background:transparent; border:0; color:inherit;
      font-size:19px; line-height:1; padding:0 .2em; cursor:pointer; opacity:.6; }
    #rlx-dispute .rlx-d-x:hover { opacity:1; }

    /* What gets recorded without you typing it: the rule, the words, the line.
       Shown because a record you cannot see is a record you cannot trust. */
    #rlx-dispute .rlx-d-about { margin-top:.8em; padding:.55em .7em; border-radius:8px;
      border-left:3px solid #9ca3af; background:rgba(127,127,127,.09); }
    #rlx-dispute .rlx-d-where { font-size:13px; text-transform:uppercase;
      letter-spacing:.04em; opacity:.7; }
    #rlx-dispute .rlx-d-msg { margin-top:.25em; }
    #rlx-dispute .rlx-d-words { margin-top:.4em; font-weight:600;
      font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:14px;
      word-break:break-word; }
    #rlx-dispute .rlx-d-snippet { margin-top:.4em; padding-left:.6em;
      border-left:2px solid #e5e7eb; color:#4b5563; font-style:italic; }

    #rlx-dispute .rlx-d-label { display:block; margin-top:.85em; margin-bottom:.2em;
      font-size:13px; text-transform:uppercase; letter-spacing:.04em; opacity:.6; }
    #rlx-dispute textarea {
      display:block; width:100%; box-sizing:border-box; padding:.45em .55em;
      border:1px solid rgba(127,127,127,.45); border-radius:8px;
      background:transparent; color:inherit; font:inherit; resize:vertical;
    }
    #rlx-dispute textarea:focus { outline:2px solid var(--rlx-key); outline-offset:-1px; }
    #rlx-dispute .rlx-d-acts { display:flex; align-items:center; gap:.45em;
      margin-top:.8em; flex-wrap:wrap; }
    #rlx-dispute button { flex:0 0 auto; padding:5px 10px; border-radius:1px;
      border:1px solid transparent;
      background:var(--rlx-btn); color:#fff; font:inherit; font-weight:600;
      cursor:pointer; box-shadow:var(--rlx-lift); }
    #rlx-dispute button:hover { background:var(--rlx-btn-lit); }
    /* Their primary. Recording a disagreement is not a verdict on a finding,
       so there is nothing here for the script's own green to mean. */
    #rlx-dispute .rlx-d-primary { background:var(--rlx-key); color:#fff;
      border-color:transparent; border-radius:1px; box-shadow:var(--rlx-lift); }
    #rlx-dispute .rlx-d-primary:hover { background:#8f5cf0; color:#fff; }
    #rlx-dispute .rlx-d-say { font-size:13px; opacity:.75; }
    #rlx-dispute .rlx-d-none { margin-top:.8em; opacity:.75; }

    #rlx-dispute .rlx-d-log { margin-top:1.1em; padding-top:.7em;
      border-top:1px solid rgba(127,127,127,.28); }
    #rlx-dispute .rlx-d-loghead { display:flex; align-items:center; gap:.45em;
      flex-wrap:wrap; }
    #rlx-dispute .rlx-d-count { flex:1 1 auto; font-size:13px; text-transform:uppercase;
      letter-spacing:.04em; opacity:.6; }
    #rlx-dispute .rlx-d-tools { display:flex; gap:.4em; flex-wrap:wrap; }
    #rlx-dispute .rlx-d-tools button { font-size:13px; padding:.3em .6em; }
    #rlx-dispute .rlx-d-rows { margin-top:.5em; max-height:16em; overflow:auto; }
    #rlx-dispute .rlx-d-row { display:flex; align-items:baseline; gap:.5em;
      padding:.35em 0; border-top:1px solid rgba(127,127,127,.16); }
    #rlx-dispute .rlx-d-row:first-child { border-top:0; }
    #rlx-dispute .rlx-d-what { flex:1 1 auto; min-width:0; }
    #rlx-dispute .rlx-d-rule { font-size:13px; opacity:.7; }
    #rlx-dispute .rlx-d-why { font-size:14px; }
    /* The × on a row is a mark on that row, not one more thing to press:
       a dozen black squares down the side of a list is a wall. */
    #rlx-dispute .rlx-d-row button { font-size:12px; padding:.2em .45em; opacity:.6;
      background:transparent; color:var(--rlx-text); box-shadow:none; }
    #rlx-dispute .rlx-d-row button:hover { opacity:1; background:rgba(0,0,0,.06); }

  `);

  const stage = {
    slug: null,
    findings: [],
    hidden: {},       // what the lists answered: out of the walk, not out of the count
    roots: [],
    i: -1,
    history: [],      // for "undo": {i, state}
    layer: null, note: null, bar: null,
    said: null,       // what the last action had to say, until you move
    diff: false,      // are you pointing at Fix?
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
    /* The four groups — the heading, the walk, the tools and the extras — are
       wrappers that take no part in the layout of the bar along the bottom
       (`display:contents`): there it is one row, as it always was. In the
       margin each becomes a block of its own; see `.rlx-side` in the styles. */
    stage.bar.innerHTML = `
      <span class="rlx-g-head">
        <span class="rlx-title">Lint</span>
        <span class="rlx-left">
          <span class="rlx-count"></span>
          <span class="rlx-status"></span>
        </span>
      </span>
      <span class="rlx-sep rlx-sep-nav"></span>
      <span class="rlx-g-walk">
        <button data-act="prev" class="rlx-step" title="Previous (k, or Alt+K while typing)">&lsaquo;</button>
        <button data-act="next" class="rlx-step" title="Next (j, or Alt+J while typing)">&rsaquo;</button>
        <button data-act="done" class="rlx-primary" title="Done (s, or Alt+S while typing)">&#10003; Done</button>
        <button data-act="ignore" title="Ignore (x, or Alt+X while typing)">Ignore</button>
        <button data-act="undo" title="Undo the last one (u)">Undo</button>
      </span>
      <span class="rlx-sep rlx-sep-tools"></span>
      <span class="rlx-g-tools">
        <button data-act="fix" title="Write the correction into the editor (f)">&#9998; Fix</button>
        <button data-act="copy" title="Copy the message (c)">Copy</button>
        <button data-act="rewrite" title="Copy a prompt for rewriting this paragraph (r)">&#9998; Prompt</button>
        <button data-act="propose" title="Add this to the shared list (p)">+ Name</button>
        <button data-act="meaning" title="Say what this acronym stands for (e)">+ Meaning</button>
        <button data-act="dispute" title="The rule is wrong here: write it down (d)">&#9873; Log</button>
      </span>
      <span class="rlx-sep rlx-sep-extra"></span>
      <span class="rlx-g-extra">
        <button data-act="reload" title="Ask the linter again">Re-lint</button>
        <span class="rlx-borrowed"></span>
      </span>
      <button data-act="flip" class="rlx-flip" title="Move the bar to the other edge (t)">&#8645;</button>
      <button data-act="close" class="rlx-close" title="Close (Esc)">&times;</button>`;
    document.body.appendChild(stage.bar);

    /* The box by the title — in the corner, in the editor — has nothing to
       say while the bar is up: Lint is Re-lint here, and the rail and the
       automatic preview belong to the article page. It steps aside, and the
       three of its buttons that still mean something here come over to the
       bar: the forced re-read, the citation chips and the retraction check.
       The same buttons, moved rather than copied, so whatever paints them
       goes on painting them; they go back when the bar closes. */
    document.documentElement.classList.add('rlx-staged');
    const borrowed = stage.bar.querySelector('.rlx-borrowed');
    for (const el of [forceBtn, citesToggle, sweepToggle, linksToggle]) if (el) borrowed.appendChild(el);

    placeBar(true);
    stage.bar.addEventListener('click', (e) => {
      const what = e.target.closest('[data-act]')?.dataset.act;
      if (what) act(what);
    });

    /* Pointing at Fix asks what it would do, and the note answers. One pair of
       listeners on the bar rather than a pair per button, the same way the
       clicks are handled; `focusin` and `focusout` are there so that the
       answer is not reserved for people using a mouse. */
    const over = (e, on) => {
      if (e.target.closest?.('[data-act="fix"]')) showDiff(on);
    };
    stage.bar.addEventListener('mouseover', (e) => over(e, true));
    stage.bar.addEventListener('mouseout', (e) => over(e, false));
    stage.bar.addEventListener('focusin', (e) => over(e, true));
    stage.bar.addEventListener('focusout', (e) => over(e, false));

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

  function showDiff(on) {
    if (stage.diff === on) return;
    stage.diff = on;
    placeNote();
  }

  function destroyStage() {
    if (!stage.live) return;
    stage.live = false;
    closeDispute();
    closePick();
    closeAnswer();
    document.documentElement.classList.remove('rlx-staged');
    if (button?.isConnected && forceBtn) button.after(forceBtn);
    if (group?.isConnected) {
      for (const el of [citesToggle, sweepToggle, linksToggle]) if (el) group.appendChild(el);
    }
    stage.layer?.remove(); stage.note?.remove(); stage.bar?.remove();
    removeEventListener('scroll', scheduleDraw, true);
    removeEventListener('resize', scheduleDraw);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousemove', onMove, true);
    stage.findings = []; stage.hidden = {}; stage.i = -1; stage.history = [];
    stage.said = null; stage.diff = false;
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

  /* Where a Range's coordinates start. Inside an iframe they are measured
   * against the iframe's own window, so its position on the page goes back in;
   * in a contenteditable they are page coordinates already. */
  const offsetOf = (f) => (f.frame ? f.frame.getBoundingClientRect() : { left: 0, top: 0 });

  /* How much of the text's box can be seen, right now: the narrowest of
   * everything that clips it. Null when nothing does — the layer is fixed, so
   * the window has already done that job.
   *
   * Measured on every draw, unlike the chain itself, because the whole point
   * of these boxes is that they move — but once per draw per root, not once
   * per finding. Every finding anchored in the same root holds the same chain
   * array, so that array is the key: thirty findings in one editor measure two
   * boxes between them instead of sixty, and `draw` runs on every frame of a
   * scroll. `clipMemo` is open only for the length of one draw; asked outside
   * one, this measures afresh. */
  let clipMemo = null;

  function clipOf(f) {
    if (!f.clips?.length) return null;
    if (clipMemo?.has(f.clips)) return clipMemo.get(f.clips);
    let left = -Infinity, top = -Infinity, right = Infinity, bottom = Infinity;
    for (const el of f.clips) {
      if (!el.isConnected) continue;
      const r = el.getBoundingClientRect();
      left = Math.max(left, r.left); top = Math.max(top, r.top);
      right = Math.min(right, r.right); bottom = Math.min(bottom, r.bottom);
    }
    const box = left === -Infinity ? null : { left, top, right, bottom };
    clipMemo?.set(f.clips, box);
    return box;
  }

  /* A rectangle cut down to what the box lets through, or null if that is
   * nothing. */
  function clipped(x, y, w, h, clip) {
    if (!clip) return { x, y, w, h };
    const x1 = Math.max(x, clip.left), y1 = Math.max(y, clip.top);
    const x2 = Math.min(x + w, clip.right), y2 = Math.min(y + h, clip.bottom);
    if (x2 <= x1 || y2 <= y1) return null;
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }

  const inside = (x, y, clip) => !clip ||
    (x >= clip.left && x <= clip.right && y >= clip.top && y <= clip.bottom);

  /* The lines a finding covers, in page coordinates, ready to draw — and
   * deliberately NOT cut to the visible box yet. Two reasons. A line only half
   * on screen would come back half as tall, and the underline, which is drawn
   * at the bottom of what it is given, would be drawn through the middle of
   * the words; and `draw` compares these boxes against each other to decide
   * which of two findings on one phrase keeps it, a decision that has no
   * business changing as you scroll. The cut happens once, on the mark. */
  function lineBoxes(f) {
    const off = offsetOf(f);
    let rects;
    try { rects = f.range.getClientRects(); } catch { return { lines: [] }; }

    const spans = [];
    for (const r of rects) {
      if (!r.width || !r.height) continue;
      spans.push({ x: r.left + off.left, y: r.top + off.top, w: r.width, h: r.height });
    }
    return { lines: mergeLines(spans) };
  }

  const overlaps = (a, b) =>
    Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x) &&
    Math.min(a.y + a.h, b.y + b.h) > Math.max(a.y, b.y);

  /* The split is only the memo: one draw measures each box once, and the memo
     is closed again whatever happens inside, so a throw cannot leave the next
     frame reading boxes from this one. */
  function draw() {
    if (!stage.live) return;
    clipMemo = new Map();
    try { drawNow(); } finally { clipMemo = null; }
  }

  function drawNow() {
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
      const { lines } = lineBoxes(f);
      const clip = clipOf(f);
      if (k !== stage.i && lines.some((s) => lit.some((l) => overlaps(l, s)))) continue;

      for (const s of lines) {
        /* A line under the words, in the severity's colour, rather than a
         * wash over them. The wash put red on the text twice over — once for
         * an error, once for what Fix would take out — and the two could not
         * be told apart. Under the words, the text keeps its own colour, and
         * red ON the text means only one thing: this goes.
         *
         * Thicker and at full strength on the finding you are on, thinner
         * and fainter on the rest. A few pixels longer than the words at
         * either end, so that a finding of one character — a semicolon —
         * still has a line you can see. */
        const thick = k === stage.i ? 3 : 2;
        // Not out of the box the words are in. A line scrolled out of it has
        // nothing left after the cut and is simply not drawn.
        const r = clipped(s.x - PAD_X, s.y + s.h - PAD_Y, s.w + PAD_X * 2, thick, clip);
        if (!r) continue;
        const { x, y, w, h } = r;
        const mark = document.createElement('div');
        mark.className = 'rlx-mark' + (k === stage.i ? ' rlx-current' : '');
        mark.style.cssText = `left:${x}px; top:${y}px; width:${w}px; height:${h}px;` +
                             `background:${c.ink};`;
        stage.layer.appendChild(mark);
      }
    }
    if (!drawChanges(cur)) drawCaret(cur);
    placeNote();
  }

  /* What Fix would do, drawn in the text, the way radioUpdater shows a
   * citation about to be renumbered: the characters it takes out struck
   * through in red where they stand, and what it puts in on a green tag just
   * after them, raised half a line so the words underneath stay readable. A
   * pure insertion also gets a green rule at the exact place it goes in.
   *
   * Both are on the layer above the editor, not in it: nothing in the article
   * changes until f is pressed. Drawn for the current finding only, and only
   * where `proposal` has worked out the edit to the character — the same
   * spots `f` would write. */
  const VISIBLE_SPACE = '␣';
  // A space at either end of a tag would be no mark at all.
  const visible = (text) => text.replace(/^[  ]+|[  ]+$/g,
    (s) => VISIBLE_SPACE.repeat(s.length));

  function drawChanges(f) {
    const would = f?.state === 'open' ? proposal(f) : null;
    if (!would?.spots?.length) return false;
    const off = offsetOf(f);
    const clip = clipOf(f);
    const put = (el, x, y, w, h) => {
      el.style.left = `${x}px`; el.style.top = `${y}px`;
      if (w != null) { el.style.width = `${w}px`; el.style.height = `${h}px`; }
      stage.layer.appendChild(el);
    };

    for (const spot of would.spots) {
      const range = spot.target;

      if (!range.collapsed) {
        let rects = [];
        try { rects = [...range.getClientRects()]; } catch { /* stale: drawn next time */ }
        let struck = 0;
        for (const r of rects) {
          if (!r.width || !r.height) continue;
          // Cut to the box, like the marks: the words it strikes through are
          // behind the same edge.
          const cut = clipped(r.left + off.left - 1, r.top + off.top,
                              r.width + 2, r.height, clip);
          if (!cut) continue;
          const del = document.createElement('div');
          del.className = 'rlx-del';
          put(del, cut.x, cut.y, cut.w, cut.h);
          struck++;
        }
        /* Characters that take no room — the space at the end of a heading,
           which the browser does not draw — have nothing to strike through.
           They get a red tag of their own where they are, as radioUpdater
           does for a citation it cannot colour. */
        /* A tag carries words, and half a word is worse than none, so these
           are dropped whole the moment the place they belong to is out of
           sight rather than cut like the rules are. */
        const at = struck ? null : pointOf(range);
        if (at && inside(at.x + off.left, at.y + off.top + at.h / 2, clip)) {
          const gone = document.createElement('del');
          gone.className = 'rlx-gone';
          gone.textContent = visible(range.toString());
          put(gone, at.x + off.left + 1, at.y + off.top);
          gone.style.top = `${at.y + off.top - gone.offsetHeight / 2}px`;
        }
      }

      if (!spot.insert) continue;
      const at = pointOf(range);
      if (!at) continue;
      const x = at.x + off.left, y = at.y + off.top;
      if (!inside(x, y + at.h / 2, clip)) continue;

      if (range.collapsed) {
        const cut = clipped(x - 1, y, 2, at.h, clip);
        if (cut) {
          const rule = document.createElement('div');
          rule.className = 'rlx-ins-at';
          put(rule, cut.x, cut.y, cut.w, cut.h);
        }
      }
      const ins = document.createElement('ins');
      ins.className = 'rlx-ins';
      ins.textContent = visible(spot.insert);
      put(ins, x + 1, y);
      ins.style.top = `${y - ins.offsetHeight / 2}px`;
    }
    return true;
  }

  /* Where the end of a range is on screen: its x, and the top and height of
   * the line it is on. A collapsed range answers with a rectangle of no width
   * in some browsers and with no rectangle at all in others, so the
   * character on either side of the point is asked as well. */
  function pointOf(range) {
    const node = range.endContainer, at = range.endOffset;
    const ask = (from, to, edge) => {
      const r = node.ownerDocument.createRange();
      try { r.setStart(node, from); r.setEnd(node, to); } catch { return null; }
      const rects = r.getClientRects();
      const rect = edge === 'right' ? rects[rects.length - 1] : rects[0];
      return rect && rect.height ? { x: rect[edge], y: rect.top, h: rect.height } : null;
    };
    const len = node.nodeType === 3 ? (node.nodeValue || '').length : 0;
    return ask(at, at, 'left')
      || (node.nodeType === 3 && at > 0 ? ask(at - 1, at, 'right') : null)
      || (node.nodeType === 3 && at < len ? ask(at, at + 1, 'left') : null);
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

    const off = offsetOf(f);
    const clip = clipOf(f);
    const x = r.right + off.left, y = r.top + off.top;
    // The caret carries the character that is missing, in a tag above the
    // rule, so it goes or stays whole rather than being cut in half.
    if (!inside(x, y + r.height / 2, clip)) return;
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
    const over = (r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    // Except on the arrow back to the words, which is there to be clicked.
    const back = note.querySelector('.rlx-away');
    note.classList.toggle('rlx-ghost',
      over(note.getBoundingClientRect()) && !(back && over(back.getBoundingClientRect())));
  }

  const onMove = (e) => ghostNote(e, null);

  // The small grey word over one of the two lines of a comparison.
  function label(words) {
    const el = document.createElement('div');
    el.className = 'rlx-fix-label';
    el.textContent = words;
    return el;
  }

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

    /* The phrase as it should read. The message quotes it as it is, which
       leaves the difference between the two for the reader to find.

       Read off the editor where that can be done — `proposal` is the text
       under the highlight with the rule applied to it, which is the exact
       string `f` would write — and off the linter's own quote otherwise. The
       second is still worth printing on a finding that could not be anchored:
       it says what the answer is, even where nothing can write it. */
    const would = proposal(f);
    const reads = would ? would.say : (!settled ? f.point?.fixed : null);
    if (reads) {
      /* Point at Fix and the one line becomes two: the words as they stand
         with what goes lit red, and the words as they would stand with what
         arrives lit green. The same comparison the citation chips draw, off
         the same `wordDiff` — printing both forms and leaving you to find the
         difference is printing the problem twice.

         Only where there is a before to compare against. Taking the italics
         off a word changes no words at all, and two identical lines under a
         red and a green label would be a comparison that says nothing. */
      const runs = stage.diff && would?.before ? wordDiff(would.before, would.say) : null;
      if (runs) {
        stage.note.append(
          label('as it reads'),
          diffLine(runs, 'was', 'rlx-was', would.before, 'rlx-fix rlx-fix-was'),
          label('as it would read'),
          diffLine(runs, 'now', 'rlx-now', would.say, 'rlx-fix rlx-fix-now'));
      } else {
        const fix = document.createElement('div');
        fix.className = 'rlx-fix';
        fix.style.color = c.ink;
        fix.textContent = reads;
        stage.note.appendChild(fix);
      }
      if (would) {
        const how = document.createElement('div');
        how.className = 'rlx-hint';
        how.textContent = would.before
          ? 'Press f to write it in, or point at Fix to see what changes.'
          : 'Press f to write it in. Ctrl + Z in the editor takes it back.';
        stage.note.appendChild(how);
      }
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

    /* The five that need the sentence written again say so where the
       corrected text would otherwise stand. Nothing else on the note tells
       you that this one is not going to be answered by a keystroke. */
    /* A heading the editor has already trimmed. See `headingClean`: the
       space is in the published article and not in the form, so there is
       nothing for `f` to take off, and without this line the note reads as
       a finding nobody can act on. */
    if (!settled && !would && headingClean(f)) {
      const line = document.createElement('div');
      line.className = 'rlx-hint';
      line.textContent = 'The editor has already taken the space off. It goes from the article ' +
        'when you save. Press s to mark it done.';
      stage.note.appendChild(line);
    }

    if (!settled && !would && REWRITES.has(f.condition)) {
      const line = document.createElement('div');
      line.className = 'rlx-hint';
      line.textContent = 'This one wants the sentence written again. Press r for a prompt.';
      stage.note.appendChild(line);
    }

    /* A meaning offered and not landed yet. The same sentence the lists get,
       for the same reason: between the click and the merge there is a pull
       request, and "have I already done this one?" should not mean "go and
       look at your pull requests". */
    if (!settled && f.condition === 'Radiopaedia.Acronyms' && f.words) {
      const when = proposedMeanings()[flat(f.words)];
      if (when) {
        const line = document.createElement('div');
        line.className = 'rlx-hint';
        line.textContent =
          `A meaning for '${f.words}' was proposed on ${when} — waiting for it to land.`;
        stage.note.appendChild(line);
      }
    }

    // Settled, and still on screen: the one thing left to say is how to leave.
    if (settled) {
      const hint = document.createElement('div');
      hint.className = 'rlx-hint';
      hint.textContent = 'Alt + j for the next one, Alt + k to go back.';
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

    /* Nothing to anchor to. The note is about to park itself in the corner
     * with no highlight under it, and the commonest reason is a stale cached
     * run: the findings are from the text as it was, the editor has moved on.
     * The bar says "snippet not found" in four words; this says what to do
     * about it, next to the finding it happened to. */
    if (!f.range && !settled) {
      const stale = document.createElement('div');
      stale.className = 'rlx-alert';
      stale.textContent = 'The snippet for this finding could not be found in the editor text. '
                        + 'These results may come from an expired cache — press the Re-lint '
                        + 'button on the bar to check the article again.';
      stage.note.appendChild(stale);
    }

    const spot = highlightBounds(f);
    stage.note.style.maxWidth = '';
    if (!spot) {
      stage.note.style.left = '14px';
      stage.note.style.top = '14px';
      return;
    }

    /* Scrolled out of sight, the words leave the note standing at the edge of
     * the window with nothing beside it. An arrow on that edge says which way
     * they went, and a click on it brings them back. */
    const away = whereAway(f, spot);
    if (away) {
      const back = document.createElement('div');
      back.className = 'rlx-away';
      back.style.color = c.ink;
      back.textContent = away === 'up'
        ? '▲ The words are further up — click to go back to them'
        : '▼ The words are further down — click to go back to them';
      back.addEventListener('click', () => { bringIntoView(f); scheduleDraw(); });
      if (away === 'up') stage.note.prepend(back); else stage.note.append(back);
    }

    /* In the margin to the left of the article when there is room for it,
     * level with the highlight: nothing in the text is covered, and your eye
     * only has to go sideways. Measured after the width is capped, because a
     * narrower note is a taller one. */
    const margin = gutterOf(f);
    if (margin) {
      stage.note.style.maxWidth = `${margin.width}px`;
      const n = stage.note.getBoundingClientRect();
      const { top } = notePlacement(spot, n.width, n.height, true);
      stage.note.style.left = `${margin.right - n.width}px`;
      stage.note.style.top = `${top}px`;
      return;
    }
    const n = stage.note.getBoundingClientRect();
    const { left, top } = notePlacement(spot, n.width, n.height);
    stage.note.style.left = `${left}px`;
    stage.note.style.top = `${top}px`;
  }

  /* Above or below the part of the article you can see, or neither. What you
   * can see is the window, and no more of it than the text's own box lets
   * through — the same box the highlights are cut to, so the note says "scroll
   * up" exactly when the line it belongs to has gone under the edge, and not
   * only when it has left the window. */
  function whereAway(f, spot) {
    let top = 0, bottom = innerHeight;
    const clip = clipOf(f);
    if (clip) {
      top = Math.max(top, clip.top);
      bottom = Math.min(bottom, clip.bottom);
    }
    if (spot.bottom <= top) return 'up';
    if (spot.top >= bottom) return 'down';
    return null;
  }

  /* The empty column to the left of the page, if it is wide enough for the
   * note — and for the bar, which stands at the top of the same column.
   *
   * The page is a box centred in the window, and the article is somewhere
   * inside it. Going up from the editor, every ancestor holds the article, and
   * the outermost one that does not fill the window is that box: its left
   * edge is where the margin ends. An ancestor as wide as the window is the
   * page itself and says nothing; a page with no box at all leaves no margin,
   * and the note goes back to sitting beside the words. */
  const NOTE_MIN = 200;   // narrower than this and the note is a column of single words

  function gutterOf(f) {
    return marginOf(f.frame
      || (f.range && (f.range.startContainer.nodeType === 1
        ? f.range.startContainer : f.range.startContainer.parentElement))
      || (f.home?.frame || f.home?.el));
  }

  // The same column, for the editor as a whole rather than one finding in it.
  const editorMargin = () => marginOf(stage.roots[0]?.frame || stage.roots[0]?.root);

  function marginOf(start) {
    if (!start?.isConnected || start.ownerDocument !== document) return null;

    let edge = Infinity;
    for (let n = start; n && n !== document.body && n !== document.documentElement;
         n = n.parentElement) {
      const r = n.getBoundingClientRect();
      if (r.width && r.width < innerWidth - 40) edge = Math.min(edge, r.left);
    }
    const gap = 12;
    const width = Math.min(edge - gap * 2, 440);
    return Number.isFinite(edge) && width >= NOTE_MIN ? { right: edge - gap, width } : null;
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

    /* In the margin, when there is one: at the top of the column the note
     * moves up and down in, its buttons on as many rows as that width needs.
     * Asked on every frame, not four times a second like the rest — it is a
     * walk up a dozen ancestors, and a window being resized should not leave
     * the bar standing in a margin that has just gone. Without a margin the
     * bar is the one along the bottom (or the top) of the window. */
    const side = editorMargin();
    // Into the margin or out of it: the edge it stands on changes, so measure now.
    if (!!side !== stage.bar.classList.contains('rlx-side')) force = true;
    stage.bar.classList.toggle('rlx-side', !!side);
    stage.bar.style.left = side ? `${side.right - side.width}px` : '';
    stage.bar.style.width = side ? `${side.width}px` : '';

    const now = performance.now();
    if (!force && now - barMeasured < 250) return;
    barMeasured = now;

    const top = side ? true : barIsTop();
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

  function notePlacement(spot, w, h, aside) {
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
    // In the margin it is beside the text whatever its height: only the top is asked for.
    if (aside) return clamp({ left: edge, top: spot.top });

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
    }

    /* What you did, and what the lists answered for you, said in words rather
     * than counted in the counter. They are a different kind of number: the
     * counter is where you are, and it has to be one width, because the thing
     * beside it is read while you work and the row has to hold still. These
     * are a remark about the session, they can run to three or four words
     * each, and the place for a remark is the sentence slot — the one part of
     * the bar built to give ground and end in an ellipsis. */
    const aside = [];
    if (!open.length) {
      const done = stage.findings.filter((x) => x.state === 'done').length;
      const ignored = stage.findings.filter((x) => x.state === 'ignored').length;
      if (done) aside.push(`${done} fixed`);
      if (ignored) aside.push(`${ignored} ignored`);
    }
    aside.push(...knownSaid(stage.hidden || {}));

    /* Anything the last action had to say about itself, until you move: a
       fix the editor would not take is a thing to read, and a thing that must
       not vanish on the next redraw. `goTo` clears it. */
    let status = stage.said || '';
    if (status) { /* said, and it stands */ }
    else if (!stage.findings.length) status = 'No findings: the article is clean.';
    // A settled finding has no snippet in the text by definition — saying it
    // "cannot be found" about the one you have just fixed reads as a fault.
    else if (f && f.state !== 'open' && open.length) status = 'Alt + j for the next one';
    else if (f && f.state === 'open' && !f.range) status = 'snippet not found in the editor text';
    // The remark is the quietest thing on the bar and gives way to all of it.
    // Nothing is lost by that: the one message that outlasts a keystroke is
    // the one `goTo` clears, so stepping on puts the remark back.
    else status = aside.join(' · ');
    const says = stage.bar.querySelector('.rlx-status');
    says.textContent = status;
    says.title = status;
    placeBar();

    /* Every button, every time — greyed where it does not apply.
     *
     * They used to come and go, each one appearing exactly when it worked.
     * That is tidy and it is unusable: the row changed width a dozen times a
     * minute, the bar is centred, so half of it slid sideways under the
     * pointer, and the button you were reaching for was somewhere else by the
     * time you got there. Now the row is fixed furniture and the state is in
     * the colour. What a dead button costs is the question "why can't I press
     * that?", so each one answers it in its own title: the reason is the
     * thing you wanted to know, and it is never further away than the
     * pointer you already have on it. */
    const settle = (name, why, label) => {
      const b = stage.bar.querySelector(`[data-act="${name}"]`);
      if (!b) return;
      b.disabled = !!why;
      b.title = why || label;
    };
    const none = !f ? 'Nothing selected' : null;
    const alone = open.length < 2 ? 'Nothing else is open' : null;

    settle('prev', alone, 'Previous (k, or Alt+K while typing)');
    settle('next', alone, 'Next (j, or Alt+J while typing)');
    settle('done', none, 'Done (s, or Alt+S while typing)');
    settle('ignore', none, 'Ignore (x, or Alt+X while typing)');
    settle('copy', none, 'Copy the message (c)');
    settle('undo', stage.history.length ? null : 'Nothing to undo',
           'Undo the last one (u)');

    /* Offered where there is one right answer and the words to apply it to
       have been found — which, on most findings, there is not. */
    settle('fix', proposal(f) ? null
      : headingClean(f) ? 'Nothing to fix here: the editor has already taken the space off'
      : 'No automatic fix for this one',
           'Write the correction into the editor (f)');

    // Live only where there is a word to offer: a finding one of the lists
    // could have answered, whose word is in neither that file nor your own
    // list of things already proposed. It says which list it would go to,
    // and keeps the wider of its two labels' widths either way.
    const offer = f && f.state === 'open' && !proposed()[fold(f.propose || '')] ? f.propose : null;
    const on = offer ? LISTS[f.list] : null;
    const add = stage.bar.querySelector('[data-act="propose"]');
    if (add) {
      add.disabled = !on;
      add.textContent = on ? on.button : '+ Name';
      add.title = on ? `Add '${offer}' to the shared ${on.of} (p)`
                     : 'No word here to put on a shared list';
    }

    /* On the five checks that ask for the sentence again, and only while the
       finding is open: a paragraph you have already dealt with is not one to
       go and have rewritten. */
    settle('rewrite',
           f && f.state === 'open' && REWRITES.has(f.condition)
             ? null : 'This rule does not want the sentence rewritten',
           'Copy a prompt for rewriting this paragraph (r)');

    /* Live on an acronym the expansions file does not name yet, on its first
       use, once. Not where the file could not be read at all: that is "we do
       not know", and inviting a line for a word that may well be in there
       already is the same mistake `propose` avoids next door. */
    const meant = stage.bar.querySelector('[data-act="meaning"]');
    if (meant) {
      const ask = !!f && f.state === 'open' && f.condition === 'Radiopaedia.Acronyms'
        && !!f.words && EXPANSIONS.entries != null && !meanings(f.words).length
        && firstUse(f) && !proposedMeanings()[flat(f.words)];
      meant.disabled = !ask;
      meant.title = ask ? `Say what '${f.words}' stands for (e)`
                        : 'No acronym here that wants a meaning';
    }

    /* How many findings you have written off as the rule's fault, on the
     * button that opens them. A log you cannot see the size of is a log you
     * forget you are keeping — and the whole point of it is to be read back
     * once there is enough in it to be worth somebody's time. */
    const log = stage.bar.querySelector('[data-act="dispute"]');
    if (log) {
      const n = disputeCount();
      log.textContent = n ? `⚑ Log ${n}` : '⚑ Log';
      log.title = f && f.state === 'open'
        ? 'The rule is wrong here: write it down (d)'
        : 'What you have written down, and the two ways out of it (d)';
    }
  }

  // ————————————————————————————————————————————————— navigation and actions

  function goTo(k) {
    stage.said = null;
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
    // The meaning you picked belonged to the fix, not to the finding: a
    // reopened finding asks again rather than quietly reusing the answer.
    stage.findings[p.i].chosen = null;
    stage.findings[p.i].state = p.state;
    anchor(stage.findings, stage.roots);
    goTo(p.i);
  }

  /* What follows a fix, however it was asked for. Kept apart from `act`
   * because the choice between several meanings is answered in a panel, long
   * after the keystroke that opened it, and the two paths have to end the
   * same way. */
  function settleFix(k, f, trouble) {
    if (trouble) { stage.said = trouble; updateBar(); return; }
    stage.history.push({ i: k, state: f.state });
    f.state = 'done';
    f.range = null;
    draw();
    updateBar();
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

      /* Written, and done with — immediately, not when the re-anchor catches
       * up seven hundred milliseconds later. In between, the proposal would
       * still be on offer and a second press would write the comma in twice.
       *
       * `done` rather than a state of its own: a finding whose text now reads
       * the way the rule asked IS fixed, however the words got there. `u`
       * reopens it the same as any other, and Ctrl + Z in the editor is what
       * takes the text back — the two are separate on purpose, because the
       * editor's undo is the editor's and this script does not own it. */
      case 'fix': {
        const k = stage.i;
        const f = stage.findings[k];
        if (!f) return;
        const p = proposal(f);
        if (!p) { stage.said = 'no fix for this one — it needs a person'; updateBar(); return; }
        // A fix that is a question first: nothing is written until it is
        // answered, and the answer comes back through `settleFix` as well.
        if (p.choose) return openChoice(k, f, p.choose);
        return settleFix(k, f, p.apply());
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
      /* The box, and the log under it. Not disabled when there is no finding
       * in hand: with the walk over it opens on the log alone, which is where
       * Copy Markdown and Download CSV live. */
      case 'dispute': return openDispute();
      /* The question, on the clipboard. Nothing is sent and nothing is
       * written: where it goes from there is yours, and so is what comes
       * back — a rewritten paragraph is pasted into the editor by hand, the
       * same as a corrected citation. */
      case 'rewrite': {
        const k = stage.i;
        const f = stage.findings[k];
        if (!f || !REWRITES.has(f.condition)) return;
        navigator.clipboard?.writeText(rewritePrompt(f));
        stage.said = 'prompt copied';
        openAnswer(k, f);
        updateBar();
        return;
      }

      /* The counterpart of `propose`, and the other answer to the same
       * finding: `p` says this acronym needs no spelling out, `e` says here is
       * what it spells out to. Same gesture either way — the line goes to the
       * clipboard, the file opens on GitHub, and what reaches the repository
       * is what you type into it. `ACRONYM = ` rather than the bare word,
       * because the line wants finishing and this is half of it. */
      case 'meaning': {
        const f = stage.findings[stage.i];
        if (!f || f.condition !== 'Radiopaedia.Acronyms' || !f.words) return;
        navigator.clipboard?.writeText(`${f.words} = `);
        rememberMeaning(f.words);
        window.open(EXPANSIONS.editUrl, '_blank', 'noopener');
        updateBar();
        placeNote();
        return;
      }
      case 'flip': return setBarTop(!barIsTop());
      /* `force` here means what it means on the ↻, and that is the point:
         before `cache=refresh` existed this button skipped only this tab's
         copy, so a re-lint after saving your fixes came back from the linter's
         own copy word for word unchanged. It costs one read of the article. */
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

    /* Nothing while you are typing in the log — not even the Alt shortcuts,
     * which are exempt from `isTyping` further down precisely so that they
     * work inside the editor. The box has its own two keys and answers for
     * itself; Esc there closes the box, not the stage. */
    if (disputeIsOpen() || pickBox || answerBox) return;

    /* With Alt the shortcuts work even while you are typing in the editor.
     *
     * The same letters as on the page, not the arrows. Alt + arrow is how you
     * move a word at a time on macOS and Alt + Backspace is how you delete
     * one, and a linter that eats both takes the two keys you use most while
     * rewriting the sentence it is complaining about.
     *
     * Keyed on `e.code`, the physical key, because `e.key` is the composed
     * character: on macOS Option+j arrives as '∆' and Option+k as '˚', so a
     * lookup by `e.key` would never match. `preventDefault` is what stops
     * those characters from being typed. */
    if (e.altKey) {
      const m = { KeyJ: 'next', KeyK: 'prev', KeyS: 'done', KeyX: 'ignore',
                  KeyD: 'dispute', KeyF: 'fix', KeyE: 'meaning', KeyR: 'rewrite',
                  Enter: 'done', NumpadEnter: 'done' }[e.code];
      if (m) { e.preventDefault(); act(m); }
      return;
    }
    if (isTyping(e.target)) return;

    const m = { j: 'next', k: 'prev', s: 'done', x: 'ignore', u: 'undo',
                c: 'copy', p: 'propose', d: 'dispute', f: 'fix', e: 'meaning',
                r: 'rewrite', t: 'flip', Escape: 'close' }[e.key];
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

  // ————————————————————————————————————————— the ones that need a sentence

  /* Five checks ask for the sentence to be written again.
   *
   *     Semicolons    "Use semicolons judiciously."            48 in the sample
   *     ThereIs       "Don't start a sentence with 'There are'." 10
   *     Commas        "More than 5 commas in a single sentence."  8
   *     Parentheses   "Use parentheses judiciously."              4
   *     Litotes       "Consider using 'lack(s)' instead of 'not have'."  2
   *
   * Seventy-two findings, and not one of them has an answer a rule could
   * write: every one needs somebody to decide what the sentence is trying to
   * say and say it again. `f` offers nothing on these and should not.
   *
   * What CAN be done is the typing around it. `r` builds the question — the
   * paragraph, the check, the linter's own words, and what a Radiopaedia
   * sentence has to hold on to — and puts it on the clipboard. Where it goes
   * from there is your business: a model in another tab, a colleague, a
   * notebook. The answer comes back the way the corrected citations do, by
   * your hand, through the editor.
   *
   * Nothing is sent. There is no model at the other end of this script and no
   * key in it; this is a clipboard and a form of words. That is also why the
   * prompt is written out in full here rather than assembled from fragments:
   * what goes on your clipboard is in this file, in order, where it can be
   * read and argued with. */
  /* ————— keeping the markup out of the round trip.
   *
   * A paragraph that leaves as plain text comes back as plain text, and
   * everything that was not a word is gone: the reference markers above all,
   * which are `<sup>41</sup>` in the editor and a bare "41" once the tags are
   * off. Paste that back and the article has lost its evidence.
   *
   * So the tags do not travel. Markers do.
   *
   *   CT pulmonary angiography ⟦1⟧will show ⟦2⟧filling defects⟦/2⟧ ⟦3⟧
   *
   * A reference is one marker on its own and is opaque: it may MOVE with the
   * clause it belongs to, and nothing about it may change. Everything else —
   * a link, an emphasis — is a PAIR around its own words: the words between
   * them are prose and may be rewritten, and the tag that goes back around
   * them afterwards is the one that was there before, href and all.
   *
   * Which is the whole safety property, and it is worth stating plainly: no
   * tag that a model wrote ever reaches the article. What comes back is read
   * as text, and the only elements in what gets written are clones of
   * elements already in that paragraph. */
  const OPEN = '⟦', SHUT = '⟧';
  const MARKER = /⟦(\/?)(\d+)⟧/g;

  // A citation marker, as opposed to a superscript that is part of the prose.
  const CITATION_SUP = /^\d+(?:\s*[,–-]\s*\d+)*$/;

  /* The block, as text with markers, and the elements the markers stand for.
   *
   * An inline element holding other elements is opaque too: unpicking a link
   * around an italic around a reference is three ways to get it wrong, and
   * those are rare enough to hand back whole. */
  function protect(block) {
    const keep = [];
    let text = '';

    for (const node of block.childNodes) {
      if (node.nodeType === 3) { text += node.nodeValue || ''; continue; }
      if (node.nodeType !== 1) continue;

      const el = node;
      const inline = el.matches?.(INLINE_TAGS);
      const n = keep.length + 1;
      const opaque = !inline
        || el.children.length > 0
        || (el.tagName === 'SUP' && CITATION_SUP.test(tidy(el.textContent || '')));

      keep.push({ el, opaque });
      text += opaque
        ? `${OPEN}${n}${SHUT}`
        : `${OPEN}${n}${SHUT}${el.textContent || ''}${OPEN}/${n}${SHUT}`;
    }
    return { block, text: text.replace(/\s+/g, ' ').trim(), keep };
  }

  /* What the markers are, in a list the prompt can carry. */
  function legend(keep) {
    return keep.map(({ el, opaque }, i) => {
      const n = i + 1;
      const what = el.tagName === 'SUP' ? 'a reference marker'
        : el.tagName === 'A' ? 'a link'
        : el.tagName === 'EM' || el.tagName === 'I' ? 'italics'
        : el.tagName === 'STRONG' || el.tagName === 'B' ? 'bold'
        : `a <${el.tagName.toLowerCase()}>`;
      return opaque
        ? `  ${OPEN}${n}${SHUT} is ${what}: "${tidy(el.textContent || '')}". Keep it exactly, move it if the clause it belongs to moves.`
        : `  ${OPEN}${n}${SHUT} … ${OPEN}/${n}${SHUT} is ${what} around its own words. The words inside may be rewritten; the pair must stay, and stay in that order.`;
    }).join('\n');
  }

  const REWRITES = new Set([
    'Radiopaedia.Semicolons',
    'Radiopaedia.ThereIs',
    'Radiopaedia.Commas',
    'Radiopaedia.Parentheses',
    'Radiopaedia.Litotes',
  ]);

  /* The house rules a rewrite has to respect, and they are not style advice:
   * each one is a way these sentences get broken.
   *
   * The reference markers come first because they are the dangerous one. In
   * the editor's text a citation is a bare number — `…in adults 41.` — and a
   * model reading that sees a typo and tidies it away, which silently strips
   * the evidence from a sentence in a medical article.
   *
   * "Change nothing but the wording" is second for the same reason: a
   * rewritten sentence that reads better and says something slightly
   * different is worse than the sentence that tripped the check. */
  const HOUSE = [
    'Change nothing but the wording. Every fact, number, hedge and qualifier',
    'stays as it is: do not add a claim, drop one, or make one more or less',
    'certain than it was.',
    '',
    'British spelling, as in the sentence you are given. Plain prose: no bold,',
    'no italics, no new abbreviations, no words of praise for the findings.',
    'Keep it about as long as it was.',
  ].join('\n');

  /* The same warning, for the one path where the references are not markers.
   * A finding that never anchored has nothing but the line the linter quoted,
   * and in that line a citation is a bare number with a full stop after it —
   * which reads exactly like a typo to anybody who has not been told. */
  const BARE_CITATIONS = [
    'Keep every reference marker exactly where it is. In this text a citation',
    'is a bare number after a clause, as in "...in adults 41." — it is not a',
    'typo and must not be moved, merged or removed.',
  ].join('\n');

  // Text, as it would be written inside a tag.
  function escaped(str) {
    const box = document.createElement('span');
    box.textContent = str;
    return box.innerHTML;
  }

  // The markers out, for anything that wants to read the words alone.
  const bare = (text) => String(text ?? '').replace(MARKER, '').replace(/\s+/g, ' ').trim();

  /* The answer, with the markup put back — or a sentence saying why it cannot
   * be.
   *
   * Every refusal here is the same refusal: the markers that went out are not
   * the markers that came back, so something was invented, dropped or moved
   * into something else. On a paragraph of a medical article that is not a
   * thing to patch up and hope; it is a thing to say out loud and leave alone.
   *
   * What it builds is a string of HTML in which every TAG is the outerHTML of
   * an element already in that paragraph and every WORD is escaped text. */
  function restore(answer, keep) {
    const used = new Array(keep.length).fill(0);
    const out = [];
    let open = null, buffer = '', at = 0, m;
    MARKER.lastIndex = 0;

    const take = (str) => {
      if (open) buffer += str;
      else if (str) out.push(escaped(str));
    };

    while ((m = MARKER.exec(answer))) {
      take(answer.slice(at, m.index));
      at = m.index + m[0].length;

      const shut = m[1] === '/';
      const n = Number(m[2]);
      const item = keep[n - 1];
      const name = `${OPEN}${shut ? '/' : ''}${n}${SHUT}`;
      if (!item) return { trouble: `${name} was not in the paragraph that went out.` };

      if (!shut) {
        if (open) return { trouble: `${name} opens inside ${OPEN}${open.n}${SHUT}.` };
        if (item.opaque) {
          if (used[n - 1]++) return { trouble: `${name} is there more than once.` };
          out.push(item.el.outerHTML);
        } else {
          open = { n, item };
          buffer = '';
        }
      } else {
        if (!open || open.n !== n) return { trouble: `${name} closes something that is not open.` };
        if (used[n - 1]++) return { trouble: `${name} is there more than once.` };
        const clone = open.item.el.cloneNode(false);
        clone.textContent = buffer;
        out.push(clone.outerHTML);
        open = null;
      }
    }
    take(answer.slice(at));
    if (open) return { trouble: `${OPEN}${open.n}${SHUT} is never closed.` };

    const lost = used.map((n, i) => (n ? null : i + 1)).filter(Boolean);
    if (lost.length) {
      return { trouble: `the answer has lost ${lost.map((n) => OPEN + n + SHUT).join(', ')}.` };
    }
    if (!out.length) return { trouble: 'there is nothing in the answer.' };
    return { html: out.join('') };
  }

  /* One finding, as a question. The check's name and the linter's own message
   * go in unedited — the message is the whole of what was asked for, and
   * rewording it here would be this script deciding what the rule meant. */
  /* The words the check pointed at, named only where naming them helps.
   *
   * On Semicolons they are ';' and on Commas ',' — a line reading "It is
   * about: ;" is noise. On ThereIs and Litotes the message already quotes
   * them, and saying the same thing twice in a prompt is a way of being
   * misread. What is left is the case the line was for: three sets of
   * brackets in a paragraph, and this is the set. */
  function worthNaming(words, message) {
    if ((words.match(/\p{L}/gu) || []).length < 2) return false;
    return !fold(message).toLowerCase().includes(fold(words).toLowerCase());
  }

  function rewritePrompt(f) {
    const quoted = f.narrowed && f.target ? plain(f.words || '') : '';
    const words = worthNaming(quoted, f.message || '') ? quoted : '';
    const held = heldFor(f);
    const marked = held && held.keep.length;

    return [
      'Rewrite one paragraph from a Radiopaedia radiology article.',
      '',
      `Their style checker says: ${f.message}`,
      `The check is ${f.condition || f.check}.`,
      words ? `It is about: ${words}` : '',
      '',
      marked ? 'The paragraph, with its markup replaced by markers:'
             : 'The paragraph:',
      '',
      held ? held.text : f.snippet,
      '',
      marked ? [
        'The markers stand for the markup, which is not yours to write:',
        '',
        legend(held.keep),
        '',
        'Give every marker back, each exactly once, spelled exactly as it is',
        'here. Anything with a marker in it that does not come back is a link',
        'or a reference lost out of the article.',
      ].join('\n') : '',
      marked ? '' : BARE_CITATIONS,
      marked ? null : '',
      HOUSE,
      '',
      'Answer with the rewritten paragraph and nothing else — no preamble, no',
      'explanation, no quotation marks around it.',
    ].filter((line) => line !== null)
     .filter((line, i, all) => !(line === '' && all[i - 1] === ''))
     .join('\n');
  }

  /* The block this finding sits in, as markers and the elements they stand
   * for — or nothing, where the finding never got anchored and all there is
   * to go on is the line the linter quoted. */
  function heldFor(f) {
    const block = f?.home?.el;
    if (!block || !block.isConnected) return null;
    const held = protect(block);
    return held.text ? held : null;
  }

  // ———————————————————————————————————————————————— the disagreement log

  /* Some findings are not mistakes in the article. They are the rule meeting a
   * case it was not written for: `<em>TERT</em>` caught by Emphasis, where
   * italicising a gene symbol is the convention and not a lapse; `YEARS` and
   * `PERC` caught by Acronyms, which are the names of trials and expand to
   * nothing; `'10 -6'` caught by NumberSpacing, which is `<sup>-6</sup>` read
   * as prose. Pressing Ignore makes those go away for the afternoon. It does
   * not make them go away next month, on the next article, for everybody.
   *
   * `supportsExceptions` — the mechanism that would, which the API itself
   * carries on every finding — belongs to Radiopaedia's own editors (see the
   * note at the top of this file). What is left to us is the argument for
   * opening it: not "the linter is sometimes wrong", which is an opinion, but
   * twenty cases grouped by rule, each with the article, the line, the words,
   * what the linter said and why it does not hold there. That is a thing to
   * read. This is where you collect it.
   *
   * It never leaves the browser. `localStorage`, like the list of words you
   * have proposed and for the same reason — it has to outlive the tab — and
   * `localStorage` rather than `GM_setValue` because this script has no such
   * grant and gains nothing by asking for one. Copy Markdown and Download CSV
   * are how the log gets out: through you, into whatever you were going to
   * write to the editorial team anyway. */

  function disputes() {
    try { return JSON.parse(localStorage.getItem(DISPUTES_KEY) || '{}') || {}; }
    catch { return {}; }
  }

  function writeDisputes(all) {
    try { localStorage.setItem(DISPUTES_KEY, JSON.stringify(all)); }
    catch { /* this session only */ }
  }

  /* One record per finding per article, so pressing d twice on the same one
   * corrects what you wrote rather than filing it again. `fp` is the
   * fingerprint the findings already carry — check, message, snippet, line —
   * which is as close to an identity as a finding has. */
  function disputeKey(f) {
    return f ? `${currentSlug() || 'article'}|${f.fp}` : null;
  }

  function disputeCount() { return Object.keys(disputes()).length; }

  function putDispute(key, record) {
    const all = disputes();
    all[key] = record;
    writeDisputes(all);
  }

  function dropDispute(key) {
    const all = disputes();
    if (!(key in all)) return;
    delete all[key];
    writeDisputes(all);
  }

  /* What goes in, and it is mostly not what you typed: the rule's own name,
   * the words it flagged, the line they sit on and the message as it came. A
   * record you have to reconstruct from memory a month later is no use to
   * anybody, least of all to somebody who has to decide whether the rule
   * should change. */
  function disputeRecord(f, why, fix) {
    const slug = currentSlug();
    return {
      at: new Date().toISOString().slice(0, 10),
      slug: slug || '',
      url: slug ? `https://radiopaedia.org/articles/${slug}` : location.href,
      condition: f.condition || '',
      check: f.check || '',
      severity: f.severity || '',
      line: f.line || '',
      message: f.message || '',
      words: f.words || '',
      snippet: f.snippet || '',
      why,
      fix,
    };
  }

  /* Grouped by rule, commonest rule first. The grouping is the argument: one
   * case is a judgement call, nine cases of Emphasis against nine gene symbols
   * is a rule that needs a clause about gene symbols. */
  function disputesMarkdown() {
    const all = Object.values(disputes());
    if (!all.length) return '';

    const days = all.map((r) => r.at).filter(Boolean).sort();
    const slugs = new Set(all.map((r) => r.slug).filter(Boolean));
    const span = days.length && days[0] !== days[days.length - 1]
      ? `${days[0]} to ${days[days.length - 1]}` : (days[0] || '');

    const byRule = new Map();
    for (const r of all) {
      const rule = r.condition || r.check || 'unknown rule';
      if (!byRule.has(rule)) byRule.set(rule, []);
      byRule.get(rule).push(r);
    }

    const out = ['# Linter findings where the rule does not fit', ''];
    out.push(`${plural(all.length, 'finding')} on ${plural(slugs.size, 'article')}` +
             (span ? `, ${span}` : '') + '.', '');

    for (const [rule, rows] of [...byRule].sort((a, b) => b[1].length - a[1].length)) {
      out.push(`## ${rule} — ${plural(rows.length, 'case')}`, '');
      for (const r of rows) {
        out.push(`### ${r.slug || 'article'}${r.line ? ` · line ${r.line}` : ''}`, '');
        if (r.snippet) out.push(`> ${r.snippet}`, '');
        if (r.words) out.push(`- **Flagged:** \`${r.words}\``);
        if (r.message) out.push(`- **The linter says:** ${r.message}`);
        out.push(`- **Why it does not fit here:** ${r.why}`);
        if (r.fix) out.push(`- **Suggested change:** ${r.fix}`);
        if (r.url) out.push(`- ${r.url}`);
        out.push('');
      }
    }
    return out.join('\n');
  }

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  /* Every field quoted, every quote doubled: the messages have commas in them,
   * the snippets have quotation marks in them, and a spreadsheet that opens
   * wrong is a log nobody looks at twice. */
  const CSV_COLUMNS = [
    ['recorded', 'at'], ['article', 'slug'], ['url', 'url'],
    ['rule', 'condition'], ['check', 'check'], ['severity', 'severity'],
    ['where', 'line'], ['the linter says', 'message'], ['flagged', 'words'],
    ['the line it is on', 'snippet'], ['why it does not fit', 'why'],
    ['suggested change', 'fix'],
  ];

  const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

  function disputesCsv() {
    const rows = [CSV_COLUMNS.map(([head]) => csvCell(head)).join(',')];
    for (const r of Object.values(disputes())) {
      rows.push(CSV_COLUMNS.map(([, field]) => csvCell(r[field])).join(','));
    }
    return rows.join('\r\n');
  }

  /* A file rather than the clipboard, because this one is going into a
   * spreadsheet and not into a sentence. The object URL is revoked on a timer:
   * the click is handled asynchronously, so revoking it on the next line
   * cancels the download it was for. */
  function saveFile(name, text, type) {
    let url;
    try { url = URL.createObjectURL(new Blob([text], { type })); } catch { return; }
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  // ————————————————————————————————————————————————— and the box you type in

  /* Which of them did you mean?
   *
   * Only ever asked where the file itself says the acronym has more than one
   * meaning. Nothing here reads the article to guess, and nothing defaults:
   * the whole reason `RV` has two lines in that file is that no rule can tell
   * the right ventricle from the residual volume without reading the sentence,
   * and the person reading the sentence is you.
   *
   * Esc and the dim behind it both mean no, and no writes nothing. */
  let pickBox = null;

  function closePick() {
    pickBox?.remove();
    pickBox = null;
  }

  function openChoice(k, f, says) {
    if (pickBox) return;

    const el = document.createElement('div');
    pickBox = el;
    el.id = 'rlx-pick';
    el.innerHTML = `
      <div class="rlx-p-panel" role="dialog" aria-label="Which meaning">
        <div class="rlx-p-head">spell it out as</div>
        <div class="rlx-p-word"></div>
        <div class="rlx-p-list"></div>
        <div class="rlx-p-hint">1 to ${Math.min(says.length, 9)}, or Esc to leave it.</div>
      </div>`;
    el.querySelector('.rlx-p-word').textContent = f.words || '';

    const list = el.querySelector('.rlx-p-list');
    says.forEach((one, i) => {
      const b = document.createElement('button');
      b.dataset.says = one;
      const key = document.createElement('span');
      key.className = 'rlx-p-key';
      key.textContent = i < 9 ? String(i + 1) : '·';
      const words = document.createElement('span');
      // What would actually be written, not the expansion on its own: the
      // acronym stays in the text and the brackets are part of the answer.
      words.textContent = `${one} (${f.words})`;
      b.append(key, words);
      list.appendChild(b);
    });

    const take = (one) => {
      if (!one) return;
      closePick();
      f.chosen = one;
      settleFix(k, f, applyFix(f));
    };

    el.addEventListener('click', (e) => {
      if (e.target === el) return closePick();
      take(e.target.closest('[data-says]')?.dataset.says);
    });

    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); return closePick(); }
      const n = Number(e.key);
      if (n >= 1 && n <= says.length && n <= 9) {
        e.preventDefault();
        e.stopPropagation();
        take(says[n - 1]);
      }
    }, true);

    document.body.appendChild(el);
    list.firstElementChild?.focus();
  }

  /* Where the rewritten paragraph comes back in.
   *
   * It has to come back through here rather than through the editor, and that
   * is the whole point of the panel: paste a paragraph straight into TinyMCE
   * and it arrives as plain text, with the references and the links gone. Here
   * the markers are read, the article's own tags are put back around the new
   * words, and what is written is markup this script built out of elements
   * that were already in that paragraph.
   *
   * Nothing is written until you press the button, and the button does not
   * light up until the markers add up. */
  let answerBox = null;

  function closeAnswer() {
    answerBox?.remove();
    answerBox = null;
  }

  function openAnswer(k, f) {
    closeAnswer();
    const held = heldFor(f);
    if (!held) { stage.said = 'the paragraph is not in the editor to write back to'; return; }

    const el = document.createElement('div');
    answerBox = el;
    el.id = 'rlx-answer';
    el.innerHTML = `
      <div class="rlx-a-panel" role="dialog" aria-label="The rewritten paragraph">
        <div class="rlx-a-head">
          <span class="rlx-a-title">the rewritten paragraph</span>
          <button data-a="close" class="rlx-a-x" title="Close (Esc)">&times;</button>
        </div>
        <div class="rlx-a-hint">The prompt is on your clipboard. Paste what comes back.</div>
        <div class="rlx-a-bridge">
          <input class="rlx-a-url" type="text" spellcheck="false"
                 placeholder="http://127.0.0.1:8765/rewrite#… — what tools/claude-bridge.py prints">
          <button data-a="ask">Ask Claude</button>
        </div>
        <textarea class="rlx-a-text" rows="7" spellcheck="false"></textarea>
        <div class="rlx-a-say"></div>
        <div class="rlx-a-diff"></div>
        <div class="rlx-a-acts">
          <button data-a="use" class="rlx-a-primary" disabled>Write it in</button>
          <button data-a="close">Cancel</button>
        </div>
      </div>`;

    const q = (sel) => el.querySelector(sel);
    const box = q('.rlx-a-text');
    const say = q('.rlx-a-say');
    const diff = q('.rlx-a-diff');
    const use = q('[data-a="use"]');
    const url = q('.rlx-a-url');
    const ask = q('[data-a="ask"]');
    let ready = null;

    url.value = bridgeAddress();

    const look = () => {
      const answer = box.value.trim();
      say.textContent = '';
      diff.textContent = '';
      ready = null;
      use.disabled = true;
      if (!answer) return;

      const back = restore(answer, held.keep);
      if (back.trouble) {
        say.className = 'rlx-a-say rlx-a-no';
        say.textContent = `Not written: ${back.trouble}`;
        return;
      }
      ready = back.html;
      say.className = 'rlx-a-say rlx-a-yes';
      say.textContent = held.keep.length
        ? `All ${plural(held.keep.length, 'marker')} accounted for.`
        : 'Ready.';

      const runs = wordDiff(bare(held.text), bare(answer));
      diff.append(
        label('as it reads'),
        diffLine(runs, 'was', 'rlx-was', bare(held.text), 'rlx-a-line'),
        label('as it would read'),
        diffLine(runs, 'now', 'rlx-now', bare(answer), 'rlx-a-line'));
      use.disabled = false;
    };

    box.addEventListener('input', look);

    el.addEventListener('click', (e) => {
      if (e.target === el) return closeAnswer();
      const what = e.target.closest('[data-a]')?.dataset.a;
      if (what === 'close') return closeAnswer();

      /* Asking the bridge. Remembered only once it has answered: an address
         that was mistyped is not one to keep, and the one thing worse than
         pasting it again is wondering why the button does nothing. */
      if (what === 'ask') {
        const where = url.value.trim();
        if (!where) { url.focus(); return; }
        ask.disabled = true;
        ask.textContent = 'Asking…';
        say.className = 'rlx-a-say';
        say.textContent = '';
        askBridge(where, rewritePrompt(f)).then((back) => {
          ask.disabled = false;
          ask.textContent = 'Ask Claude';
          if (back.trouble) {
            say.className = 'rlx-a-say rlx-a-no';
            say.textContent = `No answer: ${back.trouble}`;
            return;
          }
          rememberBridge(where);
          box.value = back.text;
          look();
          box.focus();
        });
        return;
      }

      if (what !== 'use' || !ready) return;
      closeAnswer();
      settleFix(k, f, writeBlock(held.block, ready));
    });

    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeAnswer(); }
    }, true);

    document.body.appendChild(el);
    box.focus();
  }

  /* The paragraph, replaced in one go. `insertHTML` rather than `insertText`
   * because what is going in has tags in it — the article's own, put back
   * around the new words by `restore`. */
  function writeBlock(block, html) {
    if (!block?.isConnected) return 'the paragraph is no longer there';
    const doc = block.ownerDocument;
    const target = doc.createRange();
    try { target.selectNodeContents(block); }
    catch { return 'the paragraph moved while that was being worked out'; }
    return runCommand(target, 'insertHTML', html);
  }

  let disputeBox = null;
  const disputeIsOpen = () => !!disputeBox;

  function closeDispute() {
    disputeBox?.remove();
    disputeBox = null;
  }

  function openDispute() {
    if (disputeBox) return;
    const f = stage.findings[stage.i] || null;
    const key = disputeKey(f);
    const already = key ? disputes()[key] : null;

    const el = document.createElement('div');
    disputeBox = el;
    el.id = 'rlx-dispute';
    /* No interpolation anywhere in here: everything that comes from the linter
       is put in with textContent below. The messages carry markup as TEXT —
       "Italics should be used only in exceptional circumstances: '<em>TERT</em>'"
       is the message, angle brackets and all — and the note shows them the same
       way, for the same reason. */
    el.innerHTML = `
      <div class="rlx-d-panel" role="dialog" aria-label="Disagreement log">
        <div class="rlx-d-head">
          <span class="rlx-d-title"></span>
          <button data-d="close" class="rlx-d-x" title="Close (Esc)">&times;</button>
        </div>
        <div class="rlx-d-about" hidden>
          <div class="rlx-d-where"></div>
          <div class="rlx-d-msg"></div>
          <div class="rlx-d-words" hidden></div>
          <div class="rlx-d-snippet" hidden></div>
        </div>
        <div class="rlx-d-form" hidden>
          <label class="rlx-d-label" for="rlx-d-why">Why the rule does not fit here</label>
          <textarea id="rlx-d-why" rows="3"></textarea>
          <label class="rlx-d-label" for="rlx-d-fix">What the rule should do instead &mdash; optional</label>
          <textarea id="rlx-d-fix" rows="2"></textarea>
          <div class="rlx-d-acts">
            <button data-d="save" class="rlx-d-primary">Record it</button>
            <button data-d="close">Cancel</button>
            <span class="rlx-d-say"></span>
          </div>
        </div>
        <div class="rlx-d-none" hidden></div>
        <div class="rlx-d-log">
          <div class="rlx-d-loghead">
            <span class="rlx-d-count"></span>
            <span class="rlx-d-tools">
              <button data-d="md">Copy Markdown</button>
              <button data-d="csv">Download CSV</button>
              <button data-d="clear">Clear the log</button>
            </span>
          </div>
          <div class="rlx-d-rows"></div>
        </div>
      </div>`;

    const q = (sel) => el.querySelector(sel);
    const why = q('#rlx-d-why');
    const fix = q('#rlx-d-fix');
    const say = (words) => { q('.rlx-d-say').textContent = words || ''; };

    q('.rlx-d-title').textContent = f
      ? (already ? 'What you said about this finding' : 'The rule does not fit here')
      : 'The disagreement log';

    if (f) {
      q('.rlx-d-about').hidden = false;
      q('.rlx-d-form').hidden = false;
      q('.rlx-d-where').textContent =
        [f.check, f.severity, f.line ? `line ${f.line}` : ''].filter(Boolean).join(' · ');
      q('.rlx-d-msg').textContent = f.message || '';
      if (f.words) { q('.rlx-d-words').hidden = false; q('.rlx-d-words').textContent = f.words; }
      if (f.snippet) { q('.rlx-d-snippet').hidden = false; q('.rlx-d-snippet').textContent = f.snippet; }
      why.placeholder = 'Gene symbols are italicised by convention, so the italics here are correct.';
      fix.placeholder = 'Skip the check inside a gene symbol, or let the exception list cover it.';
      if (already) {
        why.value = already.why || '';
        fix.value = already.fix || '';
        q('[data-d="save"]').textContent = 'Correct it';
      }
    } else {
      /* Reached with nothing selected — the walk is over, or it never started.
         There is no finding to describe, but the log and the two ways out of it
         are exactly what you came for. */
      q('.rlx-d-none').hidden = false;
      q('.rlx-d-none').textContent =
        'No finding is in hand, so there is nothing to add from here. What is in the log:';
    }

    const save = () => {
      const words = why.value.trim();
      if (!f || !key) return say('No finding in hand.');
      if (!words) { say('Say why it does not fit, and it goes in.'); why.focus(); return; }
      putDispute(key, disputeRecord(f, words, fix.value.trim()));
      closeDispute();

      /* Recorded, and out of the walk. Saying the rule is wrong IS skipping the
         finding — the two were always one gesture, done with two keys — but it
         does not move you on, any more than fixing one does: the note turns and
         waits where the words are, and u puts it back. The record stays either
         way, because it is a note about the rule and not about this finding's
         state. */
      if (f.state === 'open') {
        stage.history.push({ i: stage.i, state: f.state });
        f.state = 'ignored';
        f.range = null;
      }
      draw();
      updateBar();
    };

    const fillLog = () => {
      const all = disputes();
      const keys = Object.keys(all);
      q('.rlx-d-count').textContent = keys.length
        ? `${plural(keys.length, 'finding')} in the log` : 'nothing in the log yet';
      for (const name of ['md', 'csv', 'clear']) q(`[data-d="${name}"]`).disabled = !keys.length;

      const wipe = q('[data-d="clear"]');
      delete wipe.dataset.sure;
      wipe.textContent = 'Clear the log';

      const rows = q('.rlx-d-rows');
      rows.textContent = '';
      // Newest first here, oldest first in the exports: this is a list you
      // check, those are a document somebody reads from the top.
      for (const k of keys.reverse()) {
        const r = all[k];
        const row = document.createElement('div');
        row.className = 'rlx-d-row';
        const what = document.createElement('div');
        what.className = 'rlx-d-what';
        const rule = document.createElement('div');
        rule.className = 'rlx-d-rule';
        rule.textContent = [r.at, r.slug, r.condition || r.check].filter(Boolean).join(' · ');
        const line = document.createElement('div');
        line.className = 'rlx-d-why';
        line.textContent = r.why || '';
        what.append(rule, line);
        const x = document.createElement('button');
        x.dataset.del = k;
        x.textContent = '×';
        x.title = 'Take this one out of the log';
        row.append(what, x);
        rows.appendChild(row);
      }
    };

    el.addEventListener('click', (e) => {
      // The dim behind the panel is the panel's own padding: a click that lands
      // on it is a click outside, and that closes.
      if (e.target === el) return closeDispute();

      const gone = e.target.closest('[data-del]');
      if (gone) {
        // Two clicks, because the first thing in the row is prose you typed.
        if (gone.dataset.sure !== '1') {
          gone.dataset.sure = '1';
          gone.textContent = 'remove?';
          return;
        }
        dropDispute(gone.dataset.del);
        fillLog();
        updateBar();
        return;
      }

      switch (e.target.closest('[data-d]')?.dataset.d) {
        case 'save': return save();
        case 'close': return closeDispute();
        case 'md': {
          navigator.clipboard?.writeText(disputesMarkdown());
          say('The whole log is on the clipboard.');
          return;
        }
        case 'csv':
          saveFile(`radiopaedia-lint-log-${new Date().toISOString().slice(0, 10)}.csv`,
                   disputesCsv(), 'text/csv;charset=utf-8');
          return;
        case 'clear': {
          const b = el.querySelector('[data-d="clear"]');
          if (b.dataset.sure !== '1') {
            b.dataset.sure = '1';
            b.textContent = 'Clear it all?';
            return;
          }
          writeDisputes({});
          fillLog();
          updateBar();
          return;
        }
      }
    });

    /* The stage's own keys are off while this is open — see `onKey` — so these
       are the only two the box answers to. Enter alone is a newline: what you
       are typing into is prose, and prose has paragraphs. */
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); return closeDispute(); }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'Enter' || e.code === 'NumpadEnter')) {
        e.preventDefault();
        e.stopPropagation();
        save();
      }
    }, true);

    document.body.appendChild(el);
    fillLog();
    (f ? why : el.querySelector('[data-d="close"]')).focus();
  }

  // ————————————————————————————————————————————————————————— the button

  function currentSlug() {
    const m = /^\/articles\/([^/?#]+)/.exec(location.pathname);
    return m ? decodeURIComponent(m[1]) : null;
  }
  const inEditor = () => /\/edit\/?$/.test(location.pathname);

  let group = null, button = null, toggle = null, railToggle = null, citesToggle = null;
  let sweepToggle = null;
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
    'read last time';

  function paintForce() {
    if (!forceBtn) return;
    forceBtn.classList.toggle('rlx-busy', forcing);
    forceBtn.disabled = forcing;
    forceBtn.title = forcing ? 'The linter is reading the article again…' : FORCE_TITLE;
  }

  /* Pressing it: one request, asked here rather than inside the paint that
   * follows, and that is the whole shape of it. `lintResult` with `force` sends
   * `cache=refresh` and keeps what comes back, so the `runLint` or `preview`
   * after it reads the fresh answer out of `sessionStorage` and asks the
   * linter for nothing — a forced run costs one request, not two, and the two
   * cannot disagree about which answer is on screen.
   *
   * Asked here for a second reason: loud on failure, unlike `preview`. Both of
   * those swallow what they cannot do — `preview` by design, `runLint` into its
   * own alert — so a refresh that failed inside them would leave a ↻ that went
   * round once and changed nothing, which would be a lie about what the linter
   * has read. Nobody is surprised by an alert they pressed a button for. */
  async function forceRefresh(slug) {
    if (!slug || forcing) return;
    forcing = true;
    paintForce();
    try {
      await lintResult(slug, { force: true });
      if (inEditor()) await runLint(slug, {});
      else await preview(slug, {});
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

    /* The automatic preview and the rail act on the article page and nothing
       else, so the box in the editor carries neither: two switches for
       something that is not there. */
    const page = !inEditor();
    g.append(b, f);
    if (page) g.append(t, r);

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

    /* And the fifth, beside it and for the same reason. Not a switch: a
       question, asked when it is pressed and answered in the margin of the
       reference list. Nothing is checked until somebody presses it — this one
       reaches two databases, and an article being opened is not a reason to
       ask them anything. */
    let w = null;
    if (inEditor()) {
      w = document.createElement('button');
      w.className = 'rlx-auto rlx-sweep-toggle';
      w.type = 'button';
      w.addEventListener('click', () => sweepRetractions());
      g.appendChild(w);
    }

    /* And the sixth: the words in the text that are the title of another
       article and are not linked to it. A question like the fifth, asked when
       it is pressed — the answer is a panel down the right-hand side. */
    let k = null;
    if (inEditor()) {
      k = document.createElement('button');
      k.className = 'rlx-auto rlx-links-toggle';
      k.type = 'button';
      k.addEventListener('click', () => toggleLinks());
      g.appendChild(k);
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

    group = g; button = b; toggle = page ? t : null; railToggle = page ? r : null;
    citesToggle = c;
    sweepToggle = w;
    linksToggle = k;
    forceBtn = f;
    paintButton();
    paintForce();
    paintToggle();
    paintRailToggle();
    paintCitesToggle();
    paintSweepToggle();
    paintLinksToggle();
    placeGroup();
  }

  /* The fallback spot: fixed at the top right, outside any branch of the site.
   * Ugly but always visible, which is what counts here. */
  function pinToCorner(b) {
    b.classList.add('rlx-btn-float');
    document.body.appendChild(b);
  }

  /* In the editor the box stands where the bar will: at the top of the grey
   * margin to the left of the page, as wide as the bar. Pressing Lint turns
   * the one into the other in the same place, and closing the bar turns it
   * back, so everything the linter has to do with this page is in that one
   * column and nothing is left over in the corner of the window.
   *
   * Until the editor has mounted, and in a window too narrow to have a
   * margin, it stays in the corner. Asked again whenever the page changes or
   * the window is resized, on the next frame and once per frame at most:
   * the observer that calls this also fires for every highlight redrawn. */
  function placeGroup() {
    if (!group?.isConnected || !inEditor()) return;
    if (document.documentElement.classList.contains('rlx-staged')) return;   // the bar is up
    const root = editorRoots()[0];
    const m = root ? marginOf(root.frame || root.root) : null;
    group.classList.toggle('rlx-btn-margin', !!m);
    group.style.left = m ? `${m.right - m.width}px` : '';
    group.style.width = m ? `${m.width}px` : '';
    group.style.top = m ? `${BAR_EDGE}px` : '';
  }

  let groupPending = null;
  function placeGroupSoon() {
    if (groupPending || !inEditor()) return;
    groupPending = requestAnimationFrame(() => { groupPending = null; placeGroup(); });
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
   * structures, three hundred and thirty-one headings, each with the level it
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

  // ———————————————————————————————————————— sections with only old citations

  /* The newest thing a section cites, and how long ago that was. A section
   * whose newest citation is more than `STALE_AFTER` years old gets a chip of
   * its own beside its heading, among the chips for what is missing.
   *
   * Years only, because a year is all most references say: in 2026 a section
   * whose newest citation is from 2021 is five years old and passes, and one
   * from 2020 is six and does not.
   *
   * Each heading answers for the text between it and the next heading of ANY
   * level, so a `Radiographic features` that opens with one old sentence is
   * told about it even when its `MRI` is up to date, and an `MRI` with nothing
   * but old papers is not excused by a fresh sentence above it. A section that
   * cites nothing has no date to report, and is not this check's business.
   *
   * It only ever says what it knows. One citation in the section with no
   * readable year, or a number the list does not have, and the newest might be
   * the one it cannot read, so the section gets no chip. */
  const STALE_AFTER = 5;
  const REFERENCES = '#references li';
  const REFERENCE_NUMBER = /^(\d+)\.\s/;

  /* What a section about the past is meant to cite. */
  const TIMELESS_HEADINGS = new Set(['history and etymology'].map(normaliseHeading));

  /* The year a reference was published, from its text with the links gone,
   * since a DOI can hold anything that looks like a year.
   *
   * Three forms, best first. A journal says `Radiographics. 2018;38(7):2102`,
   * a book says `(2012) ISBN: 9781931884211`, and the rest end on it, as in
   * `StatPearls Publishing. 2023.`. The last of each kind, because a title can
   * carry a year of its own: `The 2021 WHO Classification. Neuro Oncol.
   * 2021;23(8)`. A year past next year is a number that only looks like one. */
  function referenceYear(text, thisYear = new Date().getFullYear()) {
    for (const form of [/\b((?:19|20)\d\d)\s*[;:]/g, /\(((?:19|20)\d\d)\)/g, /\b((?:19|20)\d\d)\b/g]) {
      const years = [...String(text).matchAll(form)].map((m) => Number(m[1]))
        .filter((y) => y <= thisYear + 1);
      if (years.length) return years[years.length - 1];
    }
    return null;
  }

  /* {reference number: {year, text}}, off the list at the foot of the page. It
   * is folded away there, but the text is in the page whether it shows or not. */
  function referencesOnPage() {
    const refs = new Map();
    for (const li of document.querySelectorAll(REFERENCES)) {
      const copy = li.cloneNode(true);
      copy.querySelectorAll('a').forEach((a) => a.remove());
      const text = tidy(copy.textContent || '');
      const n = REFERENCE_NUMBER.exec(text);
      if (n) refs.set(Number(n[1]), { year: referenceYear(text), text: text.replace(/\s*-$/, '') });
    }
    return refs;
  }

  /* '1-3,5' → [1, 2, 3, 5]. */
  function citedNumbers(marker) {
    const out = [];
    for (const piece of marker.split(',')) {
      const [from, to = from] = piece.split(/[-–]/).map(Number);
      for (let n = from; n <= to; n++) out.push(n);
    }
    return out;
  }

  /* The sections to say something about, as rows the rail can place. */
  function staleSections(body, refs, thisYear = new Date().getFullYear()) {
    const sections = [];
    let section = null;
    for (const el of body.querySelectorAll(`${SECTION_SEL}, sup`)) {
      if (el.tagName !== 'SUP') {
        section = { heading: el, cited: new Set() };
        sections.push(section);
        continue;
      }
      const marker = tidy(el.textContent || '');
      if (!section || !CITATION_NUMBERS.test(marker) || unitExponent(el)) continue;
      citedNumbers(marker).forEach((n) => section.cited.add(n));
    }

    const hushed = new Set(hushedHere());
    const rows = [];
    for (const { heading, cited } of sections) {
      const name = normaliseHeading(heading.textContent);
      const entry = `stale:${name}`;
      if (!cited.size || TIMELESS_HEADINGS.has(name) || hushed.has(entry)) continue;

      const found = [...cited].map((n) => ({ n, ...refs.get(n) }));
      if (found.some((r) => !r.year)) continue;

      const newest = Math.max(...found.map((r) => r.year));
      const age = thisYear - newest;
      if (age <= STALE_AFTER) continue;

      found.sort((a, b) => b.year - a.year || a.n - b.n);
      rows.push({
        stale: true, entry, required: true, inside: true, anchor: heading,
        level: TAG_LEVEL[heading.tagName], title: `Newest citation ${newest}`,
        why: `The newest citation under "${tidy(heading.textContent)}" is from ${newest}, `
          + `${age} years ago.\n\n${found.map((r) => r.text).join('\n')}`,
      });
    }
    return rows;
  }

  /* Each stale row goes after the rows on or above its heading. The stack in
   * `layOut` only ever moves down, so a row out of order would drag every chip
   * after it away from its own heading. A missing section with nothing after
   * it has no anchor, and stays last. */
  function mergeStale(rows, stale) {
    const merged = [...rows];
    for (const row of stale) {
      const at = merged.findIndex((r) => !r.anchor
        || (row.anchor.compareDocumentPosition(r.anchor) & Node.DOCUMENT_POSITION_FOLLOWING));
      merged.splice(at < 0 ? merged.length : at, 0, row);
    }
    return merged;
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
    const stale = staleSections(body, referencesOnPage());
    const asideSections = hushedHere().filter((entry) => !entry.startsWith('stale:')).length;

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
    if (!worth && !stale.length) return;

    rail.seen = seen;
    rail.canonName = canonName;
    rail.profile = profile;
    rail.body = body;
    rail.title = visibleTitle();

    rail.layer = document.createElement('div');
    rail.layer.id = 'rlx-gutter';
    rail.layer.style.setProperty('--rlx-miss', MISS.ink);
    rail.layer.style.setProperty('--rlx-stale', COLORS.suggestion.ink);

    const head = document.createElement('div');
    head.className = 'rlx-rail-head';
    head.innerHTML = `
      <span title="${
        rows.map((r) => (r.required ? '' : '· ') + r.title).join('\n').replace(/"/g, '')
      }" class="rlx-rail-n${need ? '' : ' rlx-rail-none'}">${need}</span>
      <span class="rlx-rail-what">${need
        ? `section${need > 1 ? 's' : ''} missing`
        : (asideSections ? 'all set aside' : 'nothing required')}</span>
      ${jumbled ? '<span class="rlx-rail-jumbled" title="Some sections are not in the order the canon puts them in, which the linter reports separately. The placements below are approximate on this article.">&#8645;</span>' : ''}
      <button class="rlx-rail-off" title="Hide the structure rail everywhere">&times;</button>
      ${stale.length ? `<span class="rlx-rail-stale" title="Sections whose newest citation is more than ${STALE_AFTER} years old"><span class="rlx-rail-n">${stale.length}</span> with old citations</span>` : ''}
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

    rail.rows = mergeStale(shown, stale);

    /* Nothing to copy on these, so the click is the × and nothing else: what
     * there is to say is the list in the tooltip, newest first. */
    for (const row of stale) {
      const chip = document.createElement('div');
      chip.className = 'rlx-chip rlx-chip-stale';
      if (row.level > 1) chip.classList.add('rlx-chip-sub');
      chip.innerHTML = `
        <span class="rlx-chip-rel">&#8987;&#xFE0E;</span>
        <span class="rlx-chip-name"></span>
        <button class="rlx-chip-hush" title="This section can keep its older citations">&times;</button>`;
      chip.querySelector('.rlx-chip-name').textContent = row.title;
      chip.title = row.why;
      chip.querySelector('.rlx-chip-hush').addEventListener('click', () => hush(row.entry));
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
   * not a heading — so it offers its parent instead.
   *
   * Two things travel with it. The MARKUP, so that what lands in the editor is
   * a heading of the right level and not a paragraph you then have to promote
   * by hand; and the PLACE, so that the editor can go on saying what the chip
   * said — see the paste marker below. */
  function copyHeading(chip, row) {
    const text = row.modality ? 'Radiographic features' : row.title;
    const level = row.modality ? 1 : row.level;
    rememberPaste({
      slug: currentSlug(), text, level, modality: !!row.modality,
      anchor: row.anchor ? tidy(row.anchor.textContent) : null,
      inside: !!row.inside, at: Date.now(),
    });
    copyAsHeading(text, level).then((ok) => {
      if (!ok) return;                  // no clipboard: the name is on screen anyway
      chip.classList.add('rlx-chip-copied');
      setTimeout(() => chip.classList.remove('rlx-chip-copied'), 900);
    });
  }

  /* Heading levels as the editor keeps them. Radiopaedia's toolbar calls them
   * H1, H2 and H3; what it writes — and what the article renders — is h4, h5
   * and h6, the page's own h1 being the title. */
  const LEVEL_TAG = ['h4', 'h5', 'h6'];

  /* The heading on the clipboard as BOTH flavours: the words for anywhere
   * else, and one tag of HTML for the editor, which is a WYSIWYG and pastes
   * what it is given. Plain text alone arrived as a paragraph in the middle of
   * the article and had to be made a heading by hand every single time — the
   * one manual step in a gesture whose whole point was not having any.
   *
   * Two ways of doing it because neither is everywhere. `ClipboardItem` is the
   * one that is meant for this; the old `execCommand` over a hidden selection
   * is what Firefox needed until recently and what a page served over plain
   * http still needs, since the async clipboard is a secure-context API. If
   * the editor is set to paste as text the html flavour is dropped and you get
   * exactly what you got before, which is why it is worth trying at all. */
  async function copyAsHeading(text, level) {
    const tag = LEVEL_TAG[Math.min(Math.max(level || 1, 1), LEVEL_TAG.length) - 1];
    const el = document.createElement(tag);
    el.textContent = text;
    const html = el.outerHTML;

    if (window.ClipboardItem && navigator.clipboard?.write) {
      try {
        await navigator.clipboard.write([new ClipboardItem({
          'text/plain': new Blob([text], { type: 'text/plain' }),
          'text/html': new Blob([html], { type: 'text/html' }),
        })]);
        return true;
      } catch { /* refused, or no such flavour here: the old way below */ }
    }
    if (copyByHand(html)) return true;
    try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
  }

  /* The hidden-selection copy. A `contenteditable` off the left edge rather
   * than a `textarea`, because a textarea has no html flavour to offer — and
   * the selection you had is put back, since taking it and not giving it back
   * is how a copy button loses you the sentence you had highlighted. */
  function copyByHand(html) {
    const holder = document.createElement('div');
    holder.contentEditable = 'true';
    holder.style.cssText = 'position:fixed; left:-9999px; top:0; opacity:0;';
    holder.innerHTML = html;
    document.body.appendChild(holder);

    const sel = getSelection();
    const had = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
    let ok = false;
    try {
      const r = document.createRange();
      r.selectNodeContents(holder);
      sel.removeAllRanges();
      sel.addRange(r);
      ok = document.execCommand('copy');
    } catch { ok = false; }
    try {
      sel.removeAllRanges();
      if (had) sel.addRange(had);
    } catch { /* nothing was selected to begin with */ }
    holder.remove();
    return ok;
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
    rail.thread.classList.toggle('rlx-thread-stale', !!row.stale);
    path.setAttribute('d', `M${cx},${cy} H${mx} V${ty} H${tx}`
                         + ` M${tx - 4},${ty - 3} L${tx},${ty} L${tx - 4},${ty + 3}`);
  }

  // ————————————————————————————— where the copied heading goes, in the editor

  /* The chip in the margin says where a missing section belongs — above
   * `Pathology`, inside `Radiographic features` — and then you press it, and
   * the next page you are looking at is the editor, which the rail cannot
   * follow you into: it reads the article as the site renders it, and there is
   * no rendered article here. You arrive holding the heading with nothing left
   * that says where to put it.
   *
   * So the placement travels with the copy. The chip writes down the heading
   * it was standing beside; the editor looks for that heading in the text you
   * are editing and draws the line the new one goes on.
   *
   * One line, for the one heading you copied. A marker on every missing
   * section would be the rail again, drawn this time over the words you are
   * trying to type.
   *
   * It lives in `sessionStorage` because the article page and the edit page
   * are two page loads of one tab, and nothing in memory survives that. It is
   * dropped when you paste, when you dismiss it, and when it goes stale. */
  const PASTE_KEY = 'rlx-paste';
  const PASTE_LIFE = 60 * 60 * 1000;   // the trip to the editor, not a bookmark
  const PASTE_HEADINGS = 'h1,h2,h3,h4,h5,h6';

  function rememberPaste(memo) {
    try { sessionStorage.setItem(PASTE_KEY, JSON.stringify(memo)); }
    catch { /* no storage: the marker is the thing that does not happen */ }
  }

  function pasteMemo() {
    try {
      const m = JSON.parse(sessionStorage.getItem(PASTE_KEY) || 'null');
      if (!m || !m.text || m.slug !== currentSlug()) return null;
      return Date.now() - (m.at || 0) > PASTE_LIFE ? null : m;
    } catch { return null; }
  }

  function forgetPaste() {
    try { sessionStorage.removeItem(PASTE_KEY); } catch { /* never mind */ }
  }

  const pasteMark = { layer: null, line: null, tag: null,
                      spot: null, memo: null, body: null, clips: null, was: 0 };

  async function pasteMarkSoon() {
    if (!inEditor() || !pasteMemo()) return;
    const roots = await awaitEditor();
    const memo = pasteMemo();            // the wait is long: it may be stale now
    if (!roots.length || !memo) return;

    /* The article body is the longest of the editor's fields. An article has
     * several — the title, the tags, a caption — and a heading pasted into any
     * of the others is not a section of anything. */
    const body = roots.reduce((a, b) =>
      (b.root.textContent || '').length > (a.root.textContent || '').length ? b : a);
    openPasteMark(memo, findPasteSpot(memo, body), body);
  }

  /* The place in the editor the chip was pointing at. `inside` puts the new
   * heading under that one — a subsection starts where its section's text does
   * — and everything else puts it above. A heading the editor has not got, and
   * a chip that had nothing after it to stand beside, come to the same answer:
   * the end of the text. */
  function findPasteSpot(memo, body) {
    const want = memo.anchor ? normaliseHeading(memo.anchor) : null;
    if (want) {
      for (const el of body.root.querySelectorAll(PASTE_HEADINGS)) {
        if (normaliseHeading(el.textContent) !== want) continue;
        return { el, frame: body.frame, at: memo.inside ? 'bottom' : 'top', lost: false };
      }
    }
    const last = body.root.lastElementChild;
    return last ? { el: last, frame: body.frame, at: 'bottom', lost: !!want } : null;
  }

  function openPasteMark(memo, spot, body) {
    closePasteMark();
    if (!spot) return;
    pasteMark.memo = memo;
    pasteMark.spot = spot;
    pasteMark.body = body;
    pasteMark.clips = clipChain(spot.frame || body.root);
    pasteMark.was = countPasted(body, memo.text);

    const layer = document.createElement('div');
    layer.id = 'rlx-paste';
    layer.style.setProperty('--rlx-miss', MISS.ink);
    layer.innerHTML = `
      <div class="rlx-paste-line"></div>
      <div class="rlx-paste-tag">
        <span class="rlx-paste-what"></span>
        <span class="rlx-paste-where"></span>
        <button class="rlx-paste-off" title="Dismiss">&times;</button>
      </div>`;

    layer.querySelector('.rlx-paste-off').addEventListener('click', () => {
      forgetPaste();
      closePasteMark();
    });

    document.body.appendChild(layer);
    pasteMark.layer = layer;
    pasteMark.line = layer.querySelector('.rlx-paste-line');
    pasteMark.tag = layer.querySelector('.rlx-paste-tag');
    sayPasteMark();

    addEventListener('scroll', placePasteMark, true);
    addEventListener('resize', placePasteMark);
    const w = spot.frame?.contentWindow;
    if (w) {
      w.addEventListener('scroll', placePasteMark, true);
      w.document.addEventListener('input', pastedYet, true);
    } else {
      body.root.addEventListener('input', pastedYet, true);
    }
    placePasteMark();
  }

  function closePasteMark() {
    const { layer, spot, body } = pasteMark;
    layer?.remove();
    removeEventListener('scroll', placePasteMark, true);
    removeEventListener('resize', placePasteMark);
    try {
      const w = spot?.frame?.contentWindow;
      if (w) {
        w.removeEventListener('scroll', placePasteMark, true);
        w.document.removeEventListener('input', pastedYet, true);
      } else body?.root?.removeEventListener('input', pastedYet, true);
    } catch { /* the frame went with the page */ }
    pasteMark.layer = pasteMark.line = pasteMark.tag = null;
    pasteMark.spot = pasteMark.memo = pasteMark.body = pasteMark.clips = null;
  }

  let pastePending = null;
  function placePasteMark() {
    if (pastePending) return;
    pastePending = requestAnimationFrame(() => { pastePending = null; layOutPasteMark(); });
  }

  /* Fixed, like the highlights and the chips, and for the same reason: the
   * editor holds unsaved work and nothing of ours is ever put inside it.
   *
   * Inside an iframe a rectangle is measured against the iframe's own
   * viewport, so the frame's position goes back in — and the edges of the box
   * the text sits in become the second thing to hide behind, since text
   * scrolled out of the editor is still inside the window. The same box the
   * highlights are cut to, found the same way. */
  function layOutPasteMark() {
    const { layer, spot } = pasteMark;
    if (!layer) return;
    if (!spot?.el?.isConnected) return reseatPasteMark();

    const frame = spot.frame?.isConnected ? spot.frame.getBoundingClientRect() : null;
    const off = frame || { left: 0, top: 0 };
    const r = spot.el.getBoundingClientRect();
    const y = (spot.at === 'bottom' ? r.bottom : r.top) + off.top;
    const x = r.left + off.left;

    const clip = clipOf(pasteMark);
    const top = clip ? Math.max(0, clip.top) : 0;
    const bottom = clip ? Math.min(innerHeight, clip.bottom) : innerHeight;
    layer.hidden = y < top + 4 || y > bottom - 4;
    if (layer.hidden) return;

    pasteMark.line.style.left = `${Math.round(x)}px`;
    pasteMark.line.style.top = `${Math.round(y) - 1}px`;
    pasteMark.line.style.width = `${Math.round(Math.max(80, r.width))}px`;

    pasteMark.tag.style.top = `${Math.round(y) + 3}px`;
    // Measured where it has been put: the label wraps to the width it is given
    // and nothing knows how wide that is until it is on the page.
    pasteMark.tag.style.left = `${Math.round(x)}px`;
    const t = pasteMark.tag.getBoundingClientRect();
    const end = x + Math.max(80, r.width) - t.width;
    pasteMark.tag.style.left =
      `${Math.round(Math.min(Math.max(6, end), innerWidth - 6 - t.width))}px`;
  }

  /* What the chip said, said again in the place it was about.
   *
   * Written from the spot rather than from the memo, and written again
   * whenever the spot changes: the one clause that matters is the one for the
   * case that can go wrong — the heading it was measured against is not in the
   * editor, the line is standing at the end of the text instead, and saying so
   * is the difference between a guess and a mistake.
   *
   * The modality row is the one chip whose clipboard is not the heading you
   * are going to write: there is no name to copy, only a question — which
   * modality does this article have images of? — so the marker asks it rather
   * than telling you to paste the section's own title into itself. */
  function sayPasteMark() {
    const { tag, memo, spot } = pasteMark;
    if (!tag || !memo || !spot) return;
    tag.querySelector('.rlx-paste-what').textContent = memo.modality
      ? 'An imaging subheading (CT, MRI, …) goes here'
      : `Paste “${memo.text}” here`;
    tag.querySelector('.rlx-paste-where').textContent =
        spot.lost ? `— at the end: “${memo.anchor}” is not in the text`
      : !memo.anchor ? '— at the end of the article'
      : memo.inside ? `— inside “${memo.anchor}”`
      : `— above “${memo.anchor}”`;
  }

  /* The heading the line was measured against is gone from the page — not
   * necessarily from the text. The editor replaces nodes as you type and an
   * undo can replace whole blocks, and a marker that gave up the first time
   * that happened would be a marker you lost by editing the paragraph above
   * it. So it is looked for again, and only a text that really no longer has
   * it closes the thing. */
  function reseatPasteMark() {
    const { memo, body } = pasteMark;
    if (!memo || !body?.root?.isConnected) return closePasteMark();
    const spot = findPasteSpot(memo, body);
    if (!spot) return closePasteMark();
    pasteMark.spot = spot;
    sayPasteMark();
    layOutPasteMark();
  }

  /* How many headings in the editor read like this one. Counted rather than
   * looked for, because the modality chip copies `Radiographic features` —
   * a heading that is already there — and "is it there?" would answer yes
   * before you had pasted anything. One more than there were is the paste. */
  function countPasted(body, text) {
    const want = normaliseHeading(text);
    let n = 0;
    for (const el of body.root.querySelectorAll(PASTE_HEADINGS)) {
      if (normaliseHeading(el.textContent) === want) n++;
    }
    return n;
  }

  /* Pasted: the marker has said what it had to say and goes, and the memo goes
   * with it so that the next edit page does not put it back. Anything else you
   * type moves the text under the line, so the line moves with it. */
  let pastedPending = null;
  function pastedYet() {
    clearTimeout(pastedPending);
    pastedPending = setTimeout(() => {
      const { memo, body } = pasteMark;
      if (!memo || !body?.root?.isConnected) return;
      if (countPasted(body, memo.text) > pasteMark.was) {
        forgetPaste();
        return closePasteMark();
      }
      placePasteMark();
    }, 500);
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
   * covers it: this is the same host the linter answers from, and every request
   * in this file is a GET. */
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
  function diffLine(runs, keep, mark, fallback, cls = 'rlx-cite-text') {
    const line = document.createElement('div');
    line.className = cls;
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
    // The flags were drawn against the list as it was; a list that has grown a
    // reference is a list whose flags are pointing at the wrong boxes.
    clearRetractions();
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


  // ———————————————————————— and whether anybody has withdrawn it since

  /* A reference can be word for word right and still be the wrong thing to
   * cite, because the paper behind it has been withdrawn. The citation check
   * above cannot see that: it compares the words in the box against the words
   * a database returns for that identifier, and a retracted paper's words do
   * not change. The retraction is a second record pointing at the first.
   *
   * So this asks the other question, about the same references, and asks it of
   * two places that disagree in a useful direction:
   *
   *   The Retraction Watch database, which is the one that reaches past
   *   PubMed. It is 68 MB of CSV and not a thing to hand to an editor, so
   *   `tools/retraction-index.py` reduces it to the four columns that answer
   *   this — identifier, what happened, when, and the notice — and that file
   *   is read here. It costs one fetch and no round trip per reference, and it
   *   is exactly as current as the day it was last regenerated.
   *
   *   PubMed, live, which is never stale and which is the one that says what
   *   the notice actually is. It is also the one that catches the papers the
   *   index was built too early to know about: of the references tried while
   *   writing this, two sat in the index as expressions of concern and came
   *   back from PubMed as retracted, the retraction having landed in between.
   *
   * Neither alone would do. PubMed does not index every journal that retracts
   * things, and an index in a file is a photograph of a moving target — so
   * where they both speak, the live answer governs and the disagreement is
   * printed rather than hidden; where only one speaks, it says so.
   *
   * Two requests for the whole article, not two per reference. PubMed's
   * E-utilities take the OR of every identifier in one `esearch` — DOIs as
   * `[aid]`, PubMed IDs as `[uid]` — and `efetch` then returns all the records
   * at once. A thirty-reference article costs the same as a two-reference one.
   *
   * And this is a WARNING, never a verdict and never a block. Citing a
   * retracted paper is sometimes exactly what an article means to do — the
   * history of a sign, a fabrication that mattered — so nothing is corrected,
   * nothing is written into the editor, and the chip says what was found and
   * where it was found. The decision stays with the person who pressed it. */

  const INDEX_URL = RAW_URL + 'retraction-index.txt';
  const INDEX_TIMEOUT = 60_000;
  const INDEX_MAX = 16 * 1024 * 1024;   // 4.5 MB of it today, and it only grows

  /* NCBI ask for a tool name on every request so that a misbehaving client can
   * be told apart from a busy one, and they take an address beside it. The
   * name is sent and the address is not: the person pressing this is an editor
   * on somebody else's site, and their address is not ours to hand to a third
   * party. Three requests a second is the unkeyed limit; two per press is not
   * close to it, and `EUTILS_GAP` keeps the chunks of a very long reference
   * list apart anyway. */
  const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/';
  const EUTILS_TOOL = 'radiopaedia-lint';
  const EUTILS_TIMEOUT = 60_000;
  const EUTILS_MAX = 8 * 1024 * 1024;   // MEDLINE records run ~6 kB each, abstracts and all
  const EUTILS_CHUNK = 60;              // identifiers per request
  const EUTILS_GAP = 400;               // ms between chunks

  /* A DOI, as it appears inside the markup of a reference box.
   *
   * Stopped at whitespace and at the characters that can only be the markup
   * around it — quotes, angle brackets, an entity's `&` — because the DOI is
   * usually inside an `href`. Not stopped at a bracket: `(97)` is part of
   * every Lancet DOI of that decade, and a pattern that ended there would cut
   * two thirds of them off. What that costs is a trailing bracket picked up
   * from prose, and `oneDoi` takes it back off. */
  const REF_DOI = /\b10\.\d{4,9}\/[^\s"'<>&]+/;
  /* And a PubMed ID: in a link, in a `PMID:` the way a reference writes it,
   * and bare in neither case. Five digits at least — a four-digit number
   * beside the word is a page range often enough to matter. */
  const REF_PMID = /(?:pubmed\.ncbi\.nlm\.nih\.gov\/|\/pubmed\/|\bpmid\s*[:.—-]?\s*)(\d{5,8})\b/i;

  function oneDoi(markup) {
    const found = REF_DOI.exec(String(markup ?? ''));
    if (!found) return '';
    let doi = found[0].replace(/[.,;:]+$/, '');
    // A bracket that closes nothing was the prose's, not the DOI's.
    let open = 0;
    for (const ch of doi) open += ch === '(' ? 1 : ch === ')' ? -1 : 0;
    while (open < 0 && doi.endsWith(')')) { doi = doi.slice(0, -1); open++; }
    // The index holds them folded to lower case, and a DOI does not care.
    return doi.length > 7 ? doi.toLowerCase() : '';
  }

  const onePmid = (markup) => REF_PMID.exec(String(markup ?? ''))?.[1].replace(/^0+/, '') || '';

  /* What there is to look this reference up by. Read off the markup rather
   * than the text: the identifier is usually in an `href`, and `plain()` would
   * have thrown the hrefs away before we got here. */
  function refIds(row) {
    const markup = row.input.value;
    return { doi: oneDoi(markup), pmid: onePmid(markup) };
  }

  const hasId = (ids) => !!(ids.doi || ids.pmid);

  // ————————————————————————————————————— the index, as a file to search

  const retractions = { index: null, asked: null, chips: [], run: 0, summary: null };

  /* The file, once, and kept for as long as the page lives.
   *
   * Not put in `sessionStorage` like the other fetched lists: it is four and a
   * half megabytes, the quota is five for the whole origin, and the lint
   * answer already lives in there. GitHub serves it with `max-age=300` and
   * gzipped — 900 kB on the wire — so the browser's own cache covers the
   * second press, and a press is what this costs. Nothing is fetched until
   * somebody asks. */
  function retractionIndex() {
    if (retractions.index !== null) return Promise.resolve(retractions.index);
    if (retractions.asked) return retractions.asked;
    retractions.asked = new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: INDEX_URL,
        timeout: INDEX_TIMEOUT,
        onload: (r) => {
          const body = r.responseText || '';
          if (r.status >= 400 || body.length > INDEX_MAX || !body.startsWith('#')) {
            return resolve(null);
          }
          retractions.index = body;
          resolve(body);
        },
        onerror: () => resolve(null),
        ontimeout: () => resolve(null),
      });
    }).finally(() => { retractions.asked = null; });
    return retractions.asked;
  }

  /* The day the index was built, off its own header, for the note to print.
   * An answer from a file is worth exactly what its date says it is. */
  function indexDate(index) {
    return /^# Built:\s+(\d{4}-\d{2}-\d{2})/m.exec(index || '')?.[1] || '';
  }

  const EVENTS = {
    R: { state: 'retracted', word: 'Retracted' },
    E: { state: 'concern', word: 'Expression of concern' },
    I: { state: 'reinstated', word: 'Reinstated' },
  };

  /* One line of the index, found by the identifier that starts it.
   *
   * `indexOf` over four megabytes of string, which takes about a millisecond
   * and allocates nothing. The newline in front anchors it to the start of a
   * line and the tab behind it to the end of the identifier, so a DOI cannot
   * match a longer DOI that begins with it. */
  function indexLine(index, id) {
    if (!index || !id) return null;
    const at = index.indexOf(`\n${id}\t`);
    if (at < 0) return null;
    const end = index.indexOf('\n', at + 1);
    const [, code, when, notice] =
      (end < 0 ? index.slice(at + 1) : index.slice(at + 1, end)).split('\t');
    const event = EVENTS[code];
    return event ? { ...event, when: when || '', notice: notice || '', by: id } : null;
  }

  const askIndex = (index, ids) =>
    indexLine(index, ids.doi) || indexLine(index, ids.pmid);

  // ————————————————————————————————————————————— and PubMed, as it is now

  /* One `esearch`, as a POST.
   *
   * POST because the term is as long as the reference list — forty DOIs is
   * well past what a URL should carry — and NCBI document POST for exactly
   * this. Every DOI goes in quoted: a DOI like
   * `10.1016/S0140-6736(97)11096-0` has brackets in it, and unquoted those
   * brackets are PubMed's own grouping syntax, which silently turns one
   * identifier into two halves of a query and finds neither. */
  function eutils(path, body) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: EUTILS + path,
        timeout: EUTILS_TIMEOUT,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: `tool=${EUTILS_TOOL}&${body}`,
        onload: (r) => {
          if (r.status === 429) return reject(new Error('PubMed asked us to slow down.'));
          if (r.status >= 400) return reject(new Error(`PubMed answered ${r.status}.`));
          const text = r.responseText || '';
          if (text.length > EUTILS_MAX) return reject(new Error('PubMed answered more than we asked for.'));
          resolve(text);
        },
        onerror: () => reject(new Error('PubMed could not be reached (network, or @connect).')),
        ontimeout: () => reject(new Error('PubMed took too long to answer.')),
      });
    });
  }

  const quoted = (doi) => `"${doi.replace(/"/g, '')}"[aid]`;

  async function esearch(ids) {
    const term = ids.map((id) => (/^\d+$/.test(id) ? `${id}[uid]` : quoted(id))).join(' OR ');
    const said = await eutils('esearch.fcgi',
      `db=pubmed&retmode=json&retmax=500&term=${encodeURIComponent(`(${term})`)}`);
    let json = null;
    try { json = JSON.parse(said); } catch { /* answered below */ }
    const list = json?.esearchresult?.idlist;
    if (!Array.isArray(list)) throw new Error('PubMed answered something that was not a search result.');
    return list;
  }

  /* The records themselves, in MEDLINE rather than XML.
   *
   * MEDLINE is the tagged text format, and it carries the four tags this
   * whole feature turns on: `PT` holds "Retracted Publication" where the paper
   * has been withdrawn, `RIN` the notice that withdrew it — journal, date,
   * DOI and PubMed ID, which is the citation an editor wants in its place —
   * `ECI` an expression of concern about it, and `ROF` marks a record that IS
   * a retraction notice rather than a paper with one.
   *
   * It is also the only format that answers the second question. The `[pt]`
   * search filter finds retracted papers and nothing else: in PubMed an
   * expression of concern is a tag on the NOTICE, not on the paper it is about,
   * so a search can never find the paper by it. Fetching the records finds it,
   * because `ECI` is on the record. */
  const efetch = (ids) =>
    eutils('efetch.fcgi', `db=pubmed&rettype=medline&retmode=text&id=${ids.join(',')}`);

  /* MEDLINE into records. Four-letter tag, a dash, the value; continuation
   * lines are indented, and a tag can repeat — a paper with two retraction
   * notices has two `RIN` lines, which happens. */
  function medline(text) {
    const records = [];
    let record = null, tag = null;
    for (const line of String(text ?? '').split('\n')) {
      const started = /^([A-Z]{2,4})\s*-\s?(.*)$/.exec(line);
      if (started) {
        [, tag] = started;
        if (tag === 'PMID') { record = { PMID: [] }; records.push(record); }
        if (!record) continue;
        (record[tag] = record[tag] || []).push(started[2]);
      } else if (record && tag && /^\s+\S/.test(line)) {
        const held = record[tag];
        held[held.length - 1] += ` ${line.trim()}`;
      }
    }
    return records.map((r) => ({
      pmid: tidy(r.PMID?.[0]),
      // `AID` and `LID` both carry it, and on most records they carry the
      // same one, so this is a set rather than a list of two identical DOIs.
      dois: [...new Set([...(r.AID || []), ...(r.LID || [])]
        .filter((v) => /\[doi\]\s*$/.test(v))
        .map((v) => tidy(v.replace(/\s*\[doi\]\s*$/, '')).toLowerCase()))],
      types: (r.PT || []).map(tidy),
      retractedIn: (r.RIN || []).map(tidy),
      concernIn: (r.ECI || []).map(tidy),
      isNotice: !!(r.ROF || r.ECF),
    }));
  }

  /* What one PubMed record says about itself. `null` is the useful answer
   * here — PubMed knows this paper and has nothing against it — and it is not
   * the same as PubMed never having heard of it.
   *
   * `RIN` and `ECI` arrive as a citation with the notice's own identifiers
   * inside them: `Lancet. 2010 Feb 6;375(9713):445. doi: 10.1016/… PMID:
   * 20137807`. The whole line is worth printing, and the identifiers are worth
   * pulling out of it, because that is what makes the notice openable. */
  const NOTICE_DOI = /\bdoi:\s*(10\.\d{4,9}\/\S+?)[.\s]*(?:PMID|$)/i;
  const NOTICE_PMID = /\bPMID:\s*(\d{5,8})\b/i;

  /* Where there are two of them, the later one. A paper retracted in part in
   * 2004 and in full in 2010 carries both notices, and the one worth reading
   * is the one that finished the job. */
  const latestNotice = (lines) => lines
    .map((line) => [/\b((?:19|20)\d{2})\b/.exec(line)?.[1] || '', line])
    .sort((a, b) => b[0].localeCompare(a[0]))[0];

  function pubmedEvent(record) {
    const retracted = record.types.some((t) => /^Retracted Publication$/i.test(t));
    const says = (latestNotice(record.retractedIn.length ? record.retractedIn
      : record.concernIn) || ['', ''])[1];
    const event = retracted ? EVENTS.R : record.concernIn.length ? EVENTS.E : null;
    if (!event) return null;
    return {
      ...event,
      when: /\b((?:19|20)\d{2})\b/.exec(says)?.[1] || '',
      notice: NOTICE_PMID.exec(says)?.[1] || NOTICE_DOI.exec(says)?.[1]?.replace(/[.,;]+$/, '') || '',
      says,
      by: record.pmid,
    };
  }

  /* Every reference PubMed can be asked about, in chunks, and the answers
   * filed under both of the identifiers they can be claimed by. A reference
   * that went in as a DOI comes back as a PubMed record, and the DOI on that
   * record is how it finds its way home. */
  async function askPubmed(wanted) {
    const found = new Map();
    const chunks = [];
    for (let i = 0; i < wanted.length; i += EUTILS_CHUNK) {
      chunks.push(wanted.slice(i, i + EUTILS_CHUNK));
    }
    for (const [n, chunk] of chunks.entries()) {
      if (n) await new Promise((r) => setTimeout(r, EUTILS_GAP));
      const pmids = await esearch(chunk);
      if (!pmids.length) continue;
      await new Promise((r) => setTimeout(r, EUTILS_GAP));
      for (const record of medline(await efetch(pmids))) {
        if (record.isNotice) continue;    // the notice itself is not the paper
        const event = pubmedEvent(record);
        if (record.pmid) found.set(record.pmid, event);
        for (const doi of record.dois) found.set(doi, event);
      }
    }
    return found;
  }

  // ——————————————————————————————————————————————————— the two together

  /* One reference, both answers, one thing to say.
   *
   * `heard` holds what PubMed returned, and a key being absent from it is
   * itself an answer: PubMed has never heard of this identifier, so its
   * silence means nothing and the index is all there is. Where PubMed does
   * know the paper, it governs — it is today's record and the index is a
   * photograph — and where the two then differ, both are printed. An editor
   * reading "the index says expression of concern, PubMed says retracted" has
   * learnt something true; an editor shown one of those with the other quietly
   * dropped has not. */
  const WORSE = { retracted: 3, concern: 2, reinstated: 1 };

  function retractionVerdict(ids, index, heard) {
    const filed = askIndex(index, ids);
    const key = [ids.doi, ids.pmid].find((id) => id && heard.has(id));
    const known = key !== undefined;
    const live = known ? heard.get(key) : null;

    /* Either source flagging it is enough, and the more serious of the two
     * names the chip.
     *
     * Not "the live answer governs", which is what this did first and was
     * wrong: PubMed tags a retraction some weeks after the notice appears, so
     * an index entry PubMed has not caught up with is a real retraction, and
     * letting PubMed's silence cancel it would turn the safer source into a
     * reason to say nothing. PubMed governs the WORDING, where both speak and
     * they differ — it is the later record — and that disagreement is printed
     * rather than resolved out of sight. */
    const event = [live, filed]
      .filter(Boolean)
      .sort((a, b) => WORSE[b.state] - WORSE[a.state])[0] || null;
    const sources = sourceLine(index, filed, known, live);

    if (!event) {
      return {
        state: 'clean',
        head: known ? 'Not retracted' : 'Nothing against it',
        why: known
          ? 'PubMed holds this paper with no retraction and no expression of concern '
            + 'against it, and it is not in the Retraction Watch index either.'
          : 'It is not in the Retraction Watch index, and PubMed has never heard of this '
            + 'identifier — so there was only one place to look, and it had nothing.',
        sources, filed, live, known,
      };
    }
    return {
      state: event.state,
      head: event.word,
      why: retractionWhy(event, filed, live),
      sources, filed, live, known, event,
    };
  }

  function retractionWhy(event, filed, live) {
    if (event.state === 'reinstated') {
      return 'This paper was retracted and the retraction was itself withdrawn. It stands, '
        + 'and citing it is not a mistake — but the history is worth knowing.';
    }
    const when = event.when ? ` in ${event.when}` : '';
    const head = event.state === 'retracted'
      ? `The paper behind this reference was withdrawn${when}.`
      : `A journal has published an expression of concern about this paper${when}.`;
    if (filed && live && filed.state !== live.state) {
      return `${head} The two sources do not agree on which: the index has it as `
        + `${filed.word.toLowerCase()}, PubMed as ${live.word.toLowerCase()}, and PubMed `
        + 'is the later record.';
    }
    if (filed && !live) {
      return `${head} It is the index that says so; PubMed `
        + 'has nothing against it, which is also what it looks like when a notice has '
        + 'appeared and PubMed has not tagged it yet.';
    }
    return `${head} Citing it may still be what this article means to do — nothing here `
      + 'changes the reference.';
  }

  function sourceLine(index, filed, known, live) {
    const parts = [];
    parts.push(index
      ? `Retraction Watch index of ${indexDate(index) || 'unknown date'}: `
        + (filed ? filed.word.toLowerCase() : 'nothing')
      : 'Retraction Watch index: could not be read');
    parts.push(`PubMed, live: ${!known ? 'does not hold this identifier'
      : live ? live.word.toLowerCase() : 'nothing against it'}`);
    return parts.join(' · ');
  }

  // ————————————————————————————————————————————————————— the chips and the press

  const RETRACTION_WORD = {
    retracted: '⊘ retracted',
    concern: '⚠ concern',
    reinstated: '↺ reinstated',
  };

  /* A chip only where there is something to say.
   *
   * The other chips in this file sit beside every reference because every
   * reference has a wording to check. This one would be thirty-nine greens and
   * one red, and the thirty-nine would be what you learned to stop reading.
   * So the clean ones get nothing, the toolbar carries the count, and a chip
   * on the page means a paper to look at. */
  function markRetraction(row, verdict) {
    if (!RETRACTION_WORD[verdict.state]) return null;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `rlx-cite rlx-flag rlx-flag-${verdict.state}`;
    chip.textContent = RETRACTION_WORD[verdict.state];
    chip.title = verdict.why;
    chip.addEventListener('click', (e) => {
      e.preventDefault();
      showRetraction(row, chip, verdict);
    });
    (row.chip || row.after).insertAdjacentElement('afterend', chip);
    retractions.chips.push(chip);
    return chip;
  }

  function clearRetractions() {
    for (const chip of retractions.chips) chip.remove();
    retractions.chips = [];
    retractions.summary = null;
    paintSweepToggle();
  }

  /* The press. Every reference with an identifier in it, in two requests, and
   * then the few that need saying. */
  async function sweepRetractions() {
    if (!inEditor()) return;
    const run = ++retractions.run;
    clearRetractions();
    closeCiteNote();

    const rows = referenceFields();
    const seen = rows.map((row) => ({ row, ids: refIds(refresh(row)) }));
    const askable = seen.filter((s) => hasId(s.ids));
    if (!askable.length) {
      retractions.summary = { rows: rows.length, asked: 0, flagged: [], trouble: null };
      return paintSweepToggle();
    }

    setSweepBusy(true);
    const index = await retractionIndex();
    if (run !== retractions.run) return;

    let heard = new Map(), trouble = null;
    const wanted = [...new Set(askable.flatMap((s) => [s.ids.doi, s.ids.pmid].filter(Boolean)))];
    try {
      heard = await askPubmed(wanted);
    } catch (err) {
      trouble = err.message;      // the index still has something to say
    }
    if (run !== retractions.run) return;
    setSweepBusy(false);

    const flagged = [];
    for (const { row, ids } of askable) {
      if (!row.input.isConnected) continue;
      const verdict = retractionVerdict(ids, index, heard);
      const chip = markRetraction(row, verdict);
      if (chip) flagged.push({ row, chip, verdict });
    }
    retractions.summary = {
      rows: rows.length, asked: askable.length, flagged,
      known: askable.filter((s) => [s.ids.doi, s.ids.pmid].some((id) => id && heard.has(id))).length,
      index, trouble,
    };
    paintSweepToggle();
    showSweep();
  }

  /* What the toolbar says once it has been pressed: the count, because a sweep
   * that found nothing has to look different from a sweep nobody ran. */
  function paintSweepToggle() {
    if (!sweepToggle) return;
    const found = retractions.summary;
    sweepToggle.classList.toggle('rlx-on', !!found);
    sweepToggle.classList.toggle('rlx-flagged', !!found?.flagged.length);
    sweepToggle.textContent = found
      ? `⊘ ${found.flagged.length}`
      : '⊘';
    sweepToggle.title = found
      ? sweepSentence(found) + ' — press again to check once more'
      : 'Check every reference against the Retraction Watch index and PubMed';
  }

  function setSweepBusy(busy) {
    if (!sweepToggle) return;
    sweepToggle.disabled = busy;
    if (busy) sweepToggle.textContent = '⊘ …';
  }

  function sweepSentence(found) {
    if (!found.asked) {
      return found.rows
        ? `None of the ${found.rows} references carries a DOI or a PubMed ID to look up`
        : 'No references to check';
    }
    const flags = found.flagged.length;
    const head = flags
      ? `${flags} of ${found.asked} references ${flags === 1 ? 'has' : 'have'} been withdrawn or questioned`
      : `Nothing against any of the ${found.asked} references that could be looked up`;
    const rest = [];
    if (found.asked < found.rows) rest.push(`${found.rows - found.asked} had no identifier`);
    if (found.known != null && found.known < found.asked) {
      rest.push(`${found.asked - found.known} unknown to PubMed`);
    }
    if (found.trouble) rest.push('PubMed could not be asked');
    else if (found.index) rest.push(`index of ${indexDate(found.index)}`);
    else rest.push('the index could not be read');
    return `${head} (${rest.join(', ')})`;
  }

  // ———————————————————————————————————————————————————————————— the notes

  /* Both notes are the citation note's panel, borrowed: same box, same
   * placement, same Escape, so there is one thing on screen at a time and one
   * piece of code deciding where it goes. */
  function panel(anchor, where, state, head, why) {
    closeCiteNote();
    const note = document.createElement('div');
    note.id = 'rlx-cite-note';
    note.style.borderLeftColor =
      state === 'retracted' ? COLORS.error.ink
        : state === 'concern' ? COLORS.warning.ink
          : state === 'clean' ? '#059669' : COLORS.other.ink;

    const line = document.createElement('div');
    line.className = 'rlx-cite-head';
    const what = document.createElement('strong');
    what.textContent = head;
    const place = document.createElement('span');
    place.textContent = where;
    line.append(what, place);

    const reason = document.createElement('div');
    reason.className = 'rlx-cite-why';
    reason.textContent = why;
    note.append(line, reason);

    document.body.appendChild(note);
    cites.note = note;
    cites.open = { chip: anchor };
    return note;
  }

  function finishPanel(note, acts) {
    note.appendChild(acts);
    const shut = document.createElement('button');
    shut.textContent = 'Close';
    shut.addEventListener('click', closeCiteNote);
    acts.appendChild(shut);
    placeCiteNote();
    document.addEventListener('keydown', onCiteKey, true);
    addEventListener('scroll', placeCiteNote, true);
    addEventListener('resize', placeCiteNote);
  }

  const actsRow = () => {
    const acts = document.createElement('div');
    acts.className = 'rlx-cite-acts';
    return acts;
  };

  function labelled(note, label, text) {
    const head = document.createElement('div');
    head.className = 'rlx-cite-label';
    head.textContent = label;
    const body = document.createElement('div');
    body.className = 'rlx-cite-text';
    body.textContent = text;
    note.append(head, body);
  }

  /* One reference's answer. The notice is the point of it: `RIN` comes back
   * from PubMed as a citation with its own DOI and PubMed ID in it, and that
   * is the thing to read next and, where an article still wants to mention the
   * paper, the thing to cite beside it. */
  function showRetraction(row, chip, verdict) {
    const note = panel(chip, `reference ${row.pos}`, verdict.state, verdict.head, verdict.why);

    const says = verdict.live?.says;
    if (says) labelled(note, 'the notice, as PubMed has it', says);
    else if (verdict.filed?.notice) {
      labelled(note, 'the notice', verdict.filed.notice);
    }
    labelled(note, 'asked', verdict.sources);

    const acts = actsRow();
    const notice = verdict.event?.notice || verdict.filed?.notice;
    if (notice) {
      const open = document.createElement('button');
      open.textContent = 'Open the notice';
      open.title = 'The retraction notice itself, at the publisher or at PubMed';
      open.addEventListener('click', () => {
        window.open(/^\d+$/.test(notice)
          ? `https://pubmed.ncbi.nlm.nih.gov/${notice}/`
          : `https://doi.org/${notice}`, '_blank', 'noopener');
      });
      acts.appendChild(open);
    }
    const ids = refIds(row);
    if (ids.pmid || ids.doi) {
      const paper = document.createElement('button');
      paper.textContent = 'Open the paper';
      paper.addEventListener('click', () => {
        window.open(ids.pmid
          ? `https://pubmed.ncbi.nlm.nih.gov/${ids.pmid}/`
          : `https://doi.org/${ids.doi}`, '_blank', 'noopener');
      });
      acts.appendChild(paper);
    }
    finishPanel(note, acts);
  }

  /* And the sweep's own answer, which is mostly a number — but a number with
   * what it could not do printed under it, because "nothing found" and "could
   * not look" are not the same sentence and the chips cannot tell them apart. */
  function showSweep() {
    const found = retractions.summary;
    if (!found || !sweepToggle) return;
    const state = found.flagged.length ? 'retracted' : found.asked ? 'clean' : 'unknown';
    const note = panel(sweepToggle, 'references', state,
      found.flagged.length ? `${found.flagged.length} to look at` : 'Nothing to flag',
      sweepSentence(found) + '.');

    if (found.flagged.length) {
      labelled(note, 'flagged', found.flagged
        .map(({ row, verdict }) => `${row.pos}. ${verdict.head.toLowerCase()}`)
        .join(' · '));
    }
    if (found.trouble) labelled(note, 'PubMed', found.trouble);

    const acts = actsRow();
    if (found.flagged.length) {
      const first = document.createElement('button');
      first.textContent = 'Show the first';
      first.addEventListener('click', () => {
        const { row, chip, verdict } = found.flagged[0];
        row.input.scrollIntoView({ block: 'center' });
        showRetraction(row, chip, verdict);
      });
      acts.appendChild(first);
    }
    finishPanel(note, acts);
  }

  // ————————————————————————————————————————————————————————————— the links

  /* Words in the article that are the title of another Radiopaedia article and
   * are not linked to it anywhere in the text.
   *
   * The house rule is one link per article, at the first place the name
   * occurs. So the question is asked once per target article, not once per
   * word: if the article links to it anywhere, even further down, it is not
   * offered at all, and if it does not, the first occurrence in running text is
   * the one offered and the later ones are left alone.
   *
   * The names come from `article-links.tsv`, next to this file in the
   * repository and fetched the way `proper-nouns.txt` is. One line per
   * article: its slug (and the slugs that redirect to it), its title, how often
   * other articles that mention it also link it, and the names it is looked for
   * under. `tools/article-links.js` writes it from a Radiopaedia search export
   * and, when it has one, from a local copy of the articles, which is where the
   * other names come from: the words articles already use when they link to it
   * ("CSF" for cerebrospinal fluid, "skull base" for base of the skull).
   *
   * What counts as running text is what `trova.py` in neuropedia settled on:
   * not a heading, not the text of a link already there, not a reference
   * marker, and not bold, which on Radiopaedia is the article's own name and
   * its synonyms in the first sentence.
   *
   * The longest name wins. "Abducens nerve palsy" takes all three words, and
   * the "abducens nerve" inside it is not offered as well. That holds even
   * when the long one is not offered (already linked, or the article itself):
   * its words are used up either way.
   *
   * Everything down to `the links, in the editor` is plain functions of
   * strings, so `tools/article-links.js` can run the same matcher over a whole
   * copy of Radiopaedia without a browser. */

  /* The plurals a trailing `s` does not cover, and the Latin ones whose
   * singular is not the plural minus a letter. Both sides of the comparison go
   * through the same table, so it only has to be right about which words are
   * the same word, not about the grammar. */
  const LINK_IRREGULAR = {
    ganglia: 'ganglion', foramina: 'foramen', septa: 'septum', diverticula: 'diverticulum',
    criteria: 'criterion', phenomena: 'phenomenon', atria: 'atrium', meninges: 'meninx',
    corpora: 'corpus', lumina: 'lumen', foci: 'focus', gyri: 'gyrus', cortices: 'cortex',
    vertices: 'vertex', apices: 'apex', indices: 'index', cervices: 'cervix',
    sulci: 'sulcus', nuclei: 'nucleus', thalami: 'thalamus', hippocampi: 'hippocampus',
    fasciculi: 'fasciculus', plexuses: 'plexus', sinuses: 'sinus', viruses: 'virus',
    fungi: 'fungus', emboli: 'embolus', calculi: 'calculus', bronchi: 'bronchus',
    teeth: 'tooth', feet: 'foot', children: 'child', women: 'woman', men: 'man',
  };

  /* One word, in the shape two spellings of it compare equal in: no accents,
   * no case, British and American spelling folded together (oedema, edema;
   * haemorrhage, hemorrhage; tumour, tumor), and the plural taken off.
   *
   * An abbreviation is the exception and keeps its case: "CN" is not "CNS"
   * and "MS" is not "ms". Two capitals and no small letter makes one, with a
   * plural `s` allowed on the end ("AVMs"). */
  function linkKey(word) {
    const w = String(word ?? '').normalize('NFD').replace(/\p{M}+/gu, '');
    const bare = w.replace(/(?<=\p{Lu})s$/u, '');
    if ((bare.match(/\p{Lu}/gu) || []).length >= 2 && !/\p{Ll}/u.test(bare)) return '=' + bare;

    let k = w.toLowerCase();
    if (LINK_IRREGULAR[k]) return LINK_IRREGULAR[k];
    if (k.length > 4 && k.endsWith('ae')) k = k.slice(0, -1);       // vertebrae, fossae
    k = k.replace(/ae|oe/g, 'e').replace(/(?<=[a-z]{2})our/g, 'or');
    if (k === 'grey') k = 'gray';
    if (k.length > 4) {
      if (k.endsWith('omata')) k = k.slice(0, -2);                   // carcinomata
      else if (k.endsWith('oses')) k = k.slice(0, -2) + 'is';        // stenoses
      else if (k.endsWith('ies')) k = k.slice(0, -3) + 'y';          // arteries
      else if (/(?:ss|x|ch|sh)es$/.test(k)) k = k.slice(0, -2);      // abscesses
      else if (/[^siu]s$/.test(k)) k = k.slice(0, -1);               // tubers; not -ss -is -us
    }
    return k;
  }

  /* The words of a string, with where each one is. A word is a run of letters
   * and digits, so "IDH-wildtype" is two of them and what stands between them
   * is checked separately — see `linkGap`. A possessive `'s` belongs to the
   * word before it: "Wernicke's" and "Wernicke" are one word, and a link put
   * on the first takes the `'s` in with it. */
  const LINK_TOKEN = /[\p{L}\p{N}]+/gu;

  function linkTokens(text) {
    const out = [];
    for (const m of String(text ?? '').matchAll(LINK_TOKEN)) {
      const from = m.index, to = from + m[0].length;
      const prev = out[out.length - 1];
      if (prev && m[0] === 's' && /^['’ʼ]$/.test(text.slice(prev.to, from))) {
        prev.to = to;
        continue;
      }
      out.push({ from, to, key: linkKey(m[0]) });
    }
    return out;
  }

  /* What stands between two words, reduced to what has to match: a space and
   * a hyphen are the same thing ("T2-weighted", "T2 weighted"), and so is
   * nothing at all between them, while a comma or a slash has to be there in
   * the article as it is in the name ("Glioblastoma, IDH-wildtype",
   * "HIV/AIDS"). */
  function linkGap(gap) {
    return String(gap ?? '')
      .replace(/[\s\u00a0\u200b-\u200d\u2060\ufeff\u00ad]+/g, '')
      .replace(/[-‐‑–—]/g, '');
  }

  /* A name, compiled: its words' keys and the gaps between them. */
  function linkPhrase(text) {
    const toks = linkTokens(text);
    if (!toks.length) return null;
    const gaps = [];
    for (let i = 1; i < toks.length; i++) gaps.push(linkGap(text.slice(toks[i - 1].to, toks[i].from)));
    return { keys: toks.map((t) => t.key), gaps, text: String(text) };
  }

  /* `article-links.tsv`:
   *
   *     slug[ redirect …] <TAB> title <TAB> linked/mentioned <TAB> name <TAB> name …
   *
   * `linked/mentioned` is out of the copy the file was made from: of the
   * articles that mention this one, how many link to it. A blank there is
   * "not measured", which is not the same as nought. The names are the
   * strings looked for; with none, the title is.
   *
   * Lines starting with `#` are comments, and a line that does not parse is
   * skipped rather than trusted. */
  const LINK_SLUG = /^[a-z0-9][a-z0-9-]*$/;

  function parseLinkIndex(text) {
    const entries = new Map();     // every slug, redirects included → its entry
    const byFirst = new Map();     // a name's first key → the names starting with it
    for (const line of String(text ?? '').split(/\r?\n/)) {
      if (!line.trim() || line.startsWith('#')) continue;
      const [slugs, title, rate, ...names] = line.split('\t').map((s) => s.trim());
      const all = String(slugs || '').split(/\s+/).filter((s) => LINK_SLUG.test(s));
      if (!all.length || !title) continue;
      const [linked, mentioned] = String(rate || '').split('/').map((n) => parseInt(n, 10));
      const entry = {
        slug: all[0], slugs: all, title,
        linked: Number.isFinite(linked) ? linked : null,
        mentioned: Number.isFinite(mentioned) ? mentioned : null,
        phrases: [],
      };
      const own = linkPhrase(title)?.keys.join('\u0001');
      for (const name of (names.filter(Boolean).length ? names.filter(Boolean) : [title])) {
        const p = linkPhrase(name);
        if (!p) continue;
        p.entry = entry;
        p.isTitle = p.keys.join('\u0001') === own;
        entry.phrases.push(p);
        const k = p.keys[0];
        if (!byFirst.has(k)) byFirst.set(k, []);
        byFirst.get(k).push(p);
      }
      if (!entry.phrases.length) continue;
      for (const s of all) if (!entries.has(s)) entries.set(s, entry);
    }
    for (const list of byFirst.values()) list.sort((a, b) => b.keys.length - a.keys.length);
    return { entries, byFirst, size: new Set(entries.values()).size };
  }

  function linkMatchesAt(toks, i, p, text) {
    if (i + p.keys.length > toks.length) return false;
    for (let j = 0; j < p.keys.length; j++) {
      const t = toks[i + j];
      if (t.out || t.key !== p.keys[j]) return false;
      if (j) {
        const gap = text.slice(toks[i + j - 1].to, t.from);
        if (gap.length > 3 || linkGap(gap) !== p.gaps[j - 1]) return false;
      }
    }
    return true;
  }

  /* When two articles answer to the same name, the one whose title IS that
   * name comes first ("Fornix (brain)" loses "fornix" to a "Fornix" if there
   * is one), then the one other articles link more often. The rest are kept
   * as alternatives to offer, not thrown away. */
  function linkPreference(a, b) {
    return (b.isTitle - a.isTitle) || ((b.entry.linked ?? 0) - (a.entry.linked ?? 0))
      || (a.entry.title.length - b.entry.title.length);
  }

  /* Every name in the text, longest first and left to right, none
   * overlapping. `blocks` is the text cut where the article cuts it — a
   * paragraph, a list item, a heading — each with `out`, one flag per
   * character, true where the character is not running text. A name never
   * spans two blocks, and never touches a character that is out. */
  function linkHits(blocks, index) {
    const hits = [];
    blocks.forEach((block, b) => {
      const text = block.text;
      const toks = linkTokens(text);
      for (const t of toks) {
        t.out = false;
        for (let c = t.from; c < t.to; c++) if (block.out[c]) { t.out = true; break; }
      }
      let i = 0;
      while (i < toks.length) {
        const options = toks[i].out ? null : index.byFirst.get(toks[i].key);
        const matched = [];
        if (options) {
          for (const p of options) {
            if (matched.length && p.keys.length < matched[0].keys.length) break;
            if (linkMatchesAt(toks, i, p, text)) matched.push(p);
          }
        }
        if (!matched.length) { i++; continue; }
        const n = matched[0].keys.length;
        const from = toks[i].from, to = toks[i + n - 1].to;
        i += n;
        matched.sort(linkPreference);
        const seen = new Set();
        const phrases = matched.filter((p) => !seen.has(p.entry) && seen.add(p.entry));
        hits.push({ block: b, from, to, words: text.slice(from, to), phrases });
      }
    });
    return hits;
  }

  /* The ones to offer. `linked` is every slug the article already links to;
   * `self` is the article's own; `skip` is the slugs you said not to offer.
   * Any of those, for any of the articles a name could mean, and the name is
   * used up without being offered — so is every later occurrence of a target
   * already offered once. */
  function linkCandidates(blocks, index, { linked = new Set(), self = null, skip = new Set() } = {}) {
    const done = new Set();
    const out = [];
    for (const hit of linkHits(blocks, index)) {
      const entries = hit.phrases.map((p) => p.entry);
      const settled = entries.some((e) => done.has(e) || e.slugs.some((s) =>
        s === self || linked.has(s) || skip.has(s)));
      for (const e of entries) done.add(e);
      if (settled) continue;
      out.push({ ...hit, entry: entries[0], others: entries.slice(1) });
    }
    return out;
  }

  // ————————————————————————————————————————————————— the links, in the editor

  /* The file, read once per tab like the lists. It is a quarter of a megabyte
   * of names, which is more than `LIST_MAX` lets a word list be, so it carries
   * its own ceiling. An unreadable file is said out loud here, unlike the
   * lists: this one is read because somebody pressed a button for it, and a
   * panel that says "nothing to link" when it could not look would be a lie. */
  const LINKS = {
    file: 'article-links.tsv',
    cache: 'rlx-links',
    url: RAW_URL + 'article-links.tsv',
    max: 4 * 1024 * 1024,
    index: null,
    asked: null,
  };
  const LINKS_SKIP_KEY = 'rlx-links-skip';     // {article: [targets you said not to link here]}
  const LINKS_NEVER_KEY = 'rlx-links-never';   // {target: the day you said never}
  const LINK_BASE = 'https://radiopaedia.org/articles/';

  function linkIndex() {
    if (LINKS.index) return Promise.resolve(LINKS.index);
    if (LINKS.asked) return LINKS.asked;
    LINKS.asked = (async () => {
      let text = sessionStorage.getItem(LINKS.cache);
      if (text == null) {
        text = await askList(LINKS);
        if (text != null) {
          try { sessionStorage.setItem(LINKS.cache, text); } catch { /* quota: never mind */ }
        }
      }
      LINKS.index = text == null ? null : parseLinkIndex(text);
      LINKS.asked = null;      // a failure is asked again on the next press
      return LINKS.index;
    })();
    return LINKS.asked;
  }

  /* The editor's text, cut the way `linkHits` wants it: one block per
   * paragraph, list item or heading, a line break ending one too, and every
   * character flagged when it is not running text. The text nodes each block
   * was read from are kept with where they start, which is all a Range needs.
   *
   * Nothing here is cached. The panel scans again before every action, because
   * the text it found the name in five seconds ago may not be the text in the
   * editor now. */
  const LINK_OUT = 'a, sup, sub, strong, b, h1, h2, h3, h4, h5, h6, code, pre';

  function linkBlocks(roots) {
    const blocks = [];
    for (const { root, frame } of roots) {
      const walker = root.ownerDocument.createTreeWalker(root,
        NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
      let cur = null;
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n.nodeType === 1) {
          if (n.tagName === 'BR') cur = null;
          continue;
        }
        const p = n.parentElement;
        if (!p || p.closest('script, style, noscript')) continue;
        const owner = p.closest(BLOCKS) || root;
        if (!cur || cur.owner !== owner) {
          cur = { owner, root, frame, text: '', out: [], pieces: [] };
          blocks.push(cur);
        }
        const raw = n.nodeValue || '';
        const out = !!p.closest(LINK_OUT);
        cur.pieces.push({ node: n, at: cur.text.length });
        cur.text += raw;
        for (let i = 0; i < raw.length; i++) cur.out.push(out);
      }
    }
    return blocks;
  }

  /* Every article the text already links to, whatever the href looks like:
   * `/articles/x`, `https://radiopaedia.org/articles/x?lang=us`. */
  const ARTICLE_HREF = /^(?:https?:\/\/(?:www\.)?radiopaedia\.org)?\/articles\/([a-z0-9][a-z0-9-]*)/i;

  function linkedHere(roots) {
    const out = new Set();
    for (const { root } of roots) {
      for (const a of root.querySelectorAll('a[href]')) {
        const m = ARTICLE_HREF.exec(a.getAttribute('href') || '');
        if (m) out.add(m[1].toLowerCase());
      }
    }
    return out;
  }

  function skippedHere(self) {
    return new Set([...(readMap(LINKS_SKIP_KEY)[self] || []),
                    ...Object.keys(readMap(LINKS_NEVER_KEY))]);
  }

  async function scanLinks() {
    const index = await linkIndex();
    if (!index) return { trouble: `${LINKS.file} could not be read from GitHub.` };
    const roots = editorRoots().filter((r) => (r.root.textContent || '').trim().length > 40);
    if (!roots.length) return { trouble: 'Cannot find the editor text.' };
    const blocks = linkBlocks(roots);
    const self = currentSlug();
    const linked = linkedHere(roots);
    const found = linkCandidates(blocks, index, { linked, self, skip: skippedHere(self) })
      .map((c) => ({ ...c, at: blocks[c.block] }));
    return { index, found, linked };
  }

  /* The words of one candidate, as a Range in the editor. `oneNode` says
   * whether they sit inside a single text node, which is the only shape the
   * link is written into: across two, the words straddle a tag — half of them
   * in italics, say — and wrapping a link round that is a judgement about
   * markup this script does not make. */
  function linkRange(c) {
    const { pieces, root } = c.at;
    let start = null, end = null;
    for (const piece of pieces) {
      const len = (piece.node.nodeValue || '').length;
      if (!start && c.from < piece.at + len) start = { node: piece.node, offset: c.from - piece.at };
      if (c.to <= piece.at + len) { end = { node: piece.node, offset: c.to - piece.at }; break; }
    }
    if (!start || !end) return null;
    const range = root.ownerDocument.createRange();
    try {
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
    } catch { return null; }
    return { range, oneNode: start.node === end.node };
  }

  /* Show: the words selected in the editor and scrolled to the middle of it.
   * The editor's own selection is the highlight — it is what the link will be
   * put on, and it is gone the moment you click anywhere else. */
  function showLink(c) {
    const spot = linkRange(c);
    if (!spot) return 'the words are not where they were — scan again';
    c.at.owner.scrollIntoView?.({ block: 'center' });
    const doc = spot.range.startContainer.ownerDocument;
    try { doc.defaultView.focus(); } catch { /* never mind */ }
    const sel = doc.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(spot.range);
    return null;
  }

  /* Link: the editor's own `createLink` on exactly those words, so TinyMCE
   * hears it, marks the form dirty and Ctrl + Z takes it back — the same
   * bargain every Fix makes, through the same `runCommand`. The href is the
   * full address, which is how Radiopaedia renders a link to one of its own
   * articles no matter how the editor would have rewritten a relative one. */
  function writeLink(c, slug) {
    const spot = linkRange(c);
    if (!spot) return 'the words are not where they were — scan again';
    if (!spot.oneNode) return 'these words straddle other markup — link them by hand';
    c.at.owner.scrollIntoView?.({ block: 'center' });
    return runCommand(spot.range, 'createLink', LINK_BASE + slug);
  }

  // ——————————————————————————————————————————————————— the links panel

  const links = { panel: null, said: null, run: 0, count: null };
  let linksToggle = null;

  /* Rarely linked: of the articles in the copy the file was measured on that
   * name it, fewer than one in seven link it. "Brain", "white matter", "lead".
   * Not hidden — whether an article about the brain should link "brain" is an
   * editorial call — but kept under a fold, after the ones that usually are. */
  const rarelyLinked = (e) => e.mentioned >= 5 && e.linked / e.mentioned < 0.15;

  function rateTitle(e) {
    if (e.mentioned == null) return 'Not measured';
    return `${e.linked} of the ${e.mentioned} articles that mention it link to it`;
  }

  function closeLinks() {
    links.panel?.remove();
    links.panel = null;
    links.said = null;
    document.removeEventListener('keydown', onLinksKey, true);
    removeEventListener('resize', placeLinks);
    paintLinksToggle();
  }

  function onLinksKey(e) {
    if (e.key === 'Escape' && links.panel) { e.preventDefault(); closeLinks(); }
  }

  const LINKS_TITLE = 'Links: find words that are the title of another article and are not ' +
    'linked to it yet';

  /* `count` is how many the last look found, kept so that a toolbar the
   * editor has drawn again comes back with the same number on it. `busy` is
   * the look itself. */
  function paintLinksToggle(count = links.count, busy = false) {
    links.count = count;
    const inToolbar = !!toolbarLinks?.isConnected;
    if (linksToggle) {
      // One button, not two: the box keeps it only while the toolbar has none.
      linksToggle.style.display = inToolbar ? 'none' : '';
      linksToggle.classList.toggle('rlx-on', !!links.panel);
      linksToggle.disabled = busy;
      linksToggle.textContent = busy ? 'link …' : count == null ? 'link' : `link ${count}`;
      linksToggle.title = LINKS_TITLE;
    }
    if (inToolbar) {
      const b = toolbarLinks;
      b.classList.toggle('tox-tbtn--enabled', !!links.panel);
      b.setAttribute('aria-pressed', String(!!links.panel));
      b.classList.toggle('tox-tbtn--disabled', busy);
      b.setAttribute('aria-disabled', String(busy));
      b.querySelector('.rlx-tox-count').textContent = busy ? '…' : count == null ? '' : String(count);
    }
  }

  async function openLinks() {
    if (!inEditor()) return;
    const run = ++links.run;
    paintLinksToggle(links.count, true);
    const scan = await scanLinks();
    paintLinksToggle(links.count, false);
    if (run !== links.run) return;
    renderLinks(scan);
  }

  const toggleLinks = () => (links.panel ? closeLinks() : openLinks());

  /* The same button in the editor's own toolbar, right after the blockquote
   * one, where somebody editing the text already looks. It is a TinyMCE
   * toolbar button in looks only — its classes, its size, its pressed state —
   * and it does nothing through TinyMCE: the click is ours.
   *
   * TinyMCE draws its toolbar again when it likes (a window narrow enough to
   * fold it, for one), and takes this button away when it does. The page's
   * MutationObserver calls this on every change, so it is put back on the next
   * one; while it is there, this returns at the first line.
   *
   * The blockquote button is found by what it is called, in English or in
   * Italian. A toolbar with no such button gets this one at the end of its
   * last group; a page with no TinyMCE toolbar keeps it in the box by the
   * title, which is where it was before. */
  let toolbarLinks = null;
  const QUOTE_BUTTON = /block\s*quote|blockquote|citazione/i;

  function mountToolbarLinks() {
    if (toolbarLinks?.isConnected || !inEditor()) return;
    const frame = editorRoots().find((r) => r.frame)?.frame;
    const box = frame?.closest('.tox-tinymce');
    if (!box) return;
    const buttons = [...box.querySelectorAll('.tox-toolbar__group .tox-tbtn')];
    if (!buttons.length) return;
    const quote = buttons.find((b) =>
      QUOTE_BUTTON.test(`${b.getAttribute('aria-label') || ''} ${b.title || ''}`));
    const after = quote || buttons[buttons.length - 1];

    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tox-tbtn rlx-tox-links';
    b.setAttribute('aria-label', 'Links to other articles');
    b.title = LINKS_TITLE;
    b.tabIndex = -1;
    // A link with a magnifying glass on it: the toolbar's own link button is
    // the link alone, two places to the left.
    const ink = getComputedStyle(after.querySelector('svg') || after).fill || 'currentColor';
    b.innerHTML = `
      <span class="tox-icon tox-tbtn__icon-wrap"><svg width="24" height="24" viewBox="0 0 24 24"
        fill="none" stroke-width="1.7" stroke-linecap="round" aria-hidden="true">
        <path fill="none" d="M7.2 10.8l3.6-3.6"/>
        <path fill="none" d="M9.4 5.6l1.1-1.1a2.7 2.7 0 0 1 3.8 3.8l-1.1 1.1"/>
        <path fill="none" d="M8.6 12.4l-1.1 1.1a2.7 2.7 0 0 1-3.8-3.8l1.1-1.1"/>
        <circle fill="none" cx="16.3" cy="16.3" r="3.3"/>
        <path fill="none" d="M18.7 18.7l2.6 2.6"/>
      </svg></span><span class="rlx-tox-count"></span>`;
    b.querySelector('svg').style.stroke = ink === 'none' ? 'currentColor' : ink;
    b.addEventListener('click', toggleLinks);
    after.after(b);
    toolbarLinks = b;
    paintLinksToggle();
  }

  /* Everything the panel does goes through here: scan again, find the
   * candidate for that target in the text as it is NOW, act on it, draw the
   * panel again. A candidate is named by its target, not by where it was —
   * the first unlinked occurrence is the one to link, wherever it has moved. */
  async function linkAct(what, slug, to) {
    const scan = await scanLinks();
    if (scan.trouble) return renderLinks(scan);
    const c = scan.found.find((x) => x.entry.slug === slug);
    const self = currentSlug();
    let said = null;
    if (what === 'show') {
      said = c ? showLink(c) : 'already linked, or no longer in the text';
      if (!said) return;      // the selection says it; no redraw to take the focus away
    } else if (what === 'link') {
      if (!c) said = 'already linked, or no longer in the text';
      else {
        const target = scan.index.entries.get(to || slug) || c.entry;
        said = writeLink(c, target.slug) || `Linked “${c.words}” to ${target.title}. Ctrl + Z undoes it.`;
      }
    } else if (what === 'skip') {
      const map = readMap(LINKS_SKIP_KEY);
      map[self] = [...new Set([...(map[self] || []), slug])];
      writeMap(LINKS_SKIP_KEY, map);
      said = `${c?.entry.title || slug} will not be offered in this article again.`;
    } else if (what === 'never') {
      const map = readMap(LINKS_NEVER_KEY);
      map[slug] = new Date().toISOString().slice(0, 10);
      writeMap(LINKS_NEVER_KEY, map);
      said = `${c?.entry.title || slug} will not be offered in any article again.`;
    } else if (what === 'forget') {
      const map = readMap(LINKS_SKIP_KEY);
      delete map[self];
      writeMap(LINKS_SKIP_KEY, map);
      writeMap(LINKS_NEVER_KEY, {});
      said = 'Everything you set aside is offered again.';
    }
    links.said = said;
    renderLinks(await scanLinks());
  }

  function linkRow(c) {
    const e = c.entry;
    const row = document.createElement('div');
    row.className = 'rlx-l-row';

    const what = document.createElement('div');
    what.className = 'rlx-l-what';
    const words = document.createElement('button');
    words.className = 'rlx-l-words';
    words.textContent = c.words;
    words.title = 'Select these words in the editor';
    words.addEventListener('click', () => linkAct('show', e.slug));
    const arrow = document.createElement('span');
    arrow.className = 'rlx-l-arrow';
    arrow.textContent = '→';
    const title = document.createElement('a');
    title.href = LINK_BASE + e.slug;
    title.target = '_blank';
    title.rel = 'noopener';
    title.textContent = e.title;
    title.title = 'Open that article in a new tab';
    const rate = document.createElement('span');
    rate.className = 'rlx-l-rate';
    rate.textContent = e.mentioned == null ? '' : `${e.linked}/${e.mentioned}`;
    rate.title = rateTitle(e);
    what.append(words, arrow, title, rate);

    // Where it is: the words with a few on either side, as the editor has them.
    const ctx = document.createElement('div');
    ctx.className = 'rlx-l-ctx';
    const text = c.at.text;
    const a = Math.max(0, c.from - 60), b = Math.min(text.length, c.to + 60);
    const lit = document.createElement('mark');
    lit.textContent = text.slice(c.from, c.to);
    const spaced = (s) => s.replace(/\s+/g, ' ');
    ctx.append((a ? '…' : '') + spaced(text.slice(a, c.from)).trimStart(), lit,
               spaced(text.slice(c.to, b)).trimEnd() + (b < text.length ? '…' : ''));

    const acts = document.createElement('div');
    acts.className = 'rlx-l-acts';
    const btn = (label, title, fn) => {
      const el = document.createElement('button');
      el.textContent = label;
      el.title = title;
      el.addEventListener('click', fn);
      acts.appendChild(el);
      return el;
    };
    btn('Link', `Link these words to ${e.title}`, () => linkAct('link', e.slug)).className = 'rlx-l-go';
    // The same name, another article: "Fornix (brain)" or the other fornix.
    for (const o of c.others.slice(0, 3)) {
      btn(`Link to ${o.title}`, rateTitle(o), () => linkAct('link', e.slug, o.slug));
    }
    btn('Not here', 'Do not offer this one in this article again', () => linkAct('skip', e.slug));
    btn('Never', 'Do not offer this one in any article again', () => linkAct('never', e.slug));

    row.append(what, ctx, acts);
    return row;
  }

  function renderLinks(scan) {
    const panel = links.panel || document.createElement('div');
    panel.id = 'rlx-links';
    panel.replaceChildren();

    const head = document.createElement('div');
    head.className = 'rlx-l-head';
    const name = document.createElement('strong');
    name.textContent = 'Links';
    const sum = document.createElement('span');
    const shut = document.createElement('button');
    shut.className = 'rlx-l-close';
    shut.textContent = '×';
    shut.title = 'Close (Esc)';
    shut.addEventListener('click', closeLinks);
    const again = document.createElement('button');
    again.className = 'rlx-l-again';
    again.textContent = '↻';
    again.title = 'Look again';
    again.addEventListener('click', () => { links.said = null; openLinks(); });
    head.append(name, sum, again, shut);
    panel.appendChild(head);

    if (links.said) {
      const said = document.createElement('div');
      said.className = 'rlx-l-said';
      said.textContent = links.said;
      panel.appendChild(said);
    }

    let usual = [], rare = [];
    if (scan.trouble) {
      sum.textContent = '';
      const why = document.createElement('div');
      why.className = 'rlx-l-empty';
      why.textContent = scan.trouble;
      panel.appendChild(why);
    } else {
      usual = scan.found.filter((c) => !rarelyLinked(c.entry));
      rare = scan.found.filter((c) => rarelyLinked(c.entry));
      sum.textContent = usual.length || rare.length
        ? `${usual.length} to add` + (rare.length ? ` · ${rare.length} rarely linked` : '')
        : 'nothing to add';

      const list = document.createElement('div');
      list.className = 'rlx-l-list';
      for (const c of usual) list.appendChild(linkRow(c));
      if (rare.length) {
        const fold = document.createElement('details');
        fold.className = 'rlx-l-rare';
        const label = document.createElement('summary');
        label.textContent = `Rarely linked elsewhere (${rare.length})`;
        label.title = 'Fewer than one in seven of the articles that mention these link to them';
        fold.appendChild(label);
        for (const c of rare) fold.appendChild(linkRow(c));
        list.appendChild(fold);
      }
      if (!scan.found.length) {
        const none = document.createElement('div');
        none.className = 'rlx-l-empty';
        none.textContent = 'Every article this text names, of the ' +
          `${scan.index.size} in ${LINKS.file}, is linked already or set aside.`;
        list.appendChild(none);
      }
      panel.appendChild(list);

      const foot = document.createElement('div');
      foot.className = 'rlx-l-foot';
      const skipped = (readMap(LINKS_SKIP_KEY)[currentSlug()] || []).length
        + Object.keys(readMap(LINKS_NEVER_KEY)).length;
      foot.textContent = `${scan.linked.size} already linked · ${scan.index.size} articles known`;
      if (skipped) {
        const forget = document.createElement('button');
        forget.textContent = `offer the ${skipped} set aside again`;
        forget.addEventListener('click', () => linkAct('forget'));
        foot.append(' · ', forget);
      }
      panel.appendChild(foot);
    }

    if (!links.panel) {
      document.body.appendChild(panel);
      links.panel = panel;
      document.addEventListener('keydown', onLinksKey, true);
      addEventListener('resize', placeLinks);
    }
    paintLinksToggle(scan.trouble ? null : usual.length);
    placeLinks();
  }

  /* Down the right-hand side, clear of the two things of ours that may
   * already be there: the box by the title, when it has had to go to the
   * corner, and the bar, when it runs along the top or the bottom. */
  function placeLinks() {
    const p = links.panel;
    if (!p) return;
    const span = p.getBoundingClientRect();
    let top = 18, bottom = innerHeight - 18;
    for (const el of [group, stage.bar]) {
      if (!el?.isConnected) continue;
      const b = el.getBoundingClientRect();
      if (!b.width || b.right < span.left || b.left > span.right) continue;
      if (b.top < innerHeight / 2) top = Math.max(top, b.bottom + 8);
      else bottom = Math.min(bottom, b.top - 8);
    }
    p.style.top = `${top}px`;
    p.style.maxHeight = `${Math.max(160, bottom - top)}px`;
  }

  /* The panel: down the right-hand side, out of the way of the bar on the
   * left, the same face as the citation note. Its own stylesheet, so that
   * everything about the links is in this one stretch of the file. */
  GM_addStyle(`
    /* The button in the editor's toolbar: TinyMCE's own classes give it the
       size and the hover, this gives it room for the number beside the icon. */
    .tox .tox-tbtn.rlx-tox-links { width:auto; min-width:34px; padding:0 4px; }
    .tox .tox-tbtn.rlx-tox-links .rlx-tox-count { font:600 11px/1 system-ui,-apple-system,sans-serif;
      margin-left:1px; }
    .tox .tox-tbtn.rlx-tox-links .rlx-tox-count:empty { display:none; }
    #rlx-links {
      position:fixed; z-index:99998; top:18px; right:18px; width:min(26em, 92vw);
      max-height:calc(100vh - 36px); display:flex; flex-direction:column;
      border-radius:2px; border:1px solid var(--rlx-edge); border-left:4px solid #41699b;
      background:var(--rlx-face); color:var(--rlx-text); box-shadow:var(--rlx-float);
      font:var(--rlx-size)/var(--rlx-line) var(--rlx-type);
    }
    #rlx-links button { font:inherit; cursor:pointer; }
    #rlx-links .rlx-l-head { display:flex; align-items:baseline; gap:.5em;
      padding:.55em .5em .45em .8em; border-bottom:1px solid rgba(0,0,0,.08); }
    #rlx-links .rlx-l-head strong { color:var(--rlx-head); }
    #rlx-links .rlx-l-head span { flex:1 1 auto; font-size:12px; opacity:.75; }
    #rlx-links .rlx-l-close, #rlx-links .rlx-l-again { border:none; background:transparent;
      color:#666; font-size:16px; line-height:1; padding:0 .3em; }
    #rlx-links .rlx-l-close:hover, #rlx-links .rlx-l-again:hover { color:#111; }
    #rlx-links .rlx-l-said { padding:.4em .8em; background:rgba(5,150,105,.10); color:#047857;
      font-size:12px; }
    #rlx-links .rlx-l-list { overflow:auto; padding:.2em 0; }
    #rlx-links .rlx-l-row { padding:.5em .8em; border-bottom:1px solid rgba(0,0,0,.06); }
    #rlx-links .rlx-l-what { display:flex; flex-wrap:wrap; align-items:baseline; gap:.35em; }
    #rlx-links .rlx-l-words { border:none; background:transparent; padding:0;
      color:var(--rlx-text); font-weight:600; text-align:left; }
    #rlx-links .rlx-l-words:hover { text-decoration:underline; }
    #rlx-links .rlx-l-arrow { opacity:.5; }
    #rlx-links .rlx-l-what a { color:#41699b; }
    #rlx-links .rlx-l-rate { margin-left:auto; font-size:11px; opacity:.55;
      font-variant-numeric:tabular-nums; }
    #rlx-links .rlx-l-ctx { margin-top:.2em; font-size:12px; line-height:17px; opacity:.8; }
    #rlx-links .rlx-l-ctx mark { background:rgba(65,105,155,.16); color:inherit; padding:0 1px; }
    #rlx-links .rlx-l-acts { display:flex; flex-wrap:wrap; gap:4px; margin-top:.35em; }
    #rlx-links .rlx-l-acts button { padding:2px 8px; border-radius:1px; font-size:12px;
      border:1px solid rgba(0,0,0,.15); background:#fff; color:#444; }
    #rlx-links .rlx-l-acts button:hover { background:#f2f2f2; color:#111; }
    #rlx-links .rlx-l-acts .rlx-l-go { background:var(--rlx-btn); color:#fff; border-color:transparent; }
    #rlx-links .rlx-l-acts .rlx-l-go:hover { background:var(--rlx-btn-lit); color:#fff; }
    #rlx-links .rlx-l-rare > summary { padding:.5em .8em; cursor:pointer; font-size:12px;
      opacity:.75; }
    #rlx-links .rlx-l-rare .rlx-l-row { opacity:.8; }
    #rlx-links .rlx-l-empty { padding:.8em; opacity:.75; }
    #rlx-links .rlx-l-foot { padding:.4em .8em; border-top:1px solid rgba(0,0,0,.08);
      font-size:11px; opacity:.65; }
    #rlx-links .rlx-l-foot button { border:none; background:transparent; padding:0;
      color:#41699b; text-decoration:underline; font-size:11px; }
  `);


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
    // `force` is the ↻, and it forgets two copies with one word: this tab's,
    // by not reading it, and the linter's, by asking it not to answer from it.
    // Forgetting only the first would fetch the same words back over the wire.
    const data = await askLinter(slug, { refresh: !!force });
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

  /* The walk goes through the errors first, then the warnings, then the
   * suggestions, and only then whatever else the linter sent. Within one
   * severity the order is the article's own, top to bottom: the sort is
   * stable and `fromApi` hands them over by line. */
  const WEIGHT = { error: 0, warning: 1, suggestion: 2 };
  const weight = (f) => WEIGHT[f.severity] ?? 3;
  const byWeight = (findings) => [...findings].sort((a, b) => weight(a) - weight(b));

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
      const findings = byWeight(actionable(all))
        .map((f) => ({ ...f, state: 'open', range: null, frame: null, clips: null }));
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
  mountToolbarLinks();
  // Radiopaedia remounts parts of the page on its own: the button has to be
  // put back whenever it disappears. And in the editor the margin it stands in
  // only exists once the editor has mounted, which is after this runs.
  new MutationObserver(() => { mountButton(); mountToolbarLinks(); placeGroupSoon(); })
    .observe(document.body, { childList: true, subtree: true });
  addEventListener('resize', placeGroupSoon);

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

  // Nor does the paste marker wait for it: you came here to add a section, and
  // whether the prose also needs work is a different question.
  pasteMarkSoon();

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
