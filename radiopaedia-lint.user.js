// ==UserScript==
// @name         Radiopaedia Lint
// @namespace    https://radiopaedia.work/
// @homepageURL  https://github.com/gmadevs/radiopaedia-lint-userscript
// @supportURL   https://github.com/gmadevs/radiopaedia-lint-userscript/issues
// @downloadURL  https://raw.githubusercontent.com/gmadevs/radiopaedia-lint-userscript/main/radiopaedia-lint.user.js
// @updateURL    https://raw.githubusercontent.com/gmadevs/radiopaedia-lint-userscript/main/radiopaedia-lint.user.js
// @license      MIT
// @version      1.8.2
// @description  A Lint button next to the article title, coloured by what the radiopaedia.work lint API says about the article: red for errors, amber for warnings, blue for suggestions, grey for nothing to fix. Click it and the findings are highlighted on the text in the editor, one at a time.
// @match        https://radiopaedia.org/*
// @connect      radiopaedia.work
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
  const LINTER_TIMEOUT = 60_000;    // the linter still reads the article from Radiopaedia, but a second or two does it
  const EDITOR_TIMEOUT = 30_000;    // how long we wait for the WYSIWYG to initialise
  const PENDING_KEY = 'rlx-lint-pending';
  const CACHE_KEY = 'rlx-lint-cache:';

  // What a Cloudflare interstitial carries instead of the results.
  const CHALLENGE = ['start_challenge', 'bot_management', 'Verifying you are human'];

  const COLORS = {
    error:      { ink: '#dc2626', wash: 'rgba(220, 38, 38, .22)' },
    warning:    { ink: '#d97706', wash: 'rgba(217, 119, 6, .22)' },
    suggestion: { ink: '#2563eb', wash: 'rgba(37, 99, 235, .20)' },
    other:      { ink: '#6b7280', wash: 'rgba(107, 114, 128, .20)' },
  };
  const paint = (severity) => COLORS[severity] || COLORS.other;
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

  /* The shape things get compared in: no spaces, no case, curly quotes and
   * dashes folded onto their straight forms. Ignoring spacing is what makes
   * the comparison survive both the phantom spaces the linter drags along from
   * `<sup>` markers and quotes, and the missing ones between one tag and the
   * next in the editor.
   *
   * Invisible characters need their own pass: `\s` in JS does **not** cover
   * the zero-width space, and articles are full of them — the linter quotes
   * the "Radiographic features" heading with a U+200B stuck to the front. One
   * of those, invisible to the eye, and the snippet would never be found. */
  function flat(s) {
    return s
      .replace(/[‘’ʼ]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[–—−]/g, '-')
      .replace(/[\u200b-\u200d\u2060\ufeff\u00ad]/g, '')
      .replace(/\s+/g, '')
      .toLowerCase();
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

      out.push({ check, severity, line: where, message, snippet,
                 target: flat(plain(lint.matched)), targetNth: nthInLine(lint),
                 point: insertion(lint),
                 occurrence: copy.n, fp: `${check}|${message}|${snippet}|${where}` });
    }
    return out;
  }

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
    .rlx-btn {
      display:inline-flex; align-items:center; gap:.4em; vertical-align:middle;
      padding:.25em .7em; border:1px solid currentColor;
      border-radius:999px; background:transparent; color:var(--rlx-ink, #2563eb);
      font:600 13px/1.4 system-ui,-apple-system,sans-serif; cursor:pointer;
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
      padding:.18em .5em; border:1px solid currentColor; border-radius:999px;
      background:transparent; color:#9ca3af; cursor:pointer;
      font:600 11px/1.35 system-ui,-apple-system,sans-serif; letter-spacing:.04em;
      white-space:nowrap; flex:0 0 auto; align-self:center;
    }
    .rlx-auto:hover { color:#6b7280; }
    .rlx-auto.rlx-on { background:var(--rlx-ink, #2563eb); border-color:transparent; color:#fff; }
    .rlx-auto.rlx-on:hover { color:#fff; opacity:.85; }

    .rlx-btn-float { position:fixed; top:14px; right:14px; z-index:99999; margin:0;
      padding:4px 6px; border-radius:999px;
      background:#fff; box-shadow:0 2px 10px rgba(0,0,0,.18); }

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

    #rlx-bar {
      position:fixed; left:50%; bottom:18px; transform:translateX(-50%); z-index:99999;
      display:flex; align-items:center; gap:.5em; flex-wrap:wrap; justify-content:center;
      max-width:min(62em, 94vw); padding:.55em .7em; border-radius:12px;
      background:#111827; color:#f9fafb; box-shadow:0 8px 30px rgba(0,0,0,.35);
      font:13px/1.4 system-ui,-apple-system,sans-serif;
    }
    #rlx-bar button { padding:.35em .7em; border:0; border-radius:7px;
      background:#374151; color:#f9fafb; font:inherit; font-weight:600; cursor:pointer; }
    #rlx-bar button:hover:not([disabled]) { background:#4b5563; }
    #rlx-bar button[disabled] { opacity:.4; cursor:default; }
    #rlx-bar .rlx-count { font-variant-numeric:tabular-nums; opacity:.85; }
    #rlx-bar .rlx-title { font-weight:700; }
    #rlx-bar .rlx-status { max-width:26em; overflow:hidden; text-overflow:ellipsis;
      white-space:nowrap; opacity:.9; }
    #rlx-bar .rlx-sep { width:1px; align-self:stretch; background:#4b5563; }
    #rlx-bar .rlx-close { background:transparent; font-size:16px; line-height:1; }

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

    @media (prefers-color-scheme: dark) {
      #rlx-note { background:#1f2937; color:#f3f4f6; }
      #rlx-note .rlx-snippet { border-left-color:#4b5563; color:#d1d5db; }
    }
  `);

  const stage = {
    slug: null,
    findings: [],
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
      <span class="rlx-sep"></span>
      <button data-act="prev" title="Previous (k)">&lsaquo;</button>
      <button data-act="next" title="Next (j)">&rsaquo;</button>
      <button data-act="done" title="Done (s)">&#10003; Done</button>
      <button data-act="ignore" title="Ignore (x)">Ignore</button>
      <button data-act="undo" title="Undo the last one (u)">Undo</button>
      <span class="rlx-sep"></span>
      <button data-act="copy" title="Copy the message (c)">Copy</button>
      <button data-act="reload" title="Ask the linter again">Re-lint</button>
      <button data-act="close" class="rlx-close" title="Close (Esc)">&times;</button>
      <span class="rlx-status"></span>`;
    document.body.appendChild(stage.bar);
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
    stage.findings = []; stage.i = -1; stage.history = [];
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

  function draw() {
    if (!stage.live) return;
    stage.layer.textContent = '';
    for (let k = 0; k < stage.findings.length; k++) {
      const f = stage.findings[k];
      if (!f.range || f.state !== 'open') continue;
      const c = paint(f.severity);
      const box = f.frame ? f.frame.getBoundingClientRect() : null;
      let rects;
      try { rects = f.range.getClientRects(); } catch { continue; }

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

      for (const s of mergeLines(spans)) {
        const mark = document.createElement('div');
        mark.className = 'rlx-mark' + (k === stage.i ? ' rlx-current' : '');
        mark.style.cssText = `left:${s.x}px; top:${s.y}px; width:${s.w}px; height:${s.h}px;` +
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
  function notePlacement(spot, w, h) {
    const gap = 10, edge = 12, barRoom = 76;   // the bar lives at the bottom
    const clamp = (p) => ({
      left: Math.min(Math.max(p.left, edge), Math.max(edge, innerWidth - w - edge)),
      top: Math.min(Math.max(p.top, edge), Math.max(edge, innerHeight - h - barRoom)),
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

    stage.bar.querySelector('.rlx-count').textContent =
      `${position ? position : '–'}/${open.length} · ${counts.error} error · ${counts.warning} warning ` +
      `· ${counts.suggestion + counts.other} other`;

    let status = '';
    if (!stage.findings.length) status = 'No findings: the article is clean.';
    else if (!open.length) status = 'All reviewed.';
    // A settled finding has no snippet in the text by definition — saying it
    // "cannot be found" about the one you have just fixed reads as a fault.
    else if (f && f.state !== 'open') status = 'Alt + → for the next one';
    else if (f && !f.range) status = 'snippet not found in the editor text';
    stage.bar.querySelector('.rlx-status').textContent = status;

    const disable = (name, v) => {
      const b = stage.bar.querySelector(`[data-act="${name}"]`);
      if (b) b.disabled = v;
    };
    disable('prev', open.length < 2); disable('next', open.length < 2);
    disable('done', !f); disable('ignore', !f); disable('copy', !f);
    disable('undo', !stage.history.length);
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
                c: 'copy', Escape: 'close' }[e.key];
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

  let group = null, button = null, toggle = null;

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
  async function preview(slug) {
    verdict = 'asking';
    paintButton();
    try {
      const findings = fromApi(await lintResult(slug));
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

    // The switch. A word rather than a symbol: this one decides whether every
    // article you open becomes a request, and that deserves to be readable.
    const t = document.createElement('button');
    t.className = 'rlx-auto';
    t.type = 'button';
    t.textContent = 'auto';
    t.addEventListener('click', () => setAuto(!auto()));

    g.append(b, t);

    const title = inEditor() ? null : visibleTitle();
    if (title) title.appendChild(g);
    else pinToCorner(g);

    // Attached does not mean visible. If the chosen title sits in a hidden
    // branch — and a page seen by a signed-in user has more than one `h1`,
    // menus and modals included — the button exists, `querySelector` finds it,
    // and there is nothing on screen. Better to notice here than later.
    const r = b.getBoundingClientRect();
    if (!r.width || !r.height) pinToCorner(g);

    group = g; button = b; toggle = t;
    paintButton();
    paintToggle();
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

  /* Zero findings is now simply zero findings. Reading the linter's HTML page,
   * an empty result and a parser that had stopped working looked exactly the
   * same, and the doubt had to be written into the code; `askLinter` refuses
   * anything that is not a lint result, so an empty `lints[]` that gets this
   * far is an article with nothing wrong with it. */
  const ALL_CLEAR = 'Nothing to lint.';
  const allClearSub = (slug) => `The linter found no issues in "${slug}".`;

  /* Outside the editor the linter is asked *before* navigating. An article
   * with nothing wrong with it used to cost you the trip to the edit page and
   * the trip back; now it costs a sentence. The answer is kept either way, so
   * this is not an extra request — it is the same one, made earlier. */
  async function preflight(slug) {
    if (!slug) return;
    hideBanner();
    setButtonState('Lint…', true);
    try {
      const data = await lintResult(slug);
      if (!fromApi(data).length) {
        showBanner(ALL_CLEAR, allClearSub(slug));
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
      const data = await lintResult(slug, { force });
      const findings = fromApi(data).map((f) => ({ ...f, state: 'open', range: null, frame: null }));

      // Also the answer to "Re-lint" on an article you have just finished
      // fixing: no stage, one sentence.
      if (!findings.length) {
        destroyStage();
        showBanner(ALL_CLEAR, allClearSub(slug));
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
