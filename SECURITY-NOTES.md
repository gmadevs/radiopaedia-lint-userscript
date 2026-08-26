# What this script does to your browser

`radiopaedia-lint.user.js` runs on every page of radiopaedia.org, talks to two hosts and writes to
your clipboard. That is enough to be worth a straight answer about **what leaves the browser, what
is stored, and what is touched** — written for somebody deciding whether to run it, and for a
reviewer at Radiopaedia or at radiopaedia.work deciding whether to mind.

Everything below is checkable against the file itself: it is one script, unminified, with no build
step and no dependencies. Where something is named — `askLinter()`, `plain()`, `previewSoon()` —
it is a function you can search for. Line numbers are deliberately not used: they go stale, and a
stale line number in a document like this is worse than none.

Current as of **v3.0.0**.

## The short version

Nothing here is unsafe to hand to a reviewer. No secrets in the file or in the history. Four GET
requests, no POST anywhere, no analytics, no telemetry, no third-party code. The one thing that
genuinely costs Radiopaedia something is **how often it asks** — see *The automatic request* —
and that is the first thing to talk about rather than the last.

## Network

Four `GM_xmlhttpRequest` calls, all GET, to two hosts. No `fetch`, no `XMLHttpRequest`, no beacon,
no websocket, no remote image, font or stylesheet, no analytics. `@connect` names both hosts in
the header, which is also what confines the script to them.

**1. The linter** — `GET https://radiopaedia.work/api/v1/lint?article=<slug>`, one header,
`Accept: application/json` (`askLinter()`). The only thing that leaves the browser is the article
slug, which is already in the URL of the page you are standing on. Up to v1.4.2 this fetched the
linter's rendered HTML page; since v1.5.0 it is the JSON API — same host, same slug, about 14 kB
instead of 400.

**2. The two shared lists** — `GET raw.githubusercontent.com/…/main/proper-nouns.txt` and
`…/main/acronyms.txt` (`askList()`). Read-only, no headers of ours, no query string, nothing about
you in either request: both URLs are constants, built from a fixed prefix and a filename that is a
literal in the `LISTS` table. Each response is treated as text, capped at 256 kB, split on
newlines, and never parsed as anything else. A failure resolves to `null` and that list switches
itself off — nothing hidden, nothing offered. Once per tab session each, cached in
`sessionStorage`, asked again only on **Re-lint**.

**3. The citation tool** — `GET https://radiopaedia.work/cite?search=<the reference>`
(`askCite()`), same host as the linter. This one carries content out of the article you are
editing: one reference, its text and its `<a href>` links, and nothing else. It goes only when
somebody presses that reference's chip — no lookup on page load, none for the references nobody
pressed — and the answer is kept in `sessionStorage` for the tab.

What comes back is a rendered page, and four fields are read out of it: `citation`, `error`,
`match` and `index`, out of the JSON that Livewire leaves in a `wire:snapshot` attribute. It is
parsed with `DOMParser` into an inert document — nothing in there runs, loads or fetches — and
every value taken from it reaches the screen through `textContent` or as a property of a node this
script built. None of it is ever assigned to `innerHTML`, and none of it is written into the
editor. This is the one part of the script that reads somebody else's markup rather than an API,
which is what the lint side stopped doing in v1.5.0; it fails loudly rather than silently, and a
`GET /api/v1/cite?search=…` would end it.

**4. The canon** — `GET raw.githubusercontent.com/…/main/article-structure.json`, the same shape
as the lists: a constant URL, read-only, cached for the session.

**Nothing is ever written to a server.** Proposing a name or an acronym copies a word to the
clipboard and opens `https://github.com/…/edit/main/proper-nouns.txt` in a new tab with
`window.open(url, '_blank', 'noopener')`; the paste and the pull request are yours, in GitHub's
own interface, under your own account. No token, no credential, no POST.

## The automatic request

Up to v1.5.x the script asked the linter when you pressed the button. Since v1.6.0 the button
colours itself by what the article contains, which means asking as the article page opens: **one
request per article page opened, rather than one per click**. The linter reads the article from
Radiopaedia to answer, so each one is also a request to them.

What holds it down, all of it in `previewSoon()` and `preview()`:

- **Article pages only** — `/articles/<slug>` exactly. Revisions, cases and the editor ask
  nothing.
- **Only a tab being looked at** — `visibilityState` or `hasFocus`. A dozen links cmd-clicked into
  background tabs cost nothing until they are opened, and a page the browser preloaded on a guess
  costs nothing ever.
- **One answer per article per session** — the `sessionStorage` cache serves the reload, the click
  and the trip to the editor.
- **No retry, no prefetching**, and silence on failure: a button that could not ask looks exactly
  like one that was never asked.
- **The switch** turns the whole thing off from the page, permanently. `PREVIEW_ON_LOAD` is only
  the default for a browser that has never been told anything.
- The API is unauthenticated and answers `X-RateLimit-Limit: 60`. A person reading articles will
  not come near it.

If Radiopaedia would rather not have this at all, the honest answer is that manual mode is one
line — `PREVIEW_ON_LOAD = false` — and loses nothing but the colour.

## Injection

The lint answer is JSON and goes through `JSON.parse`; anything that is not a lint result is
rejected before it reaches the rest of the file. The fragments of article markup the API quotes
back — `matched`, `display`, `match` — are parsed with `DOMParser` into an inert document and
only `textContent` is read out of it (`plain()`).

There is no `eval`, no `new Function`, no `document.write`, no `insertAdjacentHTML`. Five places
build DOM with `innerHTML`: the bar, the banner, the rail's header, the rail's thread and a rail
chip. Four are static string literals with the text filled in afterwards through `textContent`.
The fifth, the rail header, interpolates section names — and those come from
`article-structure.json`, which is our own file from our own repository, with quotes stripped
before they reach the attribute. **No value from the linter, from the citation tool or from the
article is ever interpolated into markup.**

## Permissions

`@grant` is `GM_xmlhttpRequest` and `GM_addStyle`, and nothing else. No cookie access, no
credentials, no `GM_setValue`, no `unsafeWindow`.

## The clipboard

Written to, never read. Three things go on it and each one needs a press: a proper noun or acronym
(`p`), a heading (a rail chip), and a corrected reference (`Copy as N.`). All three are plain
text; the last is the citation string the tool returned, unchanged and with its `<a href>` tags
intact, because the reference box holds source and that is what pasting into it needs.

## The editor

The only DOM the script creates is `<div>`, `<span>` and `<button>` elements with `rlx-` ids and
classes, appended to `document.body` or to the article's title. **Nothing is ever written inside
the editor roots**, and save and submit are never touched. The highlights and the structure rail
are layers over the page, drawn from the text's own rectangles.

The citation chips are the one thing put inside the page rather than over it, and they are still
inside that rule: they go in the reference **form**, beside Radiopaedia's own "Format citation"
link, as `<button type="button">` — never a submit, never inside an editor root, never inside the
article. The reference itself is only ever read, out of the textarea's value, and a corrected one
reaches the article only by a person pasting it.

## Storage

`sessionStorage`, cleared when the tab closes:

| key | what |
| :-- | :-- |
| `rlx-lint-cache:<slug>` | the last article's JSON answer; older ones deleted on every write |
| `rlx-lint-pending` | a slug, for the hop to the edit page |
| `rlx-names`, `rlx-acronyms` | the two shared lists as fetched |
| `rlx-structure` | the canon, as fetched |
| `rlx-cite:<hash>` | one citation answer per reference asked about |

`localStorage`, which survives closing the browser. All of it is a preference or a note to self:

| key | what |
| :-- | :-- |
| `rlx-auto` | `1` or `0` — ask on every article page, or only on the click |
| `rlx-cites` | `1` or `0` — the citation chips on or off |
| `rlx-rail`, `rlx-optional` | `1` or `0` — the structure rail on or off, its optional sections shown or not |
| `rlx-bar-top` | which edge you last put the bar on |
| `rlx-profile` | `{slug: the kind of article you said it was}` |
| `rlx-hushed` | `{slug: [sections you said that article does not need]}` |
| `rlx-proposed` | `{word: YYYY-MM-DD}`, the names and acronyms you have proposed, so the same one is not offered again while the pull request is open |

The last three are the only ones with anything of yours in them: article slugs you edited, section
names you dismissed, and words you met while editing. Worth knowing before you paste a
`localStorage` dump anywhere. Nothing in either store ever leaves the browser. No cookies, and
nothing else persisted.

## Six things a careful reviewer will notice

None is a defect. Better said first than found.

1. **The automatic request**, above. It is the only thing here that costs Radiopaedia anything,
   and it belongs in the first paragraph of any email about this script, not the last.
2. **Single-key shortcuts** — `j k s x u c p t Esc` — are registered in the capture phase on
   `document` and on the editor iframe's document, with `preventDefault`. They are live only while
   the bar is open and guarded by `isTyping`, but for as long as a lint is open they can shadow a
   single-key shortcut the site itself has. The `Alt+` variants exist for exactly that reason.
3. **Two MutationObservers over `document.body`**, childList and subtree: one remounts the button
   when Radiopaedia remounts the page, the other notices references being added or removed. Both
   callbacks exit immediately in the common case, and the second is debounced by more than a
   second — but they are global observers, and if there is a performance objection this is where
   it will land.
4. **It writes into their iframe**: `w.__rlxListening = true`, plus `scroll`, `keydown` and `input`
   listeners on the editor's document. An own property with no plausible collision, but
   technically it touches their `window`.
5. **Automatic navigation**: after the preflight the script sets `location.href` to the article's
   `/edit` page — one extra page load on their servers per click.
6. **Cookies**: `GM_xmlhttpRequest` to radiopaedia.work carries the cookies *of that domain*, which
   is how the Cloudflare check is cleared. **No radiopaedia.org cookie ever leaves the browser** —
   worth stating explicitly to the .org side.

And one diagnostic `console.info` line on every radiopaedia.org page load, which is the quickest
answer to "why is there no button".

## Open

**The screenshots in `docs/`.** They show Radiopaedia content: in `findings-in-editor.png` the
*Striatocapsular infarct* article with its case images, and in `lint-and-sections.png` the
*Radiation colitis* article — including its "Last revised by" line, which names a real editor. The
repository is public, so these are already published, and the pages themselves are public on
Radiopaedia. Asking is therefore a courtesy after the fact rather than before it, and it belongs
in the same email as everything above.

## Closed

- **Author emails in the history.** Every commit carries the GitHub `noreply` address.
- **`@downloadURL` / `@updateURL` used to 404**, because the repository was private. It is public,
  and the raw URL serves the released version, so auto-update works.
- **Tailwind class scraping.** `extract()` and its `data-flux-*` selectors went with v1.5.0.
  Nothing in the script depends on how the linter's page is styled any more.
