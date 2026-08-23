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
    const currentSlug = () => 'test-article';
    const inEditor = () => false;
    const visibleTitle = () => null;
    let railToggle = null;
  `;
  const expose = `
    return { compile, profileFor, whatIsMissing, anchorFor, canonicalHeading,
             setCanon: (c) => { CANON = c; } };
  `;
  const M = new Function(stubs + src.slice(a, b) + expose)();
  M.setCanon(M.compile(JSON.parse(fs.readFileSync(CANON, 'utf8'))));
  return M;
}

const M = load();

/* Headings as the page hands them over: a level and a title, in document
 * order. The parent is worked out the same way `sectionsOnPage` works it out. */
function page(list) {
  const found = [], stack = [];
  for (const [level, title] of list) {
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    found.push({ el: { tag: title }, level, title,
                 parent: stack.length ? stack[stack.length - 1].title : null });
    stack.push({ level, title });
  }
  return found;
}

let failed = 0;

function check(name, { title, type, headings = [], profile, missing, anchors }) {
  const found = page(headings);
  const got = M.profileFor(title, type);
  const { rows, seen, canonName } = M.whatIsMissing(got, found);
  const names = rows.map((r) => r.title);
  const problems = [];

  if (profile && got !== profile) problems.push(`profile: expected ${profile}, got ${got}`);
  if (missing && names.join(' · ') !== missing.join(' · ')) {
    problems.push(`missing: expected [${missing.join(', ')}], got [${names.join(', ')}]`);
  }
  if (anchors) {
    for (const [heading, where] of Object.entries(anchors)) {
      const row = rows.find((r) => r.title === heading);
      if (!row) { problems.push(`anchor: ${heading} is not among the missing`); continue; }
      const el = M.anchorFor(row, seen, canonName);
      const got = el ? el.tag : null;
      if (got !== where) problems.push(`anchor: ${heading} → expected ${where}, got ${got}`);
    }
  }

  if (problems.length) {
    failed++;
    console.log(`✗ ${name}`);
    for (const p of problems) console.log(`    ${p}`);
  } else {
    console.log(`✓ ${name}  (${got}${names.length ? ' — missing ' + names.join(', ') : ''})`);
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
             '‹any imaging modality›': 'Radiographic features',
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

console.log(failed ? `\n${failed} failed` : '\nall good');
process.exit(failed ? 1 : 0);
