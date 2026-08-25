# The canon

Radiopaedia's own recommended structure for each kind of article, as this script holds it: what is
in [`article-structure.json`](../article-structure.json), how the script decides which of the
twenty-three structures an article is being measured against, and how to regenerate the file when
Radiopaedia changes theirs.

What the rail *does* with all this — where a chip lands, what its colour and its indent mean, what
happens when there is no margin to put it in — is in the README, under
[The sections that are missing](../README.md#the-sections-that-are-missing).

---

## One canon per kind of article

Radiopaedia does not have one structure, it has **twenty-three**. Its own *standard article
structure* page gives the fixed order of the sections — Terminology, Epidemiology, Clinical
presentation, Pathology, Radiographic features, Treatment and prognosis, History and etymology,
Differential diagnosis, and the rest — and then says that holds "in most instances, except for the
following specific special purpose articles", and lists eighteen of them. An anatomy article wants
`Gross anatomy` and `Variant anatomy` and has no business being asked for `Epidemiology`.

All twenty-three are in [`article-structure.json`](../article-structure.json): 327 headings, each
with the level it belongs at and the heading it belongs under, the 84 ways those headings are
found written in real articles (`etiology`, `plain film`, `CT scan`), and which of them each kind
of article is actually required to have. They are **Radiopaedia's recommendations, not ours**,
transcribed from `radiopaedia.org/articles/<type>-article-structure` on 2026-08-04 — when they
change theirs, this is an old transcription until somebody re-runs the export.

Two things in there are worth stating plainly, because they are the parts that look like details
and are not:

- **The parent is part of a heading's identity.** `Complications` under `Clinical presentation` is
  the complication of the disease; under `Treatment and prognosis` it is the complication of the
  treatment. Two rows of the canon, and an article can want both.
- **One modality is enough.** Under `Radiographic features` you do not need every modality, you
  need one. An article with no imaging at all is incomplete however long it is; an article with a
  CT section cannot be asked for an MRI by a machine.

The **required** headings become chips on their own; the optional ones are a click away, for the
reason given under [Required and offered](../README.md#required-and-offered) — every canon has
thirty-odd of them, and an article that has all six of its obligations is not improved by being
handed thirty suggestions unasked.

## How it knows what kind of article it is

From `article_type`, which comes back inside the lint answer:

```json
{"slug":"scaphoid-bone","article_type":"anatomy_general","counts":[],"lints":[]}
```

That is Radiopaedia's own classification of its own article, and where it says something it is
right. It only separates a few kinds — anatomy and classification are the ones that matter, and
everything else arrives as `general` — so the rest is an ordered list of rules on the title, first
match wins: a mnemonic before a disease, because *Tuberous sclerosis mnemonic* is a mnemonic; a
classification before a measurement, because *Bern score* is a classification; a procedure before
a device, because a ventriculoperitoneal shunting is an operation and the valve is the object.
Three rules are held back by a title that names a disease — *Iodinated contrast induced
thyrotoxicosis* is not a contrast agent, it is the thyrotoxicosis one causes.

It gets things wrong, and it is meant to: the menu in the rail header is the answer to that, and
what you choose is remembered for that article. The one worth watching is the **sign** — an
article Radiopaedia says is "in general short" and does "not usually require subheadings". The API
calls signs `general` like everything else, so only `sign` in the title keeps them out of the
disease canon, and a sign measured as a disease is six chips of noise.

## Changing the canon

`article-structure.json` is generated, not written:

```bash
tools/export-structure.py ../neuropedia/struttura/db.py -o article-structure.json
node tools/check-structure.js
```

The source is the canon in [neuropedia](https://github.com/gmadevs/neuropedia)'s `struttura/`,
where it is kept as Python with a database behind it. The exporter walks it once and writes out
the part that is data, making exactly three changes — the names go into English, the rules that
only hold inside a neuroradiology book are dropped, and the profile stops being guessed from where
an article sits in that book, because here the API says. The regexes cross over untouched: they
use `\b`, `\w`, `\s`, alternation and optional groups, and every one of those means the same thing
to Python and to JavaScript.

`tools/check-structure.js` runs the checks against headings read off real articles — CSF
overdrainage, the scaphoid — pulling the module straight out of the userscript rather than a copy,
so there is nothing in the test that can drift from what ships.

