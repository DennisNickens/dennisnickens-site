#!/usr/bin/env node
// scripts/regenerate-question-map.js
//
// Re-parses the live SR Full Assessment survey from GHL and rewrites
// lib/question-map.js so the scoring transformer stays in sync as questions
// are added, removed, or reworded.
//
// Run: npm run regenerate-question-map
//
// Env vars:
//   GHL_SURVEY_PUBLIC_URL  Optional. The public widget URL for the survey.
//                          Falls back to the SR Full Assessment URL below.
//
// What this preserves and what it regenerates:
//   - Regenerates QUESTION_MAP (the GHL-field-ID -> {qnum, options} table).
//     This is the part that drifts when Cassandra adjusts the survey.
//   - Keeps PILLAR_BINS, PERSONALITY_QUESTION_INFO, FAITH_ORIENTATION_LABELS
//     constant. Those are SR design canon, not surveyed.
//
// Diff output: prints which questions were added, removed, or changed.

const fs = require('fs');
const path = require('path');

const DEFAULT_SURVEY_URL =
  'https://api.leadconnectorhq.com/widget/survey/E8iUexhy9T4qKYMylUPb';
const OUTPUT_PATH = path.join(__dirname, '..', 'lib', 'question-map.js');

// =======================================================================
// CANON (constants that are NOT regenerated from the survey)
// =======================================================================

const PILLAR_BINS = {
  behaviorProfile:    [ 1,  24],
  personalityCode:    [25,  52],
  actionStyle:        [53,  72],
  connectionCurrency: [73,  92],
  learningChannel:    [93, 108],
  spiritualCompass:   [109, 120],
};

const PERSONALITY_QUESTION_INFO = {
  25: { dichotomy: 'ei', tags: ['O', 'W'] },
  26: { dichotomy: 'sn', tags: ['T', 'V'] },
  27: { dichotomy: 'tf', tags: ['M', 'H'] },
  28: { dichotomy: 'jp', tags: ['P', 'F'] },
  29: { dichotomy: 'ei', tags: ['O', 'W'] },
  30: { dichotomy: 'sn', tags: ['T', 'V'] },
  31: { dichotomy: 'tf', tags: ['M', 'H'] },
  32: { dichotomy: 'jp', tags: ['P', 'F'] },
  33: { dichotomy: 'ei', tags: ['O', 'W'] },
  34: { dichotomy: 'sn', tags: ['T', 'V'] },
  35: { dichotomy: 'tf', tags: ['M', 'H'] },
  36: { dichotomy: 'jp', tags: ['P', 'F'] },
  37: { dichotomy: 'ei', tags: ['O', 'W'] },
  38: { dichotomy: 'sn', tags: ['T', 'V'] },
  39: { dichotomy: 'tf', tags: ['M', 'H'] },
  40: { dichotomy: 'jp', tags: ['P', 'F'] },
  41: { dichotomy: 'ei', tags: ['W', 'O'] },
  42: { dichotomy: 'sn', tags: ['T', 'V'] },
  43: { dichotomy: 'tf', tags: ['M', 'H'] },
  44: { dichotomy: 'jp', tags: ['P', 'F'] },
  45: { dichotomy: 'ei', tags: ['O', 'W'] },
  46: { dichotomy: 'sn', tags: ['T', 'V'] },
  47: { dichotomy: 'tf', tags: ['M', 'H'] },
  48: { dichotomy: 'jp', tags: ['P', 'F'] },
  49: { dichotomy: 'ei', tags: ['O', 'W'] },
  50: { dichotomy: 'sn', tags: ['T', 'V'] },
  51: { dichotomy: 'tf', tags: ['M', 'H'] },
  52: { dichotomy: 'jp', tags: ['P', 'F'] },
};

const FAITH_ORIENTATION_LABELS = [
  'Christian (any tradition)',
  'Spiritual but not specifically religious',
  'Other major faith tradition',
  'Secular but open',
  'Still figuring out',
];

// =======================================================================
// FETCH + PARSE
// =======================================================================

async function fetchSurveyHtml(url) {
  // Node 18+ has global fetch.
  const res = await fetch(url, {
    headers: { 'user-agent': 'sr-question-map-regen/1.0' },
  });
  if (!res.ok) {
    throw new Error(`Survey fetch failed: ${res.status} ${res.statusText}`);
  }
  return res.text();
}

// Extract the NUXT_DATA payload script from the HTML.
function extractNuxtData(html) {
  const m = html.match(/NUXT_DATA__"[^>]*>(\[[\s\S]*?\])<\/script>/);
  if (!m) {
    throw new Error('Could not locate Nuxt data blob in survey HTML.');
  }
  return JSON.parse(m[1]);
}

// Dereference Nuxt's index-pool serialization. Each integer value is a
// reference into the top-level data array. The pool reuses string indices
// aggressively, so a naive recursive walk inflates exponentially. We
// memoize per-index and short-circuit on already-seen references so the
// expansion stays bounded by pool length, not the (much larger) inflated
// tree size.
function makeDeref(pool) {
  const cache = new Map(); // index -> expanded value
  const visiting = new Set(); // indices on the current path

  function expandIndex(i) {
    if (cache.has(i)) return cache.get(i);
    if (visiting.has(i)) return null; // cycle, return null to break it
    visiting.add(i);
    const out = walk(pool[i]);
    visiting.delete(i);
    cache.set(i, out);
    return out;
  }

  function walk(node) {
    if (typeof node === 'number' && Number.isInteger(node) && node >= 0 && node < pool.length) {
      return expandIndex(node);
    }
    if (Array.isArray(node)) {
      return node.map(walk);
    }
    if (node && typeof node === 'object') {
      const out = {};
      for (const k of Object.keys(node)) {
        out[k] = walk(node[k]);
      }
      return out;
    }
    return node;
  }

  // Public entry: deref(n) returns the fully (memoized) expanded value at
  // pool index n, or the literal if n is not an index.
  return function deref(n) {
    if (typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < pool.length) {
      return expandIndex(n);
    }
    return walk(n);
  };
}

// Walk the survey state and pull out every question field.
function extractQuestions(pool) {
  const deref = makeDeref(pool);
  // Root: data[0] -> ['ShallowReactive', 1]; walk surveyData.formData.slides
  let root;
  try {
    root = deref(0);
  } catch (e) {
    throw new Error('Failed to dereference Nuxt pool: ' + e.message);
  }
  // Defensive: the wrapper shape can vary across Nuxt versions
  function findSlides(node) {
    if (!node) return null;
    if (Array.isArray(node)) {
      for (const x of node) {
        const r = findSlides(x);
        if (r) return r;
      }
      return null;
    }
    if (typeof node !== 'object') return null;
    if (Array.isArray(node.slides) && node.slides.length && node.slides.every(
      (s) => s && (Array.isArray(s.slideData) || s.slideName !== undefined)
    )) {
      return node.slides;
    }
    for (const k of Object.keys(node)) {
      const r = findSlides(node[k]);
      if (r) return r;
    }
    return null;
  }

  const slides = findSlides(root);
  if (!slides) {
    throw new Error('Could not locate slides in dereferenced data.');
  }

  const questions = [];
  for (const slide of slides) {
    const slideName = slide.slideName || '';
    const fields = Array.isArray(slide.slideData) ? slide.slideData : [];
    for (const f of fields) {
      if (!f || typeof f !== 'object') continue;
      const fieldId = f.id || f.tag;
      const sr = f.hiddenFieldQueryKey;
      const opts = f.picklistOptions;
      // Only keep picklist-style questions that carry an sr_qN or
      // srConditional_* key. Skip headers, system fields, dividers.
      if (!fieldId || !sr) continue;
      if (!Array.isArray(opts) || opts.length === 0) continue;
      const isSrQ = /^sr_q\d+$/.test(sr);
      const isConditional = /^srConditional_Q[A-I]\d+$/.test(sr);
      if (!isSrQ && !isConditional) continue;
      questions.push({
        fieldId,
        srKey: sr,
        qnum: isSrQ ? parseInt(sr.slice(4), 10) : null,
        conditionalKey: isConditional ? sr : null,
        text: f.label || f.customFieldLabel || '',
        options: opts.slice(),
        slideName,
      });
    }
  }
  return questions;
}

// =======================================================================
// DIFF AGAINST EXISTING MAP
// =======================================================================

function loadExistingMap() {
  // Clear require cache so we get a fresh read even if invoked twice.
  try {
    const target = require.resolve('../lib/question-map.js');
    delete require.cache[target];
    return require('../lib/question-map.js');
  } catch (e) {
    return null;
  }
}

function diffMaps(oldMap, newMap) {
  const oldIds = new Set(Object.keys(oldMap || {}));
  const newIds = new Set(Object.keys(newMap));
  const added = [...newIds].filter((id) => !oldIds.has(id));
  const removed = [...oldIds].filter((id) => !newIds.has(id));
  const changed = [];
  for (const id of newIds) {
    if (!oldIds.has(id)) continue;
    const a = oldMap[id], b = newMap[id];
    if (!a || !b) continue;
    const optsDiffer =
      !Array.isArray(a.options) ||
      !Array.isArray(b.options) ||
      a.options.length !== b.options.length ||
      a.options.some((v, i) => v !== b.options[i]);
    const qnumDiffer = a.qnum !== b.qnum;
    if (optsDiffer || qnumDiffer) {
      changed.push({ id, qnum: b.qnum, oldOptions: a.options, newOptions: b.options, oldQnum: a.qnum });
    }
  }
  return { added, removed, changed };
}

// =======================================================================
// FORMAT OUTPUT
// =======================================================================

function escapeJsString(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
}

function renderQuestionMap(questions, sourceUrl) {
  // Group: sr_qN questions go in QUESTION_MAP (by GHL field ID). Conditional
  // questions are also dropped in but keyed by their conditional key, since
  // the scoring engine routes them separately by field-name pattern.
  const sortedSrQs = questions
    .filter((q) => q.qnum !== null)
    .sort((a, b) => a.qnum - b.qnum);
  const conditionals = questions
    .filter((q) => q.conditionalKey)
    .sort((a, b) => a.conditionalKey.localeCompare(b.conditionalKey));

  const date = new Date().toISOString();
  const lines = [];
  lines.push('// /lib/question-map.js');
  lines.push('// AUTO-GENERATED by scripts/regenerate-question-map.js');
  lines.push(`// Regenerated: ${date}`);
  lines.push(`// Source: ${sourceUrl}`);
  lines.push('//');
  lines.push('// Maps each GHL custom field ID to its question position (sr_qN) and ordered');
  lines.push('// picklist options. The scoring layer uses the option index to determine the');
  lines.push('// tag for that answer. To refresh after the survey changes in GHL, run:');
  lines.push('//   npm run regenerate-question-map');
  lines.push('');
  lines.push('module.exports = {');
  lines.push('  QUESTION_MAP: {');
  for (const q of sortedSrQs) {
    const text = escapeJsString(q.text);
    const opts = q.options.map((o) => `"${escapeJsString(o)}"`).join(', ');
    lines.push(`    // Q${String(q.qnum).padStart(3, ' ')}: ${q.text.replace(/\n/g, ' ').slice(0, 200)}`);
    lines.push(`    "${q.fieldId}": { qnum: ${q.qnum}, options: [${opts}] },`);
  }
  if (conditionals.length) {
    lines.push('');
    lines.push('    // --- Conditional questions (Sets A, B, C, D, E, F, G) ---');
    for (const q of conditionals) {
      const opts = q.options.map((o) => `"${escapeJsString(o)}"`).join(', ');
      lines.push(`    // ${q.conditionalKey}: ${q.text.replace(/\n/g, ' ').slice(0, 200)}`);
      lines.push(`    "${q.fieldId}": { conditionalKey: "${q.conditionalKey}", options: [${opts}] },`);
    }
  }
  lines.push('  },');
  lines.push('');
  lines.push('  // Question number to pillar lookup.');
  lines.push('  PILLAR_BINS: {');
  for (const [k, v] of Object.entries(PILLAR_BINS)) {
    lines.push(`    ${k.padEnd(18)}: [${String(v[0]).padStart(3, ' ')}, ${String(v[1]).padStart(3, ' ')}],`);
  }
  lines.push('  },');
  lines.push('');
  lines.push('  // Pillar 2 (Personality Code): for each question, which dichotomy slot it belongs');
  lines.push('  // to and the SR letter at option position 0 and 1.');
  lines.push('  // Dichotomy slot keys are legacy (ei/sn/tf/jp) and never customer facing.');
  lines.push('  // Letters map to the SR system:');
  lines.push('  //   ei -> Charge: O (Outward) vs W (Inward)');
  lines.push('  //   sn -> Trust:  T (Tangible) vs V (Vision)');
  lines.push('  //   tf -> Decide: M (Mind)     vs H (Heart)');
  lines.push('  //   jp -> Live:   P (Plan)     vs F (Flow)');
  lines.push('  PERSONALITY_QUESTION_INFO: {');
  for (const k of Object.keys(PERSONALITY_QUESTION_INFO).sort((a, b) => Number(a) - Number(b))) {
    const v = PERSONALITY_QUESTION_INFO[k];
    lines.push(`    ${k}: { dichotomy: "${v.dichotomy}", tags: ["${v.tags[0]}", "${v.tags[1]}"] },`);
  }
  lines.push('  },');
  lines.push('');
  lines.push('  // Pillar 6 Q109 faith orientation: ordered short labels by option position.');
  lines.push('  FAITH_ORIENTATION_LABELS: [');
  for (const l of FAITH_ORIENTATION_LABELS) {
    lines.push(`    "${escapeJsString(l)}",`);
  }
  lines.push('  ],');
  lines.push('};');
  lines.push('');
  return lines.join('\n');
}

// =======================================================================
// SUMMARY HELPERS
// =======================================================================

function printSummary(questions, diff) {
  const srOnly = questions.filter((q) => q.qnum !== null);
  const conds = questions.filter((q) => q.conditionalKey);
  const qnums = srOnly.map((q) => q.qnum).sort((a, b) => a - b);
  const minQ = qnums[0];
  const maxQ = qnums[qnums.length - 1];
  const present = new Set(qnums);
  const expected = [];
  for (let i = 1; i <= maxQ; i++) if (!present.has(i)) expected.push(i);

  console.log('');
  console.log('=== Regeneration Summary ===');
  console.log(`Total picklist questions parsed: ${questions.length}`);
  console.log(`  sr_qN base questions: ${srOnly.length} (range ${minQ}..${maxQ})`);
  console.log(`  srConditional_QxN:    ${conds.length}`);
  if (expected.length) {
    console.log(`  GAPS in sr_qN range: missing ${expected.join(', ')}`);
  } else {
    console.log('  GAPS in sr_qN range: none');
  }

  const condBySet = {};
  for (const c of conds) {
    const set = c.conditionalKey.slice('srConditional_Q'.length, 'srConditional_Q'.length + 1);
    condBySet[set] = (condBySet[set] || 0) + 1;
  }
  if (Object.keys(condBySet).length) {
    console.log('  Conditional counts by set: ' +
      Object.keys(condBySet).sort().map((k) => `${k}=${condBySet[k]}`).join(', '));
  }

  console.log('');
  console.log('=== Diff vs Existing question-map.js ===');
  if (!diff) {
    console.log('No existing map found; writing fresh.');
    return;
  }
  console.log(`Added:   ${diff.added.length}`);
  for (const id of diff.added) console.log(`  + ${id}`);
  console.log(`Removed: ${diff.removed.length}`);
  for (const id of diff.removed) console.log(`  - ${id}`);
  console.log(`Changed: ${diff.changed.length}`);
  for (const c of diff.changed) {
    console.log(`  ~ ${c.id} (qnum ${c.oldQnum} -> ${c.qnum})`);
    if (Array.isArray(c.oldOptions) && Array.isArray(c.newOptions)) {
      const max = Math.max(c.oldOptions.length, c.newOptions.length);
      for (let i = 0; i < max; i++) {
        const a = c.oldOptions[i];
        const b = c.newOptions[i];
        if (a !== b) {
          console.log(`      [${i}] old: ${JSON.stringify(a)}`);
          console.log(`      [${i}] new: ${JSON.stringify(b)}`);
        }
      }
    }
  }
}

// =======================================================================
// MAIN
// =======================================================================

async function main() {
  const url = process.env.GHL_SURVEY_PUBLIC_URL || DEFAULT_SURVEY_URL;
  const writeFlag = !process.argv.includes('--dry-run');

  console.log(`Fetching survey HTML from ${url} ...`);
  const html = await fetchSurveyHtml(url);
  console.log(`Received ${html.length} bytes.`);

  console.log('Parsing Nuxt state ...');
  const pool = extractNuxtData(html);
  console.log(`Pool entries: ${pool.length}`);

  console.log('Extracting questions ...');
  const questions = extractQuestions(pool);
  console.log(`Found ${questions.length} questions.`);

  if (questions.length === 0) {
    throw new Error('No questions parsed. Refusing to overwrite question-map.js.');
  }

  // Build the new in-memory map (sr_qN entries only; same shape scoring.js
  // currently reads).
  const newMap = {};
  for (const q of questions) {
    if (q.qnum !== null) {
      newMap[q.fieldId] = { qnum: q.qnum, options: q.options };
    }
  }

  const existing = loadExistingMap();
  const diff = existing && existing.QUESTION_MAP
    ? diffMaps(existing.QUESTION_MAP, newMap)
    : null;

  printSummary(questions, diff);

  const out = renderQuestionMap(questions, url);

  if (!writeFlag) {
    console.log('');
    console.log('--dry-run: not writing to disk.');
    return;
  }

  fs.writeFileSync(OUTPUT_PATH, out, 'utf8');
  console.log('');
  console.log(`Wrote ${OUTPUT_PATH}`);
  console.log('Done.');
}

main().catch((err) => {
  console.error('FATAL:', err && err.stack ? err.stack : err);
  process.exit(1);
});
