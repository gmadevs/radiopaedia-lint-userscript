<div align="center">

# Radiopaedia Lint

**A `Lint` button next to the title of any [radiopaedia.org](https://radiopaedia.org) article.**

Click it and the findings come back lit up *on the text itself* in the editor — coloured by
severity, with the message alongside, and keys to walk through them one at a time. Turn its
**auto** switch on and it does not wait to be clicked: every article you open goes to the
[radiopaedia.work lint API](https://radiopaedia.work/api/v1/lint?article=epilepsy) and the button
takes the colour of what came back, so you know before clicking.

[![Install](https://img.shields.io/badge/Install-userscript-2ea44f?style=for-the-badge&logo=tampermonkey&logoColor=white)](https://raw.githubusercontent.com/gmadevs/radiopaedia-lint-userscript/main/radiopaedia-lint.user.js)

[![Version](https://img.shields.io/github/v/release/gmadevs/radiopaedia-lint-userscript?color=blue)](https://github.com/gmadevs/radiopaedia-lint-userscript/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-black)](LICENSE)
[![Userscript](https://img.shields.io/badge/userscript-Tampermonkey-00485B?logo=tampermonkey&logoColor=white)](https://www.tampermonkey.net/)
[![No build step](https://img.shields.io/badge/dependencies-none-lightgrey)](radiopaedia-lint.user.js)

<img src="docs/lint-button.png" alt="The Lint button and its auto switch, sitting next to a Radiopaedia article title" width="820">

</div>

```
page opens   auto  →  radiopaedia.work/api/v1/lint  →  the button takes the colour of the worst
                                                       🔴 error 🟠 warning 🔵 suggestion ⚪ none

click              →  that same answer, from the cache  ┬─  nothing to fix  →  a banner, you stay
                      (or the first one, in manual)     └─  findings        →  /edit, on the text
```

---

## Contents

- [Installing](#installing)
- [The colour of the button](#the-colour-of-the-button)
- [Nothing to lint](#nothing-to-lint)
- [Working through the findings](#working-through-the-findings)
- [How it works](#how-it-works)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Installing

**1. Install [Tampermonkey](https://www.tampermonkey.net/).**

**2. Open [`radiopaedia-lint.user.js`](https://raw.githubusercontent.com/gmadevs/radiopaedia-lint-userscript/main/radiopaedia-lint.user.js).**
Tampermonkey recognises any URL ending in `.user.js` and offers to install it; from then on it
checks the same URL for updates on its own. Failing that: Dashboard → **+** (new script) → paste
the file → save.

**3. Chrome and Edge only — turn on user scripts.**

> [!IMPORTANT]
> Open `chrome://extensions` (or `edge://extensions`), find Tampermonkey, and turn on
> **Allow user scripts** — on some versions it is **Developer mode** instead. Without it,
> Tampermonkey lists the script as enabled and runs nothing, silently.

**4. Reload an article page.** The console should carry one line:

```text
[Radiopaedia Lint] active · /articles/epilepsy · slug: epilepsy · mode: automatic · button: next to the title
```

That line is the quickest answer to *"why is there no button"*: if it is missing, the script is
not running at all, and nothing about where the button gets placed matters yet.

> [!NOTE]
> You need to be signed in to Radiopaedia with edit rights, since the whole point is the editor.

---

## The colour of the button

Next to the button there is a switch:

| | |
| :-- | :-- |
| **auto**, filled | every article you open is sent to the linter and the button colours itself |
| **auto**, hollow | manual: nothing is asked until you press `Lint`, the way it worked before |

The choice is remembered across sessions — one `rlx-auto` key in `localStorage`, nothing else
persists — and switching back to automatic asks about the article you are on straight away
rather than waiting for the next page.

In automatic mode, opening an article asks the linter about it and the button says the answer in
the colour of the worst thing in there — the same colours the highlights use in the editor, so it reads as the same
thing seen from further away. Hovering it gives you the count.

| | The button | The article |
| :-: | :-- | :-- |
| 🔴 | red | at least one `error` |
| 🟠 | amber | no errors, at least one `warning` |
| 🔵 | blue | only `suggestion`s |
| ⚪ | grey | nothing to fix |
| | pale, half-faded | still asking |

The answer is kept for the session, so the click that follows costs no second request — and on a
grey button it does not even need the editor: the *nothing to lint* banner comes back instantly.

> [!IMPORTANT]
> Automatic mode is one request per article page you open, where it used to be one per click,
> and the linter reads the article from Radiopaedia to answer it. It is kept to the article page
> itself (not its revisions, not the editor), it waits for a tab you are actually looking at
> rather than one the browser opened on a guess, it never retries, and it fails silently — a
> button that could not ask looks exactly like one that has not been asked. The switch turns it
> off for good; `PREVIEW_ON_LOAD` at the top of the script decides what a browser that has never
> touched the switch does.

---

## Nothing to lint

The button asks the linter **before** it takes you anywhere. An article the linter has nothing to
say about no longer costs you the trip to the edit page and the trip back: a banner says so, and
you stay where you are. **Re-lint** answers the same way — once the last finding is gone the bar
closes and the banner takes its place.

This is not an extra request. It is the same one, made a moment earlier: the answer is kept in
`sessionStorage`, and the edit page reads it from there instead of asking again.

> [!NOTE]
> Zero findings means zero findings. The answer is JSON, and anything that is not a lint result —
> a Cloudflare check, an error, an article the linter cannot read — is refused before it gets
> anywhere near the banner, so *"nothing to lint"* is never something a broken reader says by
> mistake.

---

## Working through the findings

<div align="center">
  <img src="docs/findings-in-editor.png" alt="A warning highlighted in the editor, its message in a note beside it, and the Lint bar along the bottom" width="900">
</div>

Findings are highlighted in place, one is always current, and the bottom bar keeps the count.

### Keyboard

While you are typing in the editor those letters have to stay letters — so there, the shortcuts
move to <kbd>Alt</kbd>.

| Action | On the page | While typing in the editor |
| :-- | :-- | :-- |
| Next finding | <kbd>j</kbd> | <kbd>Alt</kbd> + <kbd>→</kbd> |
| Previous finding | <kbd>k</kbd> | <kbd>Alt</kbd> + <kbd>←</kbd> |
| Mark done | <kbd>s</kbd> | <kbd>Alt</kbd> + <kbd>Enter</kbd> |
| Ignore | <kbd>x</kbd> | <kbd>Alt</kbd> + <kbd>Backspace</kbd> |
| Undo the last verdict | <kbd>u</kbd> | — |
| Copy the message | <kbd>c</kbd> | — |
| Close | <kbd>Esc</kbd> | — |

Everything is on the bottom bar too, including **Re-lint** to ask the linter again after you have
saved. Nothing on this list happens by itself: editing the text can close a finding, but only
these move you to another one.

### Severity

| | Severity | Colour |
| :-: | :-- | :-- |
| 🔴 | `error` | red |
| 🟠 | `warning` | amber |
| 🔵 | `suggestion` | blue |

One table, two places: these are the colours of the highlights, of the note beside them, and of
the button before you ever click it.

### The note stays out of the way

It goes below the highlighted words, or above, or to the side — whichever lands clear — and it
never repeats the snippet, because you are already looking at it. When a finding is so tall that
nothing fits beside it, hovering the note fades it out of the way.

---

## How it works

<details>
<summary><strong>Where the findings come from</strong></summary>

<br>

One `GET`, no key, JSON back. The `article` parameter takes a slug, an rID, or a whole
Radiopaedia URL:

```text
GET https://radiopaedia.work/api/v1/lint?article=pneumothorax
```

```jsonc
{
  "slug": "pneumothorax",
  "article_type": "general",
  "counts": { "error": 3, "warning": 12, "suggestion": 5 },
  "lints": [
    {
      "condition": "Radiopaedia.OxfordComma",   // the check → "Oxford Comma"
      "severity":  "suggestion",                // the colour
      "message":   "Use the Oxford comma in …", // the note beside the highlight
      "trimmed":   "Presentation is variable…", // the line as plain text → what is searched for
      "matched":   "deterioration, hypoxaemia and circulatory",   // → what is lit
      "line": 12,
      "position": 276                           // → which copy of it along that line
    }
  ]
}
```

`fromApi()` turns one entry into one finding, and that is the whole reading of the answer: seven
fields, named. Up to v1.4.2 there was no API and the findings had to be scraped out of the
linter's [rendered page](https://radiopaedia.work/lint/linter?slug=pneumothorax) — same findings,
but read through Tailwind classes that were never meant as an interface, at 400 kB and ~1.9 s a
click instead of 14 kB and ~0.6 s.

The page is still the better thing to *read*: it groups findings by check and explains them. The
script wants them one at a time, in article order, with the offending words marked — which is
what the API gives.

</details>

<details>
<summary><strong>The text is never touched</strong></summary>

<br>

The highlight is a layer of rectangles laid over the page, drawn from the `getClientRects()` of
the ranges and redrawn on every scroll. **Not a single tag goes into the editor content.**
Wrapping the snippets in `<mark>` would have been simpler and would have published those `<mark>`
elements inside the article the first time you hit save.

</details>

<details>
<summary><strong>The anchor is the snippet, not the line</strong></summary>

<br>

`line:column` shifts the moment anyone adds a paragraph above, and the editor's lines are not the
linter's lines anyway. So the quoted snippet is searched for in the text instead — ignoring
spacing, case, curly quotes, and **zero-width spaces**, which Radiopaedia articles are full of.
The linter quotes the "Radiographic features" heading with a U+200B stuck to the front, and `\s`
in JavaScript does not cover that character: one invisible thing, and the snippet is never found.

Once the snippet is located, the highlight tightens onto the offending words themselves — the API
names them in `matched`, and `position` says which copy of them along the line, so on a sentence
with six commas in it the sixth is the one that lights up.

**Reference markers are not prose.** The commas inside `<sup>2,4,6,11,12</sup>` are commas on the
page and nothing else, and they are skipped when counting and when choosing what to light. Where
the linter's own position lands inside one — *"more than 5 commas in a single sentence"* is
reported against a comma of the citation — nothing is narrowed at all and the whole sentence
stays lit, which is what the message is about anyway. A rule that really is about citations, like
the spacing before one, still gets its highlight: those are skipped only while there is prose to
prefer. One lit acronym is worth more than a
paragraph washed in colour. On the `epilepsy` article that is 11 findings out of 11 anchored, all
11 narrowed to the exact words; across `pneumothorax`, `meningioma`, `appendicitis`,
`glioblastoma-idh-wildtype` and `striatocapsular-infarct`, 148 out of 148 anchored and 146
narrowed — the two that stay wide are `<strong> </strong>`, an empty bold tag, which is nothing
to point at once the markup is gone.

</details>

<details>
<summary><strong>"Done" is a word you say</strong></summary>

<br>

The linter lints the **published** article, not what is sitting in your form: the findings are a
snapshot of how things were before you started, and they do not recompute while you fix them.
What can be checked for free is checked — the moment a snippet can no longer be found in the
text, its finding closes itself, which is also how you see that a fix landed. <kbd>u</kbd>
reopens it.

**Closing it does not move you.** The note stays on the paragraph you are working on, turns green
and says *✓ fixed*; the highlight goes, the count drops, and nothing scrolls. Going to the next
finding is a key you press — <kbd>Alt</kbd> + <kbd>→</kbd> while you are typing — never something
your typing does to you.

Verdicts are **not kept**: close the tab and they are gone. That is deliberate rather than
missing. This button is for the short loop — *"I am on this article, show me what is wrong with
it"* — and a second memory of verdicts that never talks to the first one is worse than one.

</details>

<details>
<summary><strong>One request here is one request there</strong></summary>

<br>

The linter reads the article from Radiopaedia on your behalf, so a request to the API is a
request to them. Since the button colours itself on load, that is now one request per article
page you open rather than one per click — a real change, and the reason for every guard listed
[above](#the-colour-of-the-button): the article page only, a visible tab only, one answer per
article per session, no retry.

Everything downstream still reads that one answer. The edit page finds it in `sessionStorage`
instead of asking again, and so does the check that happens before the jump to the editor: the
article page asks, everything after it remembers.

The API itself is unauthenticated and rate-limited at 60 requests a minute — a number a person
reading articles will never come near, and a number a loop would reach in seconds.

> [!WARNING]
> Please do not wrap this in anything that clicks by itself.

</details>

---

## Troubleshooting

| Symptom | Likely cause | Fix |
| :-- | :-- | :-- |
| No button, and no `[Radiopaedia Lint] active` line in the console | The script is not running | Chrome/Edge: turn on **Allow user scripts** for Tampermonkey (step 3 above) |
| Button is there, no findings come back | The API's field names changed, or it is answering an error | See *What can break it* below |
| Findings come back, nothing is highlighted | A different editor, or a snippet that cannot be found in the text | See `EDITOR_SELECTORS` below |
| *"Article not found"*, or *"nothing in it to lint"* | The API's own answer (404 / 422) for that article | Check the slug in the URL; a stub with no text has nothing to lint |
| *"Cloudflare bot check"* | radiopaedia.work wants a human first | Open [radiopaedia.work](https://radiopaedia.work/) in a tab, clear the check, click again |

<details>
<summary><strong>What can break it</strong></summary>

<br>

**The API's field names.** `fromApi()` reads `lints[]` and, in each entry, `condition`,
`severity`, `message`, `trimmed`, `matched`, `line` and `position`. A renamed field is what would
stop it — where the previous versions read the findings off the linter's HTML page, through
Tailwind classes that were never an API, and a new stylesheet was enough to break them silently.

**The editor selectors**, in `EDITOR_SELECTORS` near the top: TinyMCE in an iframe and plain
contenteditables are covered. A different editor gets added there.

**The title**, which has broken it once already. Signed in, the page carries two `h1` elements,
and the one belonging to the user menu (`media-heading user-menu-name`, zero by zero) comes first
in the document. `querySelector` with a list of selectors returns the first matching *element*,
not the first matching *selector*, so the button was being mounted inside something invisible —
and signed out, where that `h1` does not exist, everything looked fine. `visibleTitle()` now
skips anything that takes up no room, and after mounting, the button's own rectangle is measured:
if it comes back zero, it moves to the top right corner. An ugly button you can see beats a
well-placed one you cannot.

</details>

---

## License

[MIT](LICENSE) © Giorgio Maria Agazzi

Not affiliated with Radiopaedia.org. The linting itself is done by
[radiopaedia.work](https://radiopaedia.work/); this script is the button, the highlighting and
the walk-through.
