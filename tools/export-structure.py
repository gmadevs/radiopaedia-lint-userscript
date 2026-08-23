#!/usr/bin/env python3
"""Turn the canon in neuropedia's `struttura/db.py` into the file the userscript reads.

    tools/export-structure.py ../neuropedia/struttura/db.py > article-structure.json

`db.py` is the transcription of Radiopaedia's own `<type>-article-structure`
help pages — twenty-three canons, three hundred-odd headings, each with its
level and its parent, plus the eighty-four ways those headings are found
written in the wild. It is a Python module with a SQLite database behind it and
none of that can be shipped to a browser, so this walks it once and writes out
the part that is data.

It is a translation, not a copy, and it makes exactly three changes. They are
the three places where neuropedia is a book about neuroradiology and this is a
script that runs on the whole of Radiopaedia:

  * the names are put into English, because everything else in this repository
    is (`NAMES` below is the whole mapping, and nothing else renames anything);
  * `DROPPED` takes out the rules that only hold inside neuropedia;
  * the profile is no longer guessed from where an article sits in a book —
    the lint API's `article_type` says, and `BY_ARTICLE_TYPE` is the mapping.

Everything else is carried over untouched, regexes included: they use `\\b`,
`\\w`, `\\s`, alternation and optional groups, all of which mean the same thing
to Python's `re` and to JavaScript's `RegExp`.

Re-run it when `db.py` changes. Nothing here reads the network — the canon
changes when Radiopaedia's help pages change, and noticing that is a human job.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path

# The Italian names of `db.py`, in English. Kept explicit rather than
# transliterated: `misura` is a measurement and not a measure, `riassunto` is a
# summary article and not a summary, and a rule would have got both wrong.
NAMES = {
    "standard": "standard",
    "malattia": "disease",
    "frattura": "fracture",
    "segno": "sign",
    "dispositivo": "device",
    "comparativo": "comparison",
    "altro": "other",
    "anatomia": "anatomy",
    "anatomia-organo": "anatomy-organ",
    "anatomia-vaso": "anatomy-vessel",
    "anatomia-nervo": "anatomy-nerve",
    "anatomia-osso": "anatomy-bone",
    "anatomia-muscolo": "anatomy-muscle",
    "anatomia-articolazione": "anatomy-joint",
    "anatomia-spazio": "anatomy-space",
    "classificazione": "classification",
    "misura": "measurement",
    "procedura": "procedure",
    "protocollo-rm": "protocol-mri",
    "protocollo-tc": "protocol-ct",
    "tecnologia": "technology",
    "approccio": "approach",
    "radiografia-serie": "radiography-series",
    "radiografia-proiezione": "radiography-projection",
    "chimico": "chemical",
    "biografia": "biography",
    "mnemonico": "mnemonic",
    "riassunto": "summary",
}

# What each profile is, for the menu that overrides a wrong guess. One line, in
# the words Radiopaedia's own help pages use.
LABELS = {
    "disease": "Disease — the standard structure, in full",
    "fracture": "Fracture — mechanism in place of aetiology and pathology",
    "sign": "Sign — short, and not expected to have subheadings",
    "device": "Device — structure varies with the device, nothing required",
    "comparison": "Comparison (X vs Y) — subheadings at the author's discretion",
    "other": "Other — nothing required",
    "anatomy": "Anatomy — general",
    "anatomy-organ": "Anatomy — organ",
    "anatomy-vessel": "Anatomy — vessel",
    "anatomy-nerve": "Anatomy — nerve",
    "anatomy-bone": "Anatomy — bone",
    "anatomy-muscle": "Anatomy — muscle",
    "anatomy-joint": "Anatomy — joint",
    "anatomy-space": "Anatomy — space or region",
    "classification": "Classification, grading or scoring system",
    "measurement": "Measurement — a line, an angle, a ratio",
    "procedure": "Procedure or intervention",
    "protocol-mri": "MRI protocol",
    "protocol-ct": "CT protocol",
    "technology": "Imaging technology or physics",
    "approach": "Approach to a problem",
    "radiography-series": "Radiography — a series",
    "radiography-projection": "Radiography — one projection",
    "chemical": "Contrast agent or radiopharmaceutical",
    "biography": "Biography",
    "mnemonic": "Mnemonic",
    "summary": "Summary or revision article",
}

# Rules that hold in neuropedia and not here. `db.py` sends every article whose
# title says "protocol" without naming a modality to the MRI canon, because "in
# neuroradiologia è quasi sempre RM" — true of a neuroradiology book, not of a
# site that also covers chest CT. Dropped, so an unqualified protocol keeps
# whatever the earlier rules made of it.
DROPPED = [("protocollo-rm", r"\bprotocols?\b")]

MODALITY_TITLE = "\u2039any imaging modality\u203a"
MODALITY_ENTRY = "Radiographic features/" + MODALITY_TITLE

# What the lint API's `article_type` settles on its own. This is the half of
# `indovina_profilo` that neuropedia had to guess from the shape of its own
# book — an anatomy article recognised by which section its link sits in,
# because a regex on the title sent "temporal lobe epilepsy" to the anatomists.
# Here the server says, and says better. The anatomical SUB-type is still a
# guess from the title (`anatomyTypes`), and `general` still falls through to
# the title rules, which is where signs and mnemonics and classifications of
# every kind are told apart.
BY_ARTICLE_TYPE = {
    "anatomy_general": "anatomy",
    "classification": "classification",
}


def load(path: Path):
    spec = importlib.util.spec_from_file_location("neuropedia_db", path)
    if not spec or not spec.loader:
        raise SystemExit(f"not a Python module: {path}")
    sys.path.insert(0, str(path.parent))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def rename(name: str) -> str:
    if name not in NAMES:
        raise SystemExit(
            f"no English name for {name!r}. Add it to NAMES — a profile that "
            "silently kept its Italian name would be a profile nobody could "
            "select from the menu.")
    return NAMES[name]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("db", type=Path, help="path to neuropedia's struttura/db.py")
    ap.add_argument("-o", "--out", type=Path, help="write here instead of stdout")
    ap.add_argument("--transcribed", default="2026-08-04",
                    help="the day db.py's canon was read off Radiopaedia's help pages")
    args = ap.parse_args()

    db = load(args.db)

    # The canon. `ordine` is dropped: it was the index into the list, and the
    # list is still a list. The keys are one letter because this file is
    # fetched over the network on the first article of every session, and three
    # hundred headings times four spelled-out key names is most of its weight.
    canons = {
        rename(name): [
            {"v": c["voce"], "t": c["titolo"], "l": c["livello"], "p": c["genitore"]}
            for c in canon
        ]
        for name, canon in db.CANONI.items()
    }

    profiles = {}
    for name, p in db.PROFILI.items():
        key = rename(name)
        profiles[key] = {
            "canon": rename(p["canone"]),
            "modality": bool(p["modalita"]),
            "required": list(p["obbligatorie"]),
            "label": LABELS.get(key, key),
        }

    dropped = {(p, r) for p, r in DROPPED}
    seen = set()
    rules = []
    for profile, compiled in db.REGOLE:
        pattern = compiled.pattern
        if (profile, pattern) in dropped:
            seen.add((profile, pattern))
            continue
        rules.append([rename(profile), pattern])
    missing = dropped - seen
    if missing:
        raise SystemExit(
            f"DROPPED names a rule db.py no longer has: {sorted(missing)}. "
            "Either it was removed upstream — take it out of DROPPED — or it "
            "was reworded, and the reworded one is still in.")

    out = {
        "_": "Generated by tools/export-structure.py from neuropedia's "
             "struttura/db.py. Do not edit by hand: edit db.py and re-run.",
        "transcribed": args.transcribed,
        "source": "radiopaedia.org/articles/<type>-article-structure",
        # The one synthetic entry: under `Radiographic features` you do not need
        # every modality, you need one. `db.py` spells it in Italian because
        # nobody but `db.py` ever reads it; here it is shown on screen, so it
        # is spelled in the language of the rest.
        "modalityEntry": MODALITY_ENTRY,
        "modalityTitle": MODALITY_TITLE,
        "canons": canons,
        "profiles": profiles,
        "synonyms": db.SINONIMI,
        "rules": rules,
        "notPathologyOnly": sorted(rename(x) for x in db.SOLO_SE_NON_PATOLOGIA),
        "diseaseVeto": db._PATOLOGIA_RE.pattern,
        "anatomyTypes": [[rename(p), r.pattern] for p, r in db._TIPO_ANATOMIA],
        "byArticleType": BY_ARTICLE_TYPE,
        "fallbackProfile": "disease",
    }

    text = json.dumps(out, ensure_ascii=False, separators=(",", ":"), sort_keys=False)
    if args.out:
        args.out.write_text(text + "\n", encoding="utf-8")
        print(f"{args.out}: {len(text):,} bytes · {len(canons)} canons · "
              f"{sum(len(c) for c in canons.values())} headings · "
              f"{len(profiles)} profiles · {len(out['synonyms'])} synonyms",
              file=sys.stderr)
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
