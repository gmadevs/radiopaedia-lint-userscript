#!/usr/bin/env node
/* Runs the links matcher on sentences written to catch what it must get right.
 *
 *     node tools/check-links.js
 *
 * The matcher is read out of the userscript, the way `check-structure.js`
 * reads the structure module, and given a small index written here rather
 * than `article-links.tsv`: what is being pinned down is the matching, not
 * which articles happen to be in the file this week.
 */

const { loadMatcher } = require('./article-links.js');
const M = loadMatcher();

const INDEX = [
  'abducens-nerve\tAbducens nerve\t10/12\tAbducens nerve',
  'abducens-nerve-palsy-1\tAbducens nerve palsy\t5/6\tAbducens nerve palsy',
  'cerebrospinal-fluid-1\tCerebrospinal fluid\t214/519\tCerebrospinal fluid\tCSF',
  'meningioma\tMeningioma\t196/219\tMeningioma',
  'vasogenic-cerebral-edema\tVasogenic cerebral edema\t9/10\tVasogenic cerebral edema',
  'thalamus\tThalamus\t157/229\tThalamus',
  'glioblastoma-idh-wildtype glioblastoma\tGlioblastoma, IDH-wildtype\t95/104\tGlioblastoma, IDH-wildtype\tglioblastoma',
  'wernicke-encephalopathy\tWernicke encephalopathy\t30/31\tWernicke encephalopathy',
  't2-weighted-image\tT2 weighted image\t3/9\tT2 weighted image',
  'fornix-brain\tFornix (brain)\t26/46\tFornix',
  'fornix-vagina\tFornix (vagina)\t1/2\tFornix',
  'brain\tBrain\t72/1021\tBrain',
].join('\n');

const index = M.parseLinkIndex(INDEX);

/* One block, with `[…]` marking text that is not running text (a link, bold,
 * a reference marker) — the brackets themselves are taken out. */
function block(src) {
  let text = '', out = [], inside = false;
  for (const ch of src) {
    if (ch === '[') { inside = true; continue; }
    if (ch === ']') { inside = false; continue; }
    text += ch;
    out.push(inside);
  }
  return { text, out };
}

function offered(paragraphs, opts) {
  return M.linkCandidates(paragraphs.map(block), index, opts)
    .map((c) => `${c.words} → ${c.entry.slug}` + (c.others.length ? ` (or ${c.others.map((o) => o.slug).join(', ')})` : ''));
}

const cases = [
  ['the longest name wins, and the shorter inside it is used up',
    ['Abducens nerve palsy follows a lesion of the abducens nerve.'], {},
    ['Abducens nerve palsy → abducens-nerve-palsy-1', 'abducens nerve → abducens-nerve']],
  ['only the first occurrence is offered',
    ['A meningioma is common.', 'Meningiomas enhance; the meningioma here did not.'], {},
    ['meningioma → meningioma']],
  ['plural, in the first place it occurs',
    ['Multiple meningiomas were seen, and one meningioma.'], {},
    ['meningiomas → meningioma']],
  ['linked anywhere means not offered, even further down',
    ['CSF was clear.', 'The [cerebrospinal fluid] pressure was normal.'],
    { linked: new Set(['cerebrospinal-fluid-1']) }, []],
  ['a redirect counts as linked',
    ['Glioblastoma is the commonest.'],
    { linked: new Set(['glioblastoma']) }, []],
  ['the article itself is not offered',
    ['A meningioma again.'], { self: 'meningioma' }, []],
  ['one word of a three-word name is not the name',
    ['There was vasogenic oedema around it.'], {},
    []],
  ['British spelling, whole name',
    ['There was vasogenic cerebral oedema around it.'], {},
    ['vasogenic cerebral oedema → vasogenic-cerebral-edema']],
  ['Latin plural',
    ['Both thalami were bright.'], {},
    ['thalami → thalamus']],
  ['an abbreviation keeps its case',
    ['The csf was clear, then the CSF was sampled.'], {},
    ['CSF → cerebrospinal-fluid-1']],
  ['a comma in the name has to be in the text',
    ['A glioblastoma, IDH-wildtype, in the temporal lobe.'], {},
    ['glioblastoma, IDH-wildtype → glioblastoma-idh-wildtype']],
  ['a hyphen and a space are the same',
    ['On the T2-weighted image it was bright.'], {},
    ['T2-weighted image → t2-weighted-image']],
  ['possessive eponym',
    ["Wernicke's encephalopathy was suspected."], {},
    ["Wernicke's encephalopathy → wernicke-encephalopathy"]],
  ['bold, links and markers are not running text',
    ['[Meningioma] is the subject; it compresses the [abducens nerve] and the brain.'], {},
    ['brain → brain']],
  ['two articles with one name: the alternative is offered too',
    ['The fornix was thin.'], {},
    ['fornix → fornix-brain (or fornix-vagina)']],
  ['set aside',
    ['The fornix was thin.'], { skip: new Set(['fornix-brain']) }, []],
  ['never across two blocks',
    ['Abducens', 'nerve palsy'], {}, []],
];

let failed = 0;
for (const [name, paragraphs, opts, want] of cases) {
  const got = offered(paragraphs, opts);
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n      want ${JSON.stringify(want)}\n      got  ${JSON.stringify(got)}`}`);
}
console.log(failed ? `\n${failed} of ${cases.length} failed` : `\nall ${cases.length} passed`);
process.exit(failed ? 1 : 0);
