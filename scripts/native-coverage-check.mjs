#!/usr/bin/env node
// Enforces the native coverage floor on the Foundation-only BridgeCore sources and prints exact scope.
// Input: the llvm-cov JSON that `swift test --enable-code-coverage` produces. LLVM reports lines,
// functions, regions and instantiations; it reports no branch counters for Swift, so none are claimed.
// This gate measures native/Sources/BridgeCore only. It does NOT cover native/Sources/Helper (the Mac
// Catalyst app: App.swift, HomeKitController.swift), BridgeFixture, test files, or real hardware/HomeKit.
//
// The gate fails closed: the report must contain exactly the BridgeCore *.swift files found on disk
// (recursively; none missing, duplicated or unexpected), every metric must be a well-formed integer
// pair with covered <= count, each metric total must be positive, and each GLOBAL total must reach 90%.
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FLOOR = 90;
export const SCOPE = 'native/Sources/BridgeCore/';
export const METRICS = ['lines', 'functions', 'regions'];

const posix = (path) => path.split(sep).join('/');
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCounter = (value) => Number.isSafeInteger(value) && value >= 0;

/** Recursive, sorted, repo-relative list of the BridgeCore Swift sources that must be measured. */
export function listBridgeCoreSources(root) {
  const base = join(root, SCOPE);
  const walk = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return walk(path);
    return entry.isFile() && entry.name.endsWith('.swift') ? [posix(relative(root, path))] : [];
  });
  return walk(base).sort();
}

/**
 * Pure evaluation. Returns { failures, rows, totals, branchCounters }; an empty `failures` means the gate passes.
 * `expectedSources` is the exact repo-relative inventory the report must contain.
 */
export function evaluateNativeCoverage(report, { root, expectedSources, floor = FLOOR }) {
  const failures = [];
  const fail = (message) => failures.push(message);
  const rows = [];
  const totals = Object.fromEntries(METRICS.map((metric) => [metric, { covered: 0, count: 0 }]));
  let branchCounters = 0;

  if (expectedSources.length === 0) fail(`no ${SCOPE}*.swift sources were found on disk to measure`);
  if (!isRecord(report) || !Array.isArray(report.data) || report.data.length === 0) {
    fail('malformed report: expected a non-empty "data" array (llvm-cov export JSON)');
    return { failures, rows, totals, branchCounters };
  }
  const files = [];
  for (const [index, entry] of report.data.entries()) {
    if (!isRecord(entry) || !Array.isArray(entry.files)) {
      fail(`malformed report: data[${index}] has no "files" array`);
      continue;
    }
    files.push(...entry.files);
  }

  const seen = new Map();
  for (const file of files) {
    if (!isRecord(file) || typeof file.filename !== 'string' || file.filename === '') {
      fail('malformed report: a file entry has no string "filename"');
      continue;
    }
    const path = posix(relative(root, resolve(file.filename)));
    if (!path.startsWith(SCOPE)) continue; // Helper, BridgeFixture, tests and dependencies are out of scope.
    if (seen.has(path)) { fail(`${path} appears more than once in the report`); continue; }
    seen.set(path, file);
  }

  for (const source of expectedSources) {
    if (!seen.has(source)) fail(`${source} is absent from the native coverage report`);
  }
  for (const path of seen.keys()) {
    if (!expectedSources.includes(path)) fail(`${path} is reported inside ${SCOPE} but is not a BridgeCore *.swift source on disk`);
  }

  for (const path of [...seen.keys()].filter((candidate) => expectedSources.includes(candidate)).sort()) {
    const { summary } = seen.get(path);
    if (!isRecord(summary)) { fail(`${path} has no "summary" object`); continue; }
    const row = { path, metrics: {} };
    for (const metric of METRICS) {
      const counter = summary[metric];
      if (!isRecord(counter)) { fail(`${path} has no "${metric}" counter`); continue; }
      const { covered, count } = counter;
      if (!isCounter(covered) || !isCounter(count)) {
        fail(`${path} ${metric} covered/count must be finite nonnegative integers (got ${JSON.stringify(covered)}/${JSON.stringify(count)})`);
        continue;
      }
      if (covered > count) { fail(`${path} ${metric} covered ${covered} exceeds count ${count}`); continue; }
      row.metrics[metric] = { covered, count };
      totals[metric].covered += covered;
      totals[metric].count += count;
    }
    if (isCounter(summary.branches?.count)) branchCounters += summary.branches.count;
    rows.push(row);
  }

  for (const metric of METRICS) {
    const { covered, count } = totals[metric];
    if (count <= 0) { fail(`total ${metric} count is ${count}; a positive count is required`); continue; }
    const pct = (covered / count) * 100;
    if (!(pct >= floor)) fail(`${metric} ${pct.toFixed(2)}% is below ${floor}%`);
  }
  return { failures, rows, totals, branchCounters };
}

function main(input) {
  if (!input) { console.error('usage: native-coverage-check.mjs <codecov.json>'); return 2; }
  let report;
  try { report = JSON.parse(readFileSync(input, 'utf8')); } catch { console.error('native coverage JSON is missing or unreadable'); return 2; }
  const root = resolve(import.meta.dirname, '..');
  const expectedSources = listBridgeCoreSources(root);
  const { failures, rows, totals, branchCounters } = evaluateNativeCoverage(report, { root, expectedSources });
  const percent = ({ covered, count }) => `${count === 0 ? '0.00' : ((covered / count) * 100).toFixed(2)}% (${covered}/${count})`;
  console.log(`Native coverage scope: ${SCOPE}*.swift (${expectedSources.length} files on disk, ${rows.length} reported). Excludes Helper (Catalyst app), BridgeFixture and tests.`);
  console.log('file'.padEnd(52) + METRICS.map((metric) => metric.padStart(18)).join(''));
  for (const row of rows) {
    console.log(row.path.padEnd(52) + METRICS.map((metric) => (row.metrics[metric] ? percent(row.metrics[metric]) : 'INVALID').padStart(18)).join(''));
  }
  console.log('TOTAL'.padEnd(52) + METRICS.map((metric) => percent(totals[metric]).padStart(18)).join(''));
  console.log(`LLVM branch counters for Swift in scope: ${branchCounters} (not reported by the tool, so no branch metric is claimed).`);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`Native coverage failure: ${failure}`);
    return 1;
  }
  return 0;
}

/**
 * True only when this module is the process entry script. Deliberately not `import.meta.main`: on a Node
 * that lacks it the property is `undefined`, which would skip `main` and let the gate exit 0 having checked
 * nothing. Comparing real paths works on every supported Node, including relative and symlinked launches,
 * and stays false when the module is imported (argv[1] is then the importing script).
 */
export function isEntryModule(argv1 = process.argv[1], moduleUrl = import.meta.url) {
  if (typeof argv1 !== 'string' || argv1 === '') return false;
  try { return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl)); } catch { return false; }
}

if (isEntryModule()) process.exitCode = main(process.argv[2]);
