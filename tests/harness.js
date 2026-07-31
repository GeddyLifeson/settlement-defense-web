// Tiny in-browser assertion harness -- no external test framework, consistent with the
// project's "no dependencies beyond what ships in the browser" rule. Import `assert` and
// `section` from this module in each `*.test.js` file; `run.html` imports every test file
// (which push into the shared `results` array as a side effect of being imported) and then
// calls `renderSummary()` once all imports have resolved.
export const results = [];

// section() is just a labeled console grouping so failures are easy to trace back to which
// system's test file produced them -- it does not affect pass/fail accounting.
export function section(name, fn) {
  console.log(`--- ${name} ---`);
  try {
    fn();
  } catch (err) {
    results.push({ pass: false, msg: `${name}: threw ${err && err.stack ? err.stack : err}` });
  }
}

export function assert(cond, msg) {
  const pass = !!cond;
  results.push({ pass, msg });
  if (!pass) console.error('FAIL:', msg);
  return pass;
}

export function assertClose(actual, expected, epsilon, msg) {
  return assert(Math.abs(actual - expected) <= epsilon, `${msg} (got ${actual}, expected ~${expected} +/- ${epsilon})`);
}

export function summary() {
  const pass = results.filter(r => r.pass).length;
  const fail = results.length - pass;
  return { pass, fail, total: results.length };
}

// Renders the collected results into a #results DOM node in run.html, and also dumps a plain
// console summary so headless/console-only inspection works too.
export function renderSummary(containerId = 'results') {
  const { pass, fail, total } = summary();
  console.log(`\n==== TEST SUMMARY: ${pass}/${total} passed, ${fail} failed ====`);

  const el = document.getElementById(containerId);
  if (!el) return;

  const header = document.createElement('h2');
  header.textContent = fail === 0
    ? `ALL PASSED (${pass}/${total})`
    : `${fail} FAILED / ${total} total (${pass} passed)`;
  header.style.color = fail === 0 ? '#2a2' : '#c22';
  el.appendChild(header);

  const list = document.createElement('ul');
  for (const r of results) {
    const li = document.createElement('li');
    li.textContent = (r.pass ? 'PASS - ' : 'FAIL - ') + r.msg;
    li.style.color = r.pass ? '#2a2' : '#c22';
    li.style.fontFamily = 'monospace';
    list.appendChild(li);
  }
  el.appendChild(list);

  // Also surface a machine-readable flag on window for any future automated check.
  window.__testSummary = { pass, fail, total };
}
