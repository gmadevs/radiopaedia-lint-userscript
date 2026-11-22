#!/usr/bin/env node
/* Writes `article-links.tsv`, the names the Links button looks for.
 *
 *     node tools/article-links.js ~/Downloads/search.csv
 *     node tools/article-links.js ~/Downloads/search.csv --book ../neuropedia/.cache/book.db
 *     node tools/article-links.js a.csv b.csv --book book.db --out article-links.tsv
 *
 * The CSV is Radiopaedia's own search export: Title, URL, Systems, Sections,
 * Date of Last Edit. Several can be given and are merged, so the list can be
 * built one system at a time. Each article becomes one line, under its title
 * and the forms of it that are worth looking for:
 *
 *   - a qualifier in brackets is dropped: "Salt and pepper sign (skull)" is
 *     looked for as "salt and pepper sign";
 *   - an abbreviation in brackets is a name of its own: "Endovascular clot
 *     retrieval (ECR)" is also "ECR", and "Posterior inferior cerebellar
 *     artery (PICA) infarct" is also "PICA infarct";
 *   - a qualifier is not dropped when what is left is another article's title:
 *     "Tuberous sclerosis complex (diagnostic criteria)" is not looked for
 *     as "tuberous sclerosis complex";
 *   - mnemonics, disambiguation pages, summaries, approaches and radiograph
 *     views ("Skull (lateral view)") are left out, because no article should
 *     link to them from a word in its text.
 *
 * `--book` is a local copy of the articles (neuropedia's `book.db`, opened
 * read only). It adds three things the CSV cannot know:
 *
 *   - the slugs that redirect to an article, which count as a link to it;
 *   - the other names articles already use when they link to it — "CSF" for
 *     cerebrospinal fluid — kept when at least three articles use them, three
 *     out of four of the links made with those words go to this article, and
 *     the words are linked at least a fifth of the times they appear;
 *   - for every article, `linked/mentioned`: of the articles that name it,
 *     how many link it. That is what the button uses to set apart the names
 *     that are usually left unlinked ("brain", "white matter").
 *
 * The matcher is read straight out of the userscript, the same way
 * `check-structure.js` reads the structure module, so the counts are made by
 * the code that will use them.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'radiopaedia-lint.user.js');

const START = '  // ————————————————————————————————————————————————————————————— the links\n';
const END = '  // ————————————————————————————————————————————————— the links, in the editor';

function loadMatcher() {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const a = src.indexOf(START), b = src.indexOf(END);
  if (a < 0 || b < 0) throw new Error('the links module is not where it was in the userscript');
  return new Function(src.slice(a, b) + `
    return { linkKey, linkTokens, linkPhrase, parseLinkIndex, linkHits, linkCandidates };`)();
}

// ——————————————————————————————————————————————————————————— the CSV

/* RFC 4180, which is what the export is: quoted fields, doubled quotes. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

const ARTICLE_URL = /radiopaedia\.org\/articles\/([a-z0-9-]+)/;
const LEFT_OUT = /\b(?:mnemonics?|mnenomic|disambiguation)\b|\((?:summary|an approach|approach|[^()]*\bview)\)/i;

function clean(s) {
  return String(s ?? '').replace(/\u00a0/g, ' ').replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
    .replace(/\s+/g, ' ').trim();
}

/* Is the bracket an abbreviation of the words before it? Its first two letters
 * have to start two of those words, in order: "Endovascular clot retrieval
 * (ECR)" and "American Journal of Neuroradiology (AJNR)" yes, "Circumventricular
 * organs (CNS)" and "Angular artery (MCA branch)" no — those brackets say where,
 * not what it is called. */
function abbreviates(before, abbr) {
  const initials = before.split(/[\s-]+/).filter(Boolean).map((w) => w[0].toUpperCase());
  const letters = abbr.replace(/[^A-Za-z]/g, '').toUpperCase();
  if (letters.length < 2) return false;
  const first = initials.indexOf(letters[0]);
  return first >= 0 && initials.indexOf(letters[1], first + 1) > first;
}

const ABBR = /^[A-Z0-9][A-Za-z0-9-]*$/;
const isAbbr = (w) => ABBR.test(w) && (w.match(/[A-Z]/g) || []).length >= 2;

/* The names a title is looked for under, or null for a title that is not
 * linked from running text at all. */
function titleNames(raw) {
  const title = clean(raw);
  if (!title || LEFT_OUT.test(title)) return null;
  const names = [];
  const m = /^(.*?)\s*\(([^()]+)\)\s*(.*)$/.exec(title);
  if (!m) names.push(title);
  else {
    const [, before, inside, after] = m.map(clean);
    const tail = after ? ' ' + after : '';
    if (before) names.push(before + tail);
    // "Interventricular foramen (of Monro)": the bracket is the rest of the name.
    if (/^of\s/i.test(inside)) names.push(`${before} ${inside}${tail}`);
    const firstInside = inside.split(' ')[0];
    if (isAbbr(firstInside) && (after || abbreviates(before, firstInside))) names.push(inside + tail);
  }
  // "Pituitary adenoma/PitNET": either half is the article too.
  for (const name of [...names]) {
    const parts = name.split('/').map(clean);
    if (parts.length === 2 && parts.every((p) => p.length >= 3)) names.push(...parts);
  }
  return [...new Set(names)];
}

function readCsvs(files) {
  const bySlug = new Map();
  for (const file of files) {
    for (const row of parseCsv(fs.readFileSync(file, 'utf8'))) {
      const slug = ARTICLE_URL.exec(row.URL || '')?.[1];
      const title = clean(row.Title);
      if (!slug || !title || bySlug.has(slug)) continue;
      bySlug.set(slug, { slug, title, slugs: [slug], names: titleNames(title) });
    }
  }
  /* A qualifier dropped does not get to take another article's title: once
   * "Tuberous sclerosis complex" is an article, "Tuberous sclerosis complex
   * (diagnostic criteria)" is not looked for under those three words. */
  const lower = (s) => s.toLowerCase();
  const whole = new Set([...bySlug.values()].filter((e) => !e.title.includes('('))
    .map((e) => lower(e.title)));
  for (const e of bySlug.values()) {
    if (!e.names || !e.title.includes('(')) continue;
    e.names = e.names.filter((n) => !whole.has(lower(n)));
  }
  return bySlug;
}

// ——————————————————————————————————————————————————————————— the book

/* `body_md` as blocks of text with the characters that are not running text
 * marked: headings, link text, bold, reference markers. The same cut
 * `linkBlocks` makes in the editor, from Markdown instead of from the DOM. */
const MD_INLINE = /\[([^\]]*)\]\(([^)\s]*)[^)]*\)|\*\*([^*]+)\*\*|\^([^^\s]*)\^|~([^~\s]*)~|\\([*_^~[\]])|[*_]/g;
const MD_LINK = /(?:radiopaedia\.org)?\/articles\/([a-z0-9-]+)/;

function mdBlocks(md) {
  const blocks = [], links = [];
  for (let line of String(md ?? '').split('\n')) {
    if (!line.trim()) continue;
    const heading = /^\s*#/.test(line);
    line = line.replace(/^\s*#+\s*/, '').replace(/^\s*(?:[-*+]|\d+\.)\s+/, '');
    let text = '';
    const out = [];
    const push = (s, isOut) => { text += s; for (let i = 0; i < s.length; i++) out.push(isOut || heading); };
    let last = 0;
    for (const m of line.matchAll(MD_INLINE)) {
      push(line.slice(last, m.index), false);
      if (m[1] !== undefined) {
        const slug = MD_LINK.exec(m[2])?.[1];
        if (slug) links.push({ slug, text: clean(m[1]) });
        push(m[1], true);
      } else if (m[3] !== undefined) push(m[3], true);
      else if (m[4] !== undefined || m[5] !== undefined) push(m[4] ?? m[5], true);
      else if (m[6] !== undefined) push(m[6], false);
      last = m.index + m[0].length;
    }
    push(line.slice(last), false);
    blocks.push({ text, out });
  }
  return { blocks, links };
}

function readBook(file) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  return db.prepare(
    'SELECT slug, title_src AS title, body_md AS md FROM articles WHERE body_md IS NOT NULL').all();
}

// ——————————————————————————————————————————————————————————— the file

const MIN_ARTICLES = 3;     // an alias has to be used by this many articles
const MIN_SHARE = 0.75;     // and this share of the links made with it go here
const MIN_RATE = 0.2;       // and be linked this often where it appears

function indexText(entries) {
  return [...entries.values()].filter((e) => e.names?.length).map((e) =>
    [e.slugs.join(' '), e.title, e.rate ?? '', ...e.names].join('\t')).join('\n');
}

function build(csvFiles, bookFile) {
  const M = loadMatcher();
  const entries = readCsvs(csvFiles);
  if (!bookFile) return { entries, M, measured: false };

  const book = readBook(bookFile).map((a) => ({ ...a, ...mdBlocks(a.md) }));

  // Redirects: the book follows them, so several slugs share one title.
  const byTitle = new Map();
  for (const a of book) {
    const t = clean(a.title).toLowerCase();
    if (!byTitle.has(t)) byTitle.set(t, []);
    byTitle.get(t).push(a.slug);
  }
  const canonical = new Map();
  for (const e of entries.values()) {
    for (const s of byTitle.get(e.title.toLowerCase()) || []) {
      if (!e.slugs.includes(s) && !entries.has(s)) e.slugs.push(s);
    }
    for (const s of e.slugs) canonical.set(s, e);
  }

  // The words articles link with, per target.
  const keyOf = (text) => M.linkPhrase(text)?.keys.join('\u0001');
  const anchors = new Map();         // key → { total, per: Map(entry → { n, arts:Set, forms }) }
  for (const a of book) {
    for (const l of a.links) {
      const k = keyOf(l.text);
      if (!k) continue;
      if (!anchors.has(k)) anchors.set(k, { total: 0, per: new Map() });
      const slot = anchors.get(k);
      slot.total++;
      const e = canonical.get(l.slug) || l.slug;    // a target outside the CSV still counts as "elsewhere"
      if (!slot.per.has(e)) slot.per.set(e, { n: 0, arts: new Set(), forms: new Map() });
      const p = slot.per.get(e);
      p.n++; p.arts.add(a.slug);
      p.forms.set(l.text, (p.forms.get(l.text) || 0) + 1);
    }
  }

  const titleKeys = new Map();
  for (const e of entries.values()) for (const n of e.names || []) titleKeys.set(keyOf(n), e);

  const PLAIN = /^[\p{L}\p{N}][\p{L}\p{N}\s'’\-,/]*$/u;
  for (const [k, slot] of anchors) {
    for (const [e, p] of slot.per) {
      if (typeof e === 'string' || !e.names) continue;
      if (p.arts.size < MIN_ARTICLES || p.n / slot.total < MIN_SHARE) continue;
      if (titleKeys.has(k)) continue;                      // somebody's own name already
      const form = [...p.forms].sort((x, y) => y[1] - x[1])[0][0];
      if (!PLAIN.test(form) || form.length < 3 || /^\d+$/.test(form)) continue;
      if (/^[IVX]+$/.test(form)) continue;                 // "VII" is also factor VII
      if (M.linkTokens(form).length > 8) continue;
      e.aliases = e.aliases || new Set();
      e.aliases.add(/\p{Lu}{2}/u.test(form) ? form : form.toLowerCase());
    }
  }
  for (const e of entries.values()) if (e.aliases) e.names.push(...e.aliases);

  // Measure: where each name appears in running text, and who links what.
  const index = M.parseLinkIndex(indexText(entries));
  const plain = new Map();      // phrase → Set of articles naming it unlinked
  const linking = new Map();    // entry → Set of articles linking it
  const viaAnchor = new Map();  // phrase → Set of articles linking it with these words
  const phraseOf = new Map();
  for (const ix of new Set(index.entries.values())) {
    for (const p of ix.phrases) phraseOf.set(ix.slug + '\u0002' + p.keys.join('\u0001'), p);
  }
  for (const a of book) {
    const self = canonical.get(a.slug);
    for (const l of a.links) {
      const e = canonical.get(l.slug);
      if (!e || e === self) continue;
      const ix = index.entries.get(e.slug);
      if (!ix) continue;
      if (!linking.has(ix)) linking.set(ix, new Set());
      linking.get(ix).add(a.slug);
      const p = phraseOf.get(ix.slug + '\u0002' + keyOf(l.text));
      if (p) {
        if (!viaAnchor.has(p)) viaAnchor.set(p, new Set());
        viaAnchor.get(p).add(a.slug);
      }
    }
    for (const hit of M.linkHits(a.blocks, index)) {
      for (const p of hit.phrases) {
        if (self && p.entry.slug === self.slug) continue;
        if (!plain.has(p)) plain.set(p, new Set());
        plain.get(p).add(a.slug);
      }
    }
  }

  // Aliases that are mostly left unlinked are dropped: "internal" links to
  // the internal carotid artery nineteen times, in a thousand articles.
  const rate = (p) => {
    const l = viaAnchor.get(p)?.size || 0;
    const all = new Set([...(viaAnchor.get(p) || []), ...(plain.get(p) || [])]).size;
    return all ? l / all : 0;
  };
  for (const e of entries.values()) {
    const ix = index.entries.get(e.slug);
    if (!ix) continue;
    const keep = new Set(ix.phrases.filter((p) =>
      !e.aliases?.has(p.text) || rate(p) >= MIN_RATE).map((p) => p.text));
    e.names = e.names.filter((n) => keep.has(n));
    const linked = linking.get(ix) || new Set();
    const named = new Set(linked);
    for (const p of ix.phrases) if (keep.has(p.text)) for (const s of plain.get(p) || []) named.add(s);
    e.rate = `${linked.size}/${named.size}`;
  }
  return { entries, M, measured: true, books: book.length };
}

function main(argv) {
  const csvs = [];
  let book = null, out = path.join(ROOT, 'article-links.tsv');
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--book') book = argv[++i];
    else if (argv[i] === '--out') out = argv[++i];
    else csvs.push(argv[i]);
  }
  if (!csvs.length) {
    console.error('usage: node tools/article-links.js export.csv [more.csv …] [--book book.db] [--out file]');
    return 2;
  }
  const { entries, measured, books } = build(csvs, book);
  const kept = [...entries.values()].filter((e) => e.names?.length)
    .sort((a, b) => a.title.localeCompare(b.title, 'en'));
  const head = [
    '# The names the Links button looks for in the editor. Written by tools/article-links.js;',
    '# edit by hand if you like, but a re-run will write over it.',
    '#',
    `# ${kept.length} articles, from ${csvs.map((f) => path.basename(f)).join(', ')}` +
      (measured ? `, measured against ${books} articles of ${path.basename(book)}` : '') + '.',
    '#',
    '# slug[ redirect …] <TAB> title <TAB> linked/mentioned <TAB> name <TAB> name …',
  ];
  const body = kept.map((e) => [e.slugs.join(' '), e.title, e.rate ?? '', ...e.names].join('\t'));
  fs.writeFileSync(out, head.concat(body).join('\n') + '\n');
  const left = [...entries.values()].length - kept.length;
  console.log(`${out}: ${kept.length} articles (${left} left out: mnemonics, disambiguation pages, summaries, approaches, radiograph views, and titles whose only name is another article's)`);
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { build, titleNames, mdBlocks, parseCsv, loadMatcher };
