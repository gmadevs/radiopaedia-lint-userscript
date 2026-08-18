// ==UserScript==
// @name         Radiopaedia Lint
// @namespace    https://radiopaedia.work/
// @homepageURL  https://github.com/gmadevs/radiopaedia-lint-userscript
// @supportURL   https://github.com/gmadevs/radiopaedia-lint-userscript/issues
// @downloadURL  https://raw.githubusercontent.com/gmadevs/radiopaedia-lint-userscript/main/radiopaedia-lint.user.js
// @updateURL    https://raw.githubusercontent.com/gmadevs/radiopaedia-lint-userscript/main/radiopaedia-lint.user.js
// @license      MIT
// @version      1.3.1
// @description  A Lint button next to the article title: takes you to the editor, brings back the radiopaedia.work linter findings highlighted on the text, and walks you through them one at a time.
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
 * The radiopaedia.work linter renders a finished HTML page
 * (`/lint/linter?slug=…`): there is no API, so the findings have to be read
 * off the markup. That is what `extract()` below does — outer
 * `div[data-flux-card]` cards, `[data-flux-heading]` for the check,
 * `[data-flux-badge]` for the severity, one `div.pb-6` per finding holding the
 * quoted snippet in a `<p>` and `Line 49:21 · message` in a `div.ml-4`. If the
 * linter ever changes stylesheet, THIS function is what stops finding
 * anything: Tailwind classes are not an API.
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

  const LINTER_URL = 'https://radiopaedia.work/lint/linter?slug=';
  const LINTER_TIMEOUT = 180_000;   // the linter has to read the article from Radiopaedia: it is slow
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

  // ————————————————————————————————————————————————————————————— text

  /* An element's text with the spacing put back in order.
   * Parsers that join nodes with a separator have to stitch the result back up
   * afterwards, or every `<sup>` marker and quote drags a phantom space along.
   * `textContent` already returns the text as you read it, so collapsing
   * whitespace is enough here — and the comparison that matters (`flat`)
   * ignores spacing altogether. */
  function text(el) {
    if (!el) return '';
    return el.textContent.replace(/\s+/g, ' ').trim();
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

  /* The linter quotes the snippet inside quotation marks: strip them, or it
   * would never match the text. */
  function unquote(snippet) {
    return snippet.replace(/^["'“‘]+/, '').replace(/["'”’]+$/, '').trim();
  }

  /* The piece to highlight *inside* the snippet, when the message names it.
   *
   * The snippet is often a whole paragraph while the finding is about three
   * words: "'SUDEP' has no definition" quotes forty lines and talks about a
   * single acronym. The message does carry the right words, in quotes —
   * sometimes with the markup still in, as `'<strong>Drug resistant
   * epilepsy</strong>'`.
   *
   * Word apostrophes have to go first, though: in "don't use bold in text:
   * '<strong>…</strong>'" the one in *don't* pairs up with the quote that
   * opens the real citation, and every pair after it is off by one — you end
   * up extracting "t use bold in text: " and losing the citation entirely.
   * Masking them is the only way to read quotes as delimiters.
   *
   * Even then the first candidate is not trusted: all of them are collected
   * and only those that actually occur in the snippet are kept; among those
   * the longest wins, being the hardest to hit by accident. If none survives —
   * "Consider replacing a bracketed e.g.", which quotes nothing — the whole
   * snippet is highlighted, which is the right answer there. */
  function target(message, snippet) {
    const within = flat(unquote(snippet));
    if (!within) return null;
    const MARKER = '\u0001';   // outside the alphabet of any message
    // Letter before captured, letter after only looked at: a lookbehind would
    // be shorter, but browsers that cannot compile one do not fail this line —
    // they fail the whole file, and the button with it.
    const clean = message.replace(/(\p{L})['’ʼ](?=\p{L})/gu, '$1' + MARKER);
    let best = null;
    for (const m of clean.matchAll(/'([^']{2,200})'|"([^"]{2,200})"|«([^»]{2,200})»/g)) {
      const raw = (m[1] ?? m[2] ?? m[3])
        .replace(/<[^>]+>/g, '')
        .replaceAll(MARKER, "'");
      const needle = flat(raw);
      if (needle.length < 2 || !within.includes(needle)) continue;
      if (!best || needle.length > best.length) best = needle;
    }
    return best;
  }

  // ————————————————————————————————————————————— the findings parser

  const LINE_RE = /^\s*Line\s+(\S+)\s*$/i;

  /* (line, message) out of a `div.pb-6`. The line is `49:21`, without `Line`. */
  function findingFromBlock(block) {
    let line = null, message = '';
    for (const meta of block.querySelectorAll('div.ml-4')) {
      let parts = [...meta.querySelectorAll('span')].map(text).filter((p) => p && p !== '·');
      if (!parts.length) continue;
      const m = LINE_RE.exec(parts[0]);
      if (m) { line = m[1]; parts = parts.slice(1); }
      message = parts.join(' ').trim();
      break;
    }
    return { line, message };
  }

  /* The findings of one run, in the order the linter presents them.
   * The fingerprint counts repeats: that is what tells two identical findings
   * on the same article apart, and it doubles as the occurrence to
   * highlight. */
  function extract(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const seen = new Map();
    const out = [];
    const bump = (k) => { const n = (seen.get(k) || 0) + 1; seen.set(k, n); return n; };

    const cards = [...doc.querySelectorAll('div[data-flux-card]')]
      // The cards of individual findings are `data-flux-card` too and sit
      // inside their check's card: only the outer ones are looked at.
      .filter((c) => !c.parentElement?.closest('div[data-flux-card]'));

    for (const card of cards) {
      const heading = card.querySelector(':scope > div > [data-flux-heading]');
      const badge = card.querySelector(':scope > div > [data-flux-badge]');
      if (!heading || !badge) continue;   // the search card, and the Links one
      const check = text(heading);
      const severity = text(badge).toLowerCase();

      const blocks = [...card.querySelectorAll('div.pb-6')];
      if (!blocks.length) {
        // A check that speaks without quoting a specific place. None have
        // turned up yet, but recording it roughly beats losing it silently.
        let body = text(card);
        if (body.startsWith(check)) body = body.slice(check.length).trimStart();
        if (body.toLowerCase().startsWith(severity)) body = body.slice(severity.length).trimStart();
        if (body) {
          const n = bump(check + ' ' + body + ' ');
          out.push({ check, severity, line: null, message: body, snippet: '',
                     occurrence: n, fp: `${check}|${body}||${n}` });
        }
        continue;
      }

      for (const block of blocks) {
        const snippet = text(block.querySelector('p'));
        const { line, message } = findingFromBlock(block);
        if (!message) continue;
        const n = bump(check + ' ' + message + ' ' + snippet);
        out.push({ check, severity, line, message, snippet,
                   occurrence: n, fp: `${check}|${message}|${snippet}|${n}` });
      }
    }
    return out;
  }

  // ——————————————————————————————————————————————————— network

  function askLinter(slug) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: LINTER_URL + encodeURIComponent(slug),
        timeout: LINTER_TIMEOUT,
        onload: (r) => {
          const html = r.responseText || '';
          if (html.includes('article with the slug')) {
            return reject(new Error(`The linter cannot find the article "${slug}" on Radiopaedia.`));
          }
          if (CHALLENGE.some((m) => html.includes(m))) {
            return reject(new Error(
              'Cloudflare bot check. Open radiopaedia.work in a tab, clear the check, ' +
              'then try again.'));
          }
          if (r.status >= 400) return reject(new Error(`The linter answered ${r.status}.`));
          resolve(html);
        },
        onerror: () => reject(new Error('Request to the linter failed (network, or @connect).')),
        ontimeout: () => reject(new Error('The linter did not answer within three minutes.')),
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

  /* The index of a root: the flattened string of all its text, plus the node
   * and offset each character came from. A Range over any substring can be
   * rebuilt from that, even one crossing several tags. */
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
    const nodes = [], offsets = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const raw = n.nodeValue || '';
      for (let i = 0; i < raw.length; i++) {
        const c = flat(raw[i]);
        if (!c) continue;              // whitespace: out of the index by construction
        s += c;
        nodes.push(n);
        offsets.push(i);
      }
    }
    return { root, s, nodes, offsets };
  }

  /* Where the nth occurrence of the needle falls: {from, to} in flat indices. */
  function locate(index, needle, occurrence) {
    if (!needle) return null;
    let from = -1;
    for (let k = 0; k < occurrence; k++) {
      from = index.s.indexOf(needle, from + 1);
      if (from < 0) return null;
    }
    const to = from + needle.length - 1;
    return to < index.nodes.length ? { from, to } : null;
  }

  function rangeFrom(index, { from, to }) {
    const r = index.root.ownerDocument.createRange();
    r.setStart(index.nodes[from], index.offsets[from]);
    r.setEnd(index.nodes[to], index.offsets[to] + 1);
    return r;
  }

  /* Anchor every finding still open. Each root is indexed once, and repeated
   * occurrences of the same snippet are handed out in order: two findings on
   * the same snippet land on two different places.
   *
   * Two passes: the snippet says *where*, the target says *what*. Once the
   * snippet is found, if the message names a precise piece it is searched for
   * inside it and the highlight tightens onto that — one lit acronym is worth
   * more than a whole paragraph washed in colour. If that piece is not in
   * there, the snippet stays lit: too wide beats nothing. */
  function anchor(findings, roots) {
    const indices = roots.map((r) => buildIndex(r.root));
    const used = new Map();
    for (const f of findings) {
      f.range = null; f.frame = null; f.narrowed = false;
      if (f.state === 'ignored' || f.state === 'done') continue;
      const needle = flat(unquote(f.snippet));
      if (!needle) continue;
      for (let i = 0; i < indices.length; i++) {
        const key = i + ' ' + needle;
        const already = used.get(key) || 0;
        const wide = locate(indices[i], needle, already + 1);
        if (!wide) continue;
        used.set(key, already + 1);

        let spot = wide;
        const short = target(f.message, f.snippet);
        if (short) {
          const rel = indices[i].s.slice(wide.from, wide.to + 1).indexOf(short);
          if (rel >= 0) {
            spot = { from: wide.from + rel, to: wide.from + rel + short.length - 1 };
            f.narrowed = true;
          }
        }
        f.range = rangeFrom(indices[i], spot);
        f.frame = roots[i].frame;
        break;
      }
    }
  }

  // ———————————————————————————————————————————————————————————— the stage

  GM_addStyle(`
    .rlx-btn {
      display:inline-flex; align-items:center; gap:.4em; vertical-align:middle;
      margin-left:.6em; padding:.25em .7em; border:1px solid currentColor;
      border-radius:999px; background:transparent; color:#2563eb;
      font:600 13px/1.4 system-ui,-apple-system,sans-serif; cursor:pointer;
      /* The title is a flex container, and it deforms the button twice over.
         A long title squeezes it until "Lint" wraps to "Lin/t", because
         flex-shrink defaults to 1 and the button gets treated as spare room;
         and align-self defaults to stretch, so on a title running to two lines
         the button is pulled into a tall oval. Pinned here: never wrap, never
         give up width, keep your own height. */
      white-space:nowrap; flex:0 0 auto; align-self:center;
    }
    .rlx-btn:hover { background:#2563eb; color:#fff; }
    .rlx-btn[disabled] { opacity:.55; cursor:progress; }
    .rlx-btn-float { position:fixed; top:14px; right:14px; z-index:99999;
      background:#fff; box-shadow:0 2px 10px rgba(0,0,0,.18); margin:0; }

    #rlx-layer { position:fixed; inset:0; pointer-events:none; z-index:99997; }
    .rlx-mark { position:fixed; border-radius:2px; }
    .rlx-mark.rlx-current { outline:2px solid; outline-offset:1px; }

    #rlx-note {
      position:fixed; z-index:99999; max-width:min(30em, 78vw);
      padding:.6em .8em; border-radius:8px; border-left:4px solid;
      background:#fff; color:#111; box-shadow:0 6px 24px rgba(0,0,0,.22);
      font:14px/1.45 system-ui,-apple-system,sans-serif;
    }
    /* Last resort when the highlight is too tall to sit beside: hover the note
       and it gets out of the way. Pointer events stay on, so the message can
       still be selected and copied. */
    #rlx-note { transition: opacity .12s ease; }
    #rlx-note:hover { opacity:.12; }
    #rlx-note .rlx-head { display:flex; gap:.5em; align-items:baseline;
      font-size:12px; text-transform:uppercase; letter-spacing:.04em; opacity:.8; }
    #rlx-note .rlx-msg { margin-top:.35em; }
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
    stage.findings = []; stage.i = -1; stage.history = [];
  }

  // —————————————————————————————————————————————————————— drawing

  let drawPending = null;
  function scheduleDraw() {
    if (drawPending) return;
    drawPending = requestAnimationFrame(() => { drawPending = null; draw(); });
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
        const mark = document.createElement('div');
        mark.className = 'rlx-mark' + (k === stage.i ? ' rlx-current' : '');
        mark.style.cssText = `left:${x}px; top:${y}px; width:${w}px; height:${h}px;` +
                             `background:${c.wash}; outline-color:${c.ink};`;
        stage.layer.appendChild(mark);
      }
    }
    placeNote();
  }

  function placeNote() {
    const f = stage.findings[stage.i];
    if (!f || !stage.live) { if (stage.note) stage.note.hidden = true; return; }
    const c = paint(f.severity);
    stage.note.hidden = false;
    stage.note.style.borderLeftColor = c.ink;
    stage.note.innerHTML = '';

    const head = document.createElement('div');
    head.className = 'rlx-head';
    const sev = document.createElement('span');
    sev.style.cssText = `color:${c.ink}; font-weight:700`;
    sev.textContent = f.severity || 'finding';
    const where = document.createElement('span');
    where.textContent = f.check + (f.line ? ` · line ${f.line}` : '');
    head.append(sev, where);

    const msg = document.createElement('div');
    msg.className = 'rlx-msg';
    msg.textContent = f.message;
    stage.note.append(head, msg);

    // The snippet only when it is NOT on screen. When the finding is anchored
    // you are already looking at the highlighted words, and repeating them
    // here just makes the note tall enough to cover them.
    if (f.snippet && !f.range) {
      const s = document.createElement('div');
      s.className = 'rlx-snippet';
      s.textContent = unquote(f.snippet);
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
    if (!f.range) return null;
    try {
      const r = f.range.getBoundingClientRect();
      if (!r || (!r.width && !r.height)) return null;
      const off = f.frame ? f.frame.getBoundingClientRect() : { left: 0, top: 0 };
      return { left: r.left + off.left, top: r.top + off.top,
               right: r.right + off.left, bottom: r.bottom + off.top };
    } catch { return null; }   // stale range
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
      `${position || 0}/${open.length} · ${counts.error} error · ${counts.warning} warning ` +
      `· ${counts.suggestion + counts.other} other`;

    let status = '';
    if (!stage.findings.length) status = 'No findings: the article is clean.';
    else if (!open.length) status = 'All reviewed.';
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
   * snippet you fixed: the finding closes itself (and "undo" reopens it). */
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
      if (stage.findings[stage.i]?.state !== 'open') step(1);
      else { draw(); updateBar(); }
    }, 700);
  }

  // ————————————————————————————————————————————————————————— the button

  function currentSlug() {
    const m = /^\/articles\/([^/?#]+)/.exec(location.pathname);
    return m ? decodeURIComponent(m[1]) : null;
  }
  const inEditor = () => /\/edit\/?$/.test(location.pathname);

  let button = null;

  function mountButton() {
    // `isConnected` rather than a query: the observer also fires for the marks
    // we redraw ourselves on every scroll frame, and searching the document
    // each time would be wasted work.
    if (button?.isConnected) return;
    const slug = currentSlug();
    if (!slug) return;

    const b = document.createElement('button');
    b.className = 'rlx-btn';
    b.type = 'button';
    b.textContent = 'Lint';
    b.title = 'Run the linter on this article and show the findings on the text';
    b.addEventListener('click', () => {
      if (inEditor()) return runLint(slug, {});
      // Outside the editor: go to the editor first, and let the lint start
      // there — this way navigation cannot abort the request halfway.
      sessionStorage.setItem(PENDING_KEY, slug);
      location.href = `https://radiopaedia.org/articles/${encodeURIComponent(slug)}/edit`;
    });

    const title = inEditor() ? null : visibleTitle();
    if (title) title.appendChild(b);
    else pinToCorner(b);

    // Attached does not mean visible. If the chosen title sits in a hidden
    // branch — and a page seen by a signed-in user has more than one `h1`,
    // menus and modals included — the button exists, `querySelector` finds it,
    // and there is nothing on screen. Better to notice here than later.
    const r = b.getBoundingClientRect();
    if (!r.width || !r.height) pinToCorner(b);

    button = b;
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

  /* The linter's HTML runs to a few hundred kB and `sessionStorage` holds
   * little: only the last article is kept. This is here so that reloading the
   * edit page does not ask the linter a second time, not to build an
   * archive. */
  function remember(slug, html) {
    for (const k of Object.keys(sessionStorage)) {
      if (k.startsWith(CACHE_KEY) && k !== CACHE_KEY + slug) sessionStorage.removeItem(k);
    }
    try { sessionStorage.setItem(CACHE_KEY + slug, html); } catch { /* quota: never mind */ }
  }

  async function runLint(slug, { force } = {}) {
    if (!slug) return;
    stage.slug = slug;
    setButtonState('Lint…', true);
    try {
      let html = force ? null : sessionStorage.getItem(CACHE_KEY + slug);
      if (!html) {
        html = await askLinter(slug);
        remember(slug, html);
      }
      const findings = extract(html).map((f) => ({ ...f, state: 'open', range: null, frame: null }));

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
               '· button:', button
                 ? (button.classList.contains('rlx-btn-float')
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
})();
