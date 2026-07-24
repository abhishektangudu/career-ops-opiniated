/**
 * generate-tailored-cv.test.mjs — unit tests for capExperienceBullets()
 *
 * The per-role bullet budget must be enforced deterministically in code, not
 * left to the LLM. These tests build EXPERIENCE HTML in the exact shape the
 * prompt specifies (`<div class="job"> … <ul><li>…</li></ul></div>`) and assert
 * the cap holds regardless of how many bullets the model returned.
 *
 * Run: node generate-tailored-cv.test.mjs
 */

import { capExperienceBullets } from './generate-tailored-cv.mjs';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Build a job block with `n` bullets. */
function job(company, n) {
  const lis = Array.from({ length: n }, (_, i) => `        <li>${company} bullet ${i + 1}</li>`).join('\n');
  return `  <div class="job">
    <div class="job-header">
      <span class="job-company">${company}</span>
      <span class="job-period">2020 – Present</span>
    </div>
    <div class="job-role">Some Role</div>
    <ul>
${lis}
    </ul>
  </div>`;
}

/**
 * Count <li> per job block, in order. Splits the HTML on job-wrapper opening
 * tags (tolerant of attribute/quote/whitespace variation) so it can measure
 * markup the strict shape helper `job()` doesn't produce (multiple <ul>,
 * missing </div>, extra attributes, no-<ul> roles).
 */
function bulletCounts(html) {
  const re = /<div\b[^>]*\bclass\s*=\s*(?:(["'])(?:[^"']*\s)?job(?:\s[^"']*)?\1|job(?=[\s>]))[^>]*>/gi;
  const starts = [];
  let m;
  while ((m = re.exec(html)) !== null) starts.push(m.index);
  return starts.map((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : html.length;
    return (html.slice(start, end).match(/<li\b/gi) || []).length;
  });
}

console.log('capExperienceBullets — deterministic per-role bullet budget');

// Enterprise defaults: 2 recent roles max 6, older roles max 4.
{
  const html = [job('Albertsons', 9), job('Ampion', 7), job('CodeScience', 7), job('P2P-SF', 6), job('P2P-GO', 7)].join('\n');
  const out = capExperienceBullets(html); // enterprise defaults
  const counts = bulletCounts(out);
  check('enterprise: two recent roles capped at 6', counts[0] === 6 && counts[1] === 6, JSON.stringify(counts));
  check('enterprise: older roles capped at 4', counts[2] === 4 && counts[3] === 4 && counts[4] === 4, JSON.stringify(counts));
}

// Roles already under the cap are untouched.
{
  const html = [job('A', 5), job('B', 3), job('C', 2)].join('\n');
  const out = capExperienceBullets(html);
  const counts = bulletCounts(out);
  check('under-cap roles are left unchanged', counts[0] === 5 && counts[1] === 3 && counts[2] === 2, JSON.stringify(counts));
}

// One-page style: every role capped at 3 (recentRoleCount: Infinity).
{
  const html = [job('A', 8), job('B', 5), job('C', 4)].join('\n');
  const out = capExperienceBullets(html, { recentMax: 3, olderMax: 3, minBullets: 2, recentRoleCount: Infinity });
  const counts = bulletCounts(out);
  check('one-page: every role capped at 3', counts.every((c) => c === 3), JSON.stringify(counts));
}

// minBullets floor: a role must never be trimmed below the floor even if cap < floor.
{
  const html = [job('A', 5)].join('\n');
  const out = capExperienceBullets(html, { recentMax: 1, olderMax: 1, minBullets: 2, recentRoleCount: 2 });
  const counts = bulletCounts(out);
  check('minBullets floor respected (cap below floor)', counts[0] === 2, JSON.stringify(counts));
}

// Kept bullets are the FIRST ones (highest priority ordered first by the LLM).
{
  const html = job('Albertsons', 9);
  const out = capExperienceBullets(html);
  check('keeps the first N bullets (priority order)', out.includes('Albertsons bullet 1') && out.includes('Albertsons bullet 6'), 'first six kept');
  check('drops the over-cap tail bullets', !out.includes('Albertsons bullet 7') && !out.includes('Albertsons bullet 9'), 'seventh+ dropped');
}

// Robustness: non-string / no-bullet input returns unchanged.
{
  check('empty string returned as-is', capExperienceBullets('') === '');
  check('null returned as-is', capExperienceBullets(null) === null);
  const noBullets = '<div class="job"><div class="job-role">R</div></div>';
  check('job with no <ul> left untouched', capExperienceBullets(noBullets) === noBullets);
}

// Trimming one role must not affect a sibling role's bullets.
{
  const html = [job('First', 9), job('Second', 3)].join('\n');
  const out = capExperienceBullets(html);
  const counts = bulletCounts(out);
  check('sibling role untouched while another is trimmed', counts[0] === 6 && counts[1] === 3, JSON.stringify(counts));
}

// --- Robustness to LLM markup variation (the reviewer's Medium finding) ---

// Extra whitespace in the wrapper opening tag: `<div  class="job">`.
{
  const html = job('A', 9).replace('<div class="job">', '<div  class="job">');
  const out = capExperienceBullets(html);
  check('wrapper with extra whitespace is still capped', bulletCounts(out)[0] === 6, JSON.stringify(bulletCounts(out)));
}

// Extra attribute on the wrapper: `<div class="job" data-id="1">`.
{
  const html = job('A', 9).replace('<div class="job">', '<div class="job" data-id="1">');
  const out = capExperienceBullets(html);
  check('wrapper with extra attribute is still capped', bulletCounts(out)[0] === 6, JSON.stringify(bulletCounts(out)));
}

// Single-quoted class attribute: `<div class='job'>`.
{
  const html = job('A', 9).replace('<div class="job">', "<div class='job'>");
  const out = capExperienceBullets(html);
  check("wrapper with single-quoted class is still capped", bulletCounts(out)[0] === 6, JSON.stringify(bulletCounts(out)));
}

// Multiple <ul> lists inside one job: bullets are capped by TOTAL count.
{
  const html = `  <div class="job">
    <div class="job-role">Split Role</div>
    <ul>
      <li>b1</li>
      <li>b2</li>
      <li>b3</li>
      <li>b4</li>
    </ul>
    <ul>
      <li>b5</li>
      <li>b6</li>
      <li>b7</li>
      <li>b8</li>
    </ul>
  </div>`;
  const out = capExperienceBullets(html);
  const counts = bulletCounts(out);
  check('role with multiple <ul> capped by total count', counts[0] === 6, JSON.stringify(counts));
  check('multiple <ul>: keeps first bullets, drops tail', out.includes('b1') && out.includes('b6') && !out.includes('b7') && !out.includes('b8'), 'first six kept');
}

// Missing outer </div> on a job block must not leak bullets into the next role.
{
  const first = job('First', 9).replace(/\s*<\/div>\s*$/, ''); // drop closing </div>
  const html = [first, job('Second', 9)].join('\n');
  const out = capExperienceBullets(html);
  const counts = bulletCounts(out);
  check('missing </div>: both roles still capped', counts[0] === 6 && counts[1] === 6, JSON.stringify(counts));
}

// A no-<ul> role before valid roles still consumes a recency slot, so the
// recent/older boundary can't silently shift.
{
  const noUl = `  <div class="job">
    <div class="job-role">Header-Only Role</div>
  </div>`;
  // Index 0 = no-ul (recent), index 1 = recent (cap 6), index 2 = older (cap 4).
  const html = [noUl, job('Recent', 9), job('Older', 9)].join('\n');
  const out = capExperienceBullets(html);
  const counts = bulletCounts(out);
  check('no-<ul> role consumes a recency slot', counts[0] === 0 && counts[1] === 6 && counts[2] === 4, JSON.stringify(counts));
}

// The job-header / job-role inner wrappers must NOT be mistaken for job blocks.
{
  const html = job('A', 9);
  const counts = bulletCounts(html);
  check('inner job-header/job-role not counted as roles', counts.length === 1, `roles=${counts.length}`);
}

// Unquoted class attribute: `<div class=job>` (valid HTML).
{
  const html = job('A', 9).replace('<div class="job">', '<div class=job>');
  const out = capExperienceBullets(html);
  check('unquoted class=job wrapper is still capped', bulletCounts(out)[0] === 6, JSON.stringify(bulletCounts(out)));
}

// An unquoted role between recognized roles must still consume a recency slot,
// so an older role can't retain the recent-role cap.
{
  const recent = job('Recent', 1);
  const unquoted = job('Unquoted', 9).replace('<div class="job">', '<div class=job>');
  const older = job('Older', 9);
  const html = [recent, unquoted, older].join('\n');
  const out = capExperienceBullets(html);
  const counts = bulletCounts(out);
  // index 0 recent (1), index 1 recent (cap 6), index 2 older (cap 4).
  check('unquoted role between recognized roles keeps recency boundary', counts[0] === 1 && counts[1] === 6 && counts[2] === 4, JSON.stringify(counts));
}

// Uppercase <LI> bullets must be counted and capped, not bypassed.
{
  const html = job('A', 9).replace(/<li>/g, '<LI>').replace(/<\/li>/g, '</LI>');
  const out = capExperienceBullets(html);
  const count = (out.match(/<li\b/gi) || []).length;
  check('uppercase <LI> bullets are capped', count === 6, `count=${count}`);
}

// Fail closed: bullets present but no recognizable job wrapper → throw.
{
  const html = '<ul><li>orphan 1</li><li>orphan 2</li><li>orphan 3</li></ul>';
  let threw = false;
  try {
    capExperienceBullets(html);
  } catch {
    threw = true;
  }
  check('throws when bullets exist but no job wrapper is recognized', threw);
}

// Fail closed: a role that structurally can't be trimmed to cap → throw. (Here
// we force it by giving a cap of 0 with minBullets 0 is impossible to violate;
// instead simulate an unrecognized-shape leftover by capping segments that the
// validator would still see over budget. Use a bullet the trimmer's <li>…</li>
// regex can't pair.)
{
  // A malformed <li> with no closing tag: the trimmer's paired regex can't drop
  // it, so after trimming the count stays over cap and validation must throw.
  const html = `<div class="job"><ul><li>ok 1</li><li>ok 2</li><li>ok 3</li><li>ok 4</li><li>ok 5</li><li>ok 6</li><li>unclosed 7<li>unclosed 8</ul></div>`;
  let threw = false;
  try {
    capExperienceBullets(html); // enterprise recent cap 6
  } catch {
    threw = true;
  }
  check('throws when a role remains over cap after trimming', threw);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('\nFailures:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
