# The Greasy Fork listing

The text to paste when publishing or updating the script on
[Greasy Fork](https://greasyfork.org/), kept here so it can be changed in the same commit as the
thing it describes.

**Set it up as a sync, not an upload.** On the script's page: *Admin* → **Sync script with an
external source**, pointing at

```
https://raw.githubusercontent.com/gmadevs/radiopaedia-lint-userscript/main/radiopaedia-lint.user.js
```

Then a release is one push and Greasy Fork re-imports on its own. Uploading the file by hand
instead makes a second copy that drifts behind `@version`, and people report bugs that were fixed
weeks ago.

Name, description and *Applies to* come from the script's own header. What follows goes in
**Additional info**, which takes Markdown.

- **License**: MIT
- **Antifeatures**: none to declare — no ads, no tracking, no analytics, no membership.

---

## Additional info

A **`Lint`** button next to the title of any [radiopaedia.org](https://radiopaedia.org) article. It
asks the [radiopaedia.work](https://radiopaedia.work) linter what is wrong with the article, takes
the colour of the worst of it, and — in the editor — lights the findings up **on the text
itself**, one at a time, with the message beside them and keys to walk through them.

It also answers three questions the linter leaves open:

- **Proper nouns and acronyms.** *"We don't start a list item with a capital letter. Exceptions are
  proper nouns"* — and on a radiology article half of those capitals are proper nouns. Two shared
  lists in the repository hold the ones we have met, a finding one of them answers is never shown,
  and <kbd>p</kbd> proposes the next one through a GitHub pull request. Add a name once and
  everybody running the script has it.
- **The sections that are missing.** The linter checks the headings that *are* there. In the grey
  margin beside the article, one chip for each section this kind of article is supposed to have and
  has not got — each beside the heading it would go under, from Radiopaedia's own recommended
  structure for all twenty-three kinds of article.
- **The references.** Beside every reference in the editor, a `Lint citation` chip: one press asks
  radiopaedia.work/cite what that reference should say and shows, word by word, what differs — the
  wrong journal abbreviation, the year off by one, the two references numbered 2. The corrected
  line goes to your clipboard as source, tags and all, for you to paste.

You need to be signed in to Radiopaedia with edit rights, since the point of it is the editor.

### What it talks to, and what it stores

Worth stating plainly for a script that runs on a whole site:

- **Four GET requests, and one POST you press.** The GETs go to `radiopaedia.work` (the lint API,
  and the citation tool when you press a chip) and to `raw.githubusercontent.com` (the two word
  lists and the structure file, all constant URLs, read-only). The POST is the `↻` beside the
  button: it presses the same `forceReload` the ⟳ on radiopaedia.work/lint/linter presses, by
  sending that page's own token and state back to it. Both hosts are named in `@connect`.
- **What leaves the browser**: the article's slug, which is already in the URL you are standing on
  — and, only when you press a `Lint citation` chip, that one reference. The `↻` sends nothing of
  yours: the slug, and the linter page's own token and snapshot, back to the page they came from.
- **No analytics, no telemetry, no third-party code, no remote code of any kind.** The script
  fetches *data* — JSON and two text files — and never executes anything it downloads.
- **It never writes into the editor.** Highlights and chips are drawn over the page, or put in the
  form around it; a correction reaches an article only by you pasting it.
- **Storage** is `sessionStorage` for the cached answers and `localStorage` for your own switches
  and preferences. Nothing in either ever leaves the browser. No cookies.
- `@grant` is `GM_xmlhttpRequest` and `GM_addStyle`, and nothing else.

The long version, function by function, is in
[SECURITY-NOTES.md](https://github.com/gmadevs/radiopaedia-lint-userscript/blob/main/SECURITY-NOTES.md).

### Where it lives

Source, documentation and issues:
**[github.com/gmadevs/radiopaedia-lint-userscript](https://github.com/gmadevs/radiopaedia-lint-userscript)**

One file, unminified, no build step, no dependencies. MIT.

The linter it asks is not mine: [radiopaedia.work](https://radiopaedia.work) is a separate tool,
and this script is a client for it.
