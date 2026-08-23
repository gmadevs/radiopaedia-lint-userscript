#!/usr/bin/env node
/* Runs the structure module against headings read off real Radiopaedia pages.
 *
 *     node tools/check-structure.js
 *
 * The canon is a transcription that goes stale, `article-structure.json` is
 * regenerated from it, and both are edited by people who are thinking about
 * radiology rather than about this script. So the things worth pinning down
 * are the ones a re-export can quietly break: that the profiles still resolve,
 * that a heading written the way articles actually write it is still
 * recognised, and that the kinds of article Radiopaedia asks nothing of are
 * still asked nothing.
 *
 * It reads the module straight out of the userscript rather than a copy of it,
 * so there is nothing here that can drift from what ships. The browser is
 * stubbed down to the few things the pure half touches; anything that reaches
 * for the network or the DOM is not exercised, and is not what this is for.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'radiopaedia-lint.user.js');
const CANON = path.join(ROOT, 'article-structure.json');

const START = '  // ————————————————————————————————————————————————— the structure';
const END = '  // ——————————————————————————————————————————————————————————— startup';

function load() {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const a = src.indexOf(START), b = src.indexOf(END);
  if (a < 0 || b < 0) throw new Error('the structure module is not where it was in the userscript');

  const stubs = `
    const tidy = (v) => String(v ?? '').replace(/\\s+/g, ' ').trim();
    const COLORS = { warning: { ink: '#d97706' } };
    const GM_xmlhttpRequest = () => {};
    const requestAnimationFrame = (f) => f();
    const addEventListener = () => {}, removeEventListener = () => {};
    const innerHeight = 900, navigator = {};
    const localStorage = { getItem: () => null, setItem() {} };
    const sessionStorage = { getItem: () => null, setItem() {} };
    const document = { title: 'Test | Radiopaedia.org', querySelector: () => null,
                       body: { appendChild() {} } };
    // \`anchorFor\` asks the page which of two headings comes first. Off the
    // page, that is the position in the list they were read from.
    const Node = { DOCUMENT_POSITION_PRECEDING: 2, DOCUMENT_POSITION_FOLLOWING: 4 };
    const currentSlug = () => 'test-article';
    const inEditor = () => false;
    const visibleTitle = () => null;
    let railToggle = null;
  `;
  const expose = `
    return { compile, profileFor, whatIsMissing, anchorFor, canonicalHeading,
             railContent, setCanon: (c) => { CANON = c; } };
  `;
  const M = new Function(stubs + src.slice(a, b) + expose)();
  M.setCanon(M.compile(JSON.parse(fs.readFileSync(CANON, 'utf8'))));
  return M;
}

const M = load();

/* The stylesheet is a template literal, and a backtick inside one of its
 * comments ends it early — which does not fail here, it fails at `new
 * Function`, with a syntax error pointing at a line of CSS. It has happened
 * twice, both times while writing a comment that quoted a CSS property the way
 * every other comment in the file quotes code. So the file says it plainly and
 * this checks it, rather than trusting whoever writes the next comment to
 * remember. `${` would be worse: that one interpolates silently. */
function checkStyleBlock() {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const open = src.indexOf('GM_addStyle(`');
  if (open < 0) return console.log('✓ the style block is where it was') || 0;
  const from = open + 'GM_addStyle(`'.length;
  const block = src.slice(from, src.indexOf('`);', from));
  const problems = [];
  if (block.includes('`')) problems.push('a backtick inside it ends the template early');
  if (block.includes('${')) problems.push('a ${ inside it interpolates silently');
  if (problems.length) {
    failed++;
    console.log('✗ the CSS template literal');
    for (const p of problems) console.log(`    ${p} — use " instead`);
  } else {
    console.log('✓ the CSS template literal has nothing in it that ends it early');
  }
}

/* Headings as the page hands them over: a level and a title, in document
 * order. The parent is worked out the same way `sectionsOnPage` works it out. */
function page(list) {
  const found = [], stack = [];
  list.forEach(([level, title], pos) => {
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    const el = { tag: title, pos,
                 compareDocumentPosition: (other) =>
                   (other.pos > pos ? Node.DOCUMENT_POSITION_FOLLOWING
                                    : Node.DOCUMENT_POSITION_PRECEDING) };
    found.push({ el, level, title,
                 parent: stack.length ? stack[stack.length - 1].title : null });
    stack.push({ level, title });
  });
  return found;
}
const Node = { DOCUMENT_POSITION_PRECEDING: 2, DOCUMENT_POSITION_FOLLOWING: 4 };

let failed = 0;
checkStyleBlock();

function check(name, opts) {
  const { title, type, headings = [], profile, missing, offered, anchors, jumbled } = opts;
  const found = page(headings);
  const got = M.profileFor(title, type);
  const measured = M.whatIsMissing(got, found);
  const { rows, seen, canonName } = measured;
  const required = rows.filter((r) => r.required).map((r) => r.title);
  const optional = rows.filter((r) => !r.required).map((r) => r.title);
  const problems = [];

  if (profile && got !== profile) problems.push(`profile: expected ${profile}, got ${got}`);
  if (missing && required.join(' · ') !== missing.join(' · ')) {
    problems.push(`required: expected [${missing.join(', ')}], got [${required.join(', ')}]`);
  }
  if (offered && optional.join(' · ') !== offered.join(' · ')) {
    problems.push(`optional: expected [${offered.join(', ')}], got [${optional.join(', ')}]`);
  }
  if (jumbled !== undefined && !!measured.jumbled !== jumbled) {
    problems.push(`jumbled: expected ${jumbled}, got ${!!measured.jumbled}`);
  }
  if (anchors) {
    for (const [heading, where] of Object.entries(anchors)) {
      const row = rows.find((r) => r.title === heading);
      if (!row) { problems.push(`anchor: ${heading} is not among the missing`); continue; }
      const { el, inside } = M.anchorFor(row, seen, canonName);
      const at = el ? (inside ? 'in ' : '') + el.tag : null;
      if (at !== where) problems.push(`anchor: ${heading} → expected ${where}, got ${at}`);
    }
  }

  if (problems.length) {
    failed++;
    console.log(`✗ ${name}`);
    for (const p of problems) console.log(`    ${p}`);
  } else {
    console.log(`✓ ${name}  (${got}${required.length ? ' — needs ' + required.join(', ') : ''}`
              + `${optional.length ? ' — offers ' + optional.length : ''})`);
  }
}

// —— the article the whole thing was drawn for ——————————————————————————
// radiopaedia.org/articles/csf-overdrainage, headings as the page renders them.
check('a disease article, three sections in', {
  title: 'CSF overdrainage', type: 'general',
  headings: [[1, 'Clinical presentation'], [1, 'Radiographic features'],
             [1, 'Treatment and prognosis']],
  profile: 'disease',
  missing: ['Epidemiology', 'Pathology', '‹any imaging modality›', 'Differential diagnosis'],
  // Each one beside the section the canon puts after it — which is where it goes.
  anchors: { Epidemiology: 'Clinical presentation', Pathology: 'Radiographic features',
             '‹any imaging modality›': 'in Radiographic features',
             'Differential diagnosis': null },
});

// —— the API knows what the title never could ————————————————————————————
// radiopaedia.org/articles/scaphoid-bone. Measured with the standard canon it
// would want Epidemiology and Treatment and prognosis; `anatomy_general` is
// what keeps it from being asked.
check('an anatomy article, complete', {
  title: 'Scaphoid', type: 'anatomy_general',
  headings: [[1, 'Gross anatomy'], [2, 'Osteology'], [2, 'Articulations'],
             [2, 'Attachments'], [3, 'Musculotendinous'], [3, 'Ligamentous'],
             [2, 'Relations'], [1, 'Arterial supply'], [1, 'Variant anatomy'],
             [1, 'Radiographic features'], [2, 'Plain radiograph'],
             [1, 'Development'], [2, 'Ossification'],
             [1, 'History and etymology'], [1, 'Related pathology']],
  profile: 'anatomy', missing: [],
});

check('an anatomy sub-type, from the title', {
  title: 'Biceps brachii muscle', type: 'anatomy_general', profile: 'anatomy-muscle',
});

// —— the kinds Radiopaedia asks nothing of ————————————————————————————————
// The expensive mistake: a sign measured as a disease is six chips of noise on
// an article Radiopaedia says does not usually require subheadings at all.
check('a sign is asked nothing', {
  title: 'Air crescent sign', type: 'general',
  headings: [[1, 'Radiographic features']], profile: 'sign', missing: [],
});
check('a device is asked nothing', {
  title: 'Ventriculoperitoneal shunt catheter', type: 'general',
  profile: 'device', missing: [],
});

// —— first rule wins, and the order is the whole criterion ————————————————
check('a mnemonic before a disease', {
  title: 'Tuberous sclerosis mnemonic', type: 'general', profile: 'mnemonic',
});
check('a classification before a measurement', {
  title: 'Bern score', type: 'general', profile: 'classification',
});
check('a procedure before a device', {
  title: 'Ventriculoperitoneal shunting', type: 'general', profile: 'procedure',
});

// —— the veto: a title naming a disease is the disease, not the thing ————
check('the disease veto holds back "chemical"', {
  title: 'Iodinated contrast induced thyrotoxicosis', type: 'general', profile: 'disease',
});

// —— synonyms: a section that is there under another name is there ————————
check('synonyms count as present', {
  title: 'Some disease', type: 'general',
  headings: [[1, 'Epidemiology'], [1, 'Clinical features'], [1, 'Pathology'],
             [1, 'Radiographic features'], [2, 'CT scan'], [1, 'Treatment'],
             [1, 'Differentials']],
  profile: 'disease', missing: [],
});

// —— one modality is enough, and none is not ——————————————————————————————
check('any one modality satisfies the imaging requirement', {
  title: 'Some disease', type: 'general',
  headings: [[1, 'Epidemiology'], [1, 'Clinical presentation'], [1, 'Pathology'],
             [1, 'Radiographic features'], [2, 'MRI'],
             [1, 'Treatment and prognosis'], [1, 'Differential diagnosis']],
  profile: 'disease', missing: [],
});
check('Radiographic features with nothing under it is not enough', {
  title: 'Some disease', type: 'general',
  headings: [[1, 'Epidemiology'], [1, 'Clinical presentation'], [1, 'Pathology'],
             [1, 'Radiographic features'],
             [1, 'Treatment and prognosis'], [1, 'Differential diagnosis']],
  profile: 'disease', missing: ['‹any imaging modality›'],
});

// —— an article with no headings at all wants the lot ——————————————————————
check('an empty article', {
  title: 'Some new disease', type: 'general', profile: 'disease',
  missing: ['Epidemiology', 'Clinical presentation', 'Pathology',
            'Radiographic features', '‹any imaging modality›',
            'Treatment and prognosis', 'Differential diagnosis'],
});

// —— the parent is part of a heading's identity ————————————————————————————
// `Complications` is in the standard canon twice. Under `Treatment and
// prognosis` it must not be read as the one under `Clinical presentation`.
check('the two Complications are two headings', {
  title: 'Some disease', type: 'general',
  headings: [[1, 'Treatment and prognosis'], [2, 'Complications']],
  profile: 'disease',
  // `Treatment and prognosis` is present and drops off the list; the
  // `Complications` under it is a row of its own and takes nothing else with
  // it. Read as the other `Complications`, this article would look as though
  // it had a section under `Clinical presentation` that it has not got.
  missing: ['Epidemiology', 'Clinical presentation', 'Pathology',
            'Radiographic features', '‹any imaging modality›',
            'Differential diagnosis'],
});

// —— what is offered, and what is not worth offering ——————————————————————
// A subsection is only offered once the section it belongs under is there:
// `Pathology/Genetics` on an article with no `Pathology` is the leaf before
// the branch. Top-level rows are always offered.
check('nothing but top-level is offered to an empty article', {
  title: 'Some disease', type: 'general',
  offered: ['Terminology', 'Usage', 'Diagnosis', 'Radiology report',
            'History and etymology', 'Practical points', 'See also'],
});
check('a present section opens its own subsections', {
  title: 'Some disease', type: 'general',
  headings: [[1, 'Pathology']],
  offered: ['Terminology', 'Usage', 'Diagnosis',
            'Pathology/Aetiology', 'Pathology/Location', 'Pathology/Classification',
            'Pathology/Macroscopic appearance', 'Pathology/Microscopic appearance',
            'Pathology/Immunophenotype', 'Pathology/Markers', 'Pathology/Genetics',
            'Radiology report', 'History and etymology', 'Practical points', 'See also']
           .map((v) => v.split('/').pop()),
});
// The nine modalities are all children of `Radiographic features`. Offered as
// optional rows they would arrive nine at a time on any article that has that
// section — and what Radiopaedia asks for there is one, which is already a
// required row of its own. So the direct children are held back.
//
// A sub-modality is not: `Dual-energy CT` sits under `CT`, and it only appears
// on an article that has a `CT` section, one at a time, which is the general
// rule doing its job rather than an exception to it.
check('the modalities are not offered one by one, sub-modalities are', {
  title: 'Some disease', type: 'general',
  headings: [[1, 'Radiographic features'], [2, 'CT']],
  offered: ['Terminology', 'Usage', 'Diagnosis', 'Dual-energy CT', 'Radiology report',
            'History and etymology', 'Practical points', 'See also'],
});
check('and nothing under Radiographic features when no modality is there', {
  title: 'Some disease', type: 'general',
  headings: [[1, 'Radiographic features']],
  offered: ['Terminology', 'Usage', 'Diagnosis', 'Radiology report',
            'History and etymology', 'Practical points', 'See also'],
});

// —— sections in the wrong order ——————————————————————————————————————————
// The linter reports the wrong-parent half of this itself. What it costs HERE
// is the placement: a missing heading is put beside the sections it comes
// before, and "before" stops being obvious once the article is out of order.
check('an article in order is not flagged', {
  title: 'Some disease', type: 'general',
  headings: [[1, 'Clinical presentation'], [1, 'Radiographic features'],
             [1, 'Treatment and prognosis']],
  jumbled: false,
});
check('an article out of order is flagged', {
  title: 'Some disease', type: 'general',
  headings: [[1, 'Radiographic features'], [1, 'Clinical presentation']],
  jumbled: true,
});
// The whole point of anchoring by the page rather than by the canon.
// Epidemiology comes before both of these sections, so it belongs beside
// whichever of them the reader meets FIRST — which here is the one the canon
// names second.
check('out of order, the anchor is the topmost section, not the first in canon', {
  title: 'Some disease', type: 'general',
  headings: [[1, 'Radiographic features'], [2, 'CT'], [1, 'Clinical presentation']],
  missing: ['Epidemiology', 'Pathology', 'Treatment and prognosis',
            'Differential diagnosis'],
  anchors: {
    Epidemiology: 'Radiographic features',
    Pathology: 'Radiographic features',
    // Nothing in the canon after these two is on the page at all.
    'Treatment and prognosis': null,
    'Differential diagnosis': null,
  },
  jumbled: true,
});
// Read off radiopaedia.org/articles/deviated-nasal-septum, which puts
// `Complications` under `Pathology` — a place the canon does not have it.
check('a real article with a section under the wrong parent', {
  title: 'Deviated nasal septum', type: 'general',
  headings: [[1, 'Clinical presentation'], [1, 'Pathology'], [2, 'Etiology'],
             [2, 'Associations'], [2, 'Complications'],
             [1, 'Radiographic features'], [2, 'CT'], [1, 'Treatment and prognosis']],
  profile: 'disease',
  missing: ['Epidemiology', 'Differential diagnosis'],
  anchors: { Epidemiology: 'Clinical presentation', 'Differential diagnosis': null },
});

// —— a subsection belongs beside its parent, not beside what follows it ————
// radiopaedia.org/articles/aqueductal-stenosis, headings as the page has them.
// `Risk factors` and `Associations` belong under `Epidemiology`; `Complications`
// under `Clinical presentation`. Anchored by what the canon names next they
// would line up against the section AFTER their parent — Risk factors beside
// Clinical presentation, Complications beside Pathology — and read as though
// they belonged to it.
check('a subsection anchors to the section it belongs under', {
  title: 'Aqueduct stenosis', type: 'general',
  headings: [[1, 'Epidemiology'], [1, 'Clinical presentation'], [1, 'Pathology'],
             [1, 'Radiographic features'], [2, 'Ultrasound'], [2, 'MRI'],
             [1, 'Treatment and prognosis']],
  profile: 'disease',
  missing: ['Differential diagnosis'],
  anchors: {
    'Risk factors': 'in Epidemiology',
    Associations: 'in Epidemiology',
    Complications: 'in Clinical presentation',
    Genetics: 'in Pathology',
    // A top-level row still anchors to the sections it comes before.
    Terminology: 'Epidemiology',
    Diagnosis: 'Pathology',
    'Differential diagnosis': null,
  },
});
// The missing modality is not a case of its own: its parent is `Radiographic
// features`, and the same rule puts it there.
check('the missing modality is the parent rule, not an exception to it', {
  title: 'Some disease', type: 'general',
  headings: [[1, 'Radiographic features'], [1, 'Treatment and prognosis']],
  anchors: { '‹any imaging modality›': 'in Radiographic features' },
});
// With the parent gone there is nothing to sit under, and the row falls back
// to the sections it comes before.
check('a subsection whose parent is absent falls back', {
  title: 'Some disease', type: 'general',
  headings: [[1, 'Treatment and prognosis']],
  anchors: { '‹any imaging modality›': 'Treatment and prognosis' },
});

// —— the rail must not be able to take its own controls away ——————————————
// Every control lives in the header. Hide the optional ones on an article
// whose only missing sections were optional and the old rule found nothing to
// show, so the rail went — taking with it the button that brings them back, on
// the one article where that was the only button you wanted.
function content(name, { rows, aside = 0, optionalShown, worth, shown, need }) {
  const got = M.railContent(rows, aside, optionalShown);
  const problems = [];
  if (worth !== undefined && got.worth !== worth) {
    problems.push(`worth: expected ${worth}, got ${got.worth}`);
  }
  if (shown !== undefined && got.shown.length !== shown) {
    problems.push(`shown: expected ${shown}, got ${got.shown.length}`);
  }
  if (need !== undefined && got.need !== need) {
    problems.push(`need: expected ${need}, got ${got.need}`);
  }
  if (problems.length) {
    failed++;
    console.log(`✗ ${name}`);
    for (const p of problems) console.log(`    ${p}`);
  } else {
    console.log(`✓ ${name}  (worth ${got.worth}, ${got.shown.length} shown, ${got.need} required)`);
  }
}

const REQ = { required: true }, OPT = { required: false };

content('optional hidden, and only optional were missing — the header stays', {
  rows: [OPT, OPT, OPT], optionalShown: false,
  worth: true, shown: 0, need: 0,
});
content('optional showing, only optional missing', {
  rows: [OPT, OPT, OPT], optionalShown: true,
  worth: true, shown: 3, need: 0,
});
content('everything set aside — the header stays, for the undo in it', {
  rows: [], aside: 2, optionalShown: false,
  worth: true, shown: 0, need: 0,
});
content('nothing missing, nothing offered, nothing set aside — silence', {
  rows: [], optionalShown: false,
  worth: false, shown: 0, need: 0,
});
content('required missing, optional hidden', {
  rows: [REQ, REQ, OPT, OPT], optionalShown: false,
  worth: true, shown: 2, need: 2,
});

console.log(failed ? `\n${failed} failed` : '\nall good');
process.exit(failed ? 1 : 0);
