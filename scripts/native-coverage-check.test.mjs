// Regression tests for the native coverage gate. Pure Node: no Swift, Xcode, network or device is used.
// Run with: npm run test:gates
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { evaluateNativeCoverage, isEntryModule, listBridgeCoreSources } from './native-coverage-check.mjs';

const realRoot = resolve(import.meta.dirname, '..');
const script = join(import.meta.dirname, 'native-coverage-check.mjs');

function fixtureRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'native-gate-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const core = join(root, 'native/Sources/BridgeCore');
  mkdirSync(join(core, 'Nested'), { recursive: true });
  mkdirSync(join(root, 'native/Sources/Helper'), { recursive: true });
  for (const name of ['BridgeCore.swift', 'StdioServer.swift', 'Nested/Deep.swift']) writeFileSync(join(core, name), '// synthetic\n');
  writeFileSync(join(core, 'Notes.txt'), 'not swift');
  writeFileSync(join(root, 'native/Sources/Helper/App.swift'), '// out of scope\n');
  return root;
}
const SOURCES = ['native/Sources/BridgeCore/BridgeCore.swift', 'native/Sources/BridgeCore/Nested/Deep.swift', 'native/Sources/BridgeCore/StdioServer.swift'];
const counter = (covered, count) => ({ covered, count, percent: count === 0 ? 0 : (covered / count) * 100 });
const summary = (covered = 95, count = 100) => ({
  lines: counter(covered, count), functions: counter(covered, count), regions: counter(covered, count), branches: { covered: 0, count: 0, percent: 0 },
});
const entry = (root, path, value = summary()) => ({ filename: join(root, path), summary: value });
const reportOf = (...files) => ({ data: [{ files }] });
const good = (root) => reportOf(...SOURCES.map((path) => entry(root, path)));
const evaluate = (report, root, expectedSources = SOURCES) => evaluateNativeCoverage(report, { root, expectedSources });
const assertFails = (result, pattern, label) => {
  assert.notEqual(result.failures.length, 0, `${label}: the gate must fail closed`);
  assert.ok(result.failures.some((failure) => pattern.test(failure)), `${label}: expected ${pattern}, got ${JSON.stringify(result.failures)}`);
};

test('inventory is recursive, sorted, Swift-only and limited to BridgeCore', (t) => {
  assert.deepEqual(listBridgeCoreSources(fixtureRoot(t)), SOURCES);
  const real = listBridgeCoreSources(realRoot);
  for (const name of ['BridgeCore.swift', 'SessionCoordinator.swift', 'StdioServer.swift']) {
    assert.ok(real.includes(`native/Sources/BridgeCore/${name}`), `${name} must be part of the measured inventory`);
  }
  assert.ok(real.every((path) => path.startsWith('native/Sources/BridgeCore/')));
  // Independent of the function under test: every .swift file under BridgeCore is in the inventory, and nothing else is.
  const walked = readdirSync(join(realRoot, 'native/Sources/BridgeCore'), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.swift'))
    .map((entry) => join(entry.parentPath, entry.name).slice(realRoot.length + 1).split(sep).join('/')).sort();
  assert.deepEqual(real, walked);
  assert.ok(real.length >= 3);
});

test('an exact inventory at or above 90% in every metric passes; Helper entries are ignored', (t) => {
  const root = fixtureRoot(t);
  assert.deepEqual(evaluate(good(root), root).failures, []);
  const atFloor = reportOf(...SOURCES.map((path) => entry(root, path, summary(90, 100))));
  assert.deepEqual(evaluate(atFloor, root).failures, [], 'exactly 90% passes');
  const withHelper = reportOf(...SOURCES.map((path) => entry(root, path)), entry(root, 'native/Sources/Helper/App.swift', summary(0, 500)));
  assert.deepEqual(evaluate(withHelper, root).failures, [], 'out-of-scope files neither help nor hurt');
  const result = evaluate(good(root), root);
  assert.deepEqual(result.totals.lines, { covered: 285, count: 300 });
});

test('a missing source fails closed even when the remaining files look perfect', (t) => {
  const root = fixtureRoot(t);
  for (const missing of SOURCES) {
    const report = reportOf(...SOURCES.filter((path) => path !== missing).map((path) => entry(root, path, summary(100, 100))));
    assertFails(evaluate(report, root), new RegExp(`${missing.replace(/[./]/g, '\\$&')} is absent`), `missing ${missing}`);
  }
  assertFails(evaluate(reportOf(entry(root, 'native/Sources/Helper/App.swift')), root), /absent/, 'only Helper reported');
});

test('duplicate and unexpected scoped sources fail closed', (t) => {
  const root = fixtureRoot(t);
  assertFails(evaluate(reportOf(...SOURCES.map((path) => entry(root, path)), entry(root, SOURCES[1])), root), /more than once/, 'duplicate in one data entry');
  assertFails(evaluate({ data: [{ files: SOURCES.map((path) => entry(root, path)) }, { files: [entry(root, SOURCES[2])] }] }, root), /more than once/, 'duplicate across data entries');
  assertFails(evaluate(reportOf(...SOURCES.map((path) => entry(root, path)), entry(root, 'native/Sources/BridgeCore/Ghost.swift')), root), /Ghost\.swift is reported .* not a BridgeCore \*\.swift source on disk/, 'unexpected file');
  assertFails(evaluate(good(root), root, SOURCES.slice(0, 2)), /StdioServer\.swift is reported/, 'file reported but not on disk inventory');
  assertFails(evaluate(good(root), root, []), /no native\/Sources\/BridgeCore\/\*\.swift sources/, 'empty inventory');
});

test('zero totals fail even though 0/0 would otherwise look complete', (t) => {
  const root = fixtureRoot(t);
  const zero = reportOf(...SOURCES.map((path) => entry(root, path, summary(0, 0))));
  const result = evaluate(zero, root);
  for (const metric of ['lines', 'functions', 'regions']) assertFails(result, new RegExp(`total ${metric} count is 0`), metric);
  const noRegions = reportOf(...SOURCES.map((path) => entry(root, path, { ...summary(), regions: counter(0, 0) })));
  assertFails(evaluate(noRegions, root), /total regions count is 0/, 'one metric with no counted items');
});

test('missing summary or counter and non-integer values fail closed instead of becoming NaN', (t) => {
  const root = fixtureRoot(t);
  const withOne = (value) => reportOf(entry(root, SOURCES[0], value), entry(root, SOURCES[1]), entry(root, SOURCES[2]));
  assertFails(evaluate(reportOf({ filename: join(root, SOURCES[0]) }, entry(root, SOURCES[1]), entry(root, SOURCES[2])), root), /BridgeCore\.swift has no "summary" object/, 'missing summary');
  assertFails(evaluate(reportOf({ filename: join(root, SOURCES[0]), summary: 'oops' }, entry(root, SOURCES[1]), entry(root, SOURCES[2])), root), /no "summary" object/, 'non-object summary');
  for (const metric of ['lines', 'functions', 'regions']) {
    const missing = summary(); delete missing[metric];
    assertFails(evaluate(withOne(missing), root), new RegExp(`has no "${metric}" counter`), `missing ${metric}`);
    assertFails(evaluate(withOne({ ...summary(), [metric]: 7 }), root), new RegExp(`has no "${metric}" counter`), `non-object ${metric}`);
  }
  const bad = [['"NaN"', 'NaN'], ['null', null], ['undefined', undefined], ['float', 1.5], ['negative', -1], ['Infinity', Infinity],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 2], ['string number', '95'], ['boolean', true]];
  for (const [label, value] of bad) {
    for (const field of ['covered', 'count']) {
      const broken = summary(); broken.lines = { ...broken.lines, [field]: value };
      assertFails(evaluate(withOne(broken), root), /covered\/count must be finite nonnegative integers/, `${field} ${label}`);
    }
  }
  const missingField = summary(); missingField.functions = { count: 100 };
  assertFails(evaluate(withOne(missingField), root), /functions covered\/count must be/, 'missing covered field');
  const overshoot = summary(); overshoot.regions = counter(101, 100);
  assertFails(evaluate(withOne(overshoot), root), /regions covered 101 exceeds count 100/, 'covered above count');
});

test('below-90 totals fail per metric, and out-of-scope files cannot compensate', (t) => {
  const root = fixtureRoot(t);
  for (const metric of ['lines', 'functions', 'regions']) {
    const low = reportOf(...SOURCES.map((path) => entry(root, path, { ...summary(100, 100), [metric]: counter(89, 100) })));
    assertFails(evaluate(low, root), new RegExp(`${metric} 89\\.00% is below 90%`), metric);
  }
  const compensated = reportOf(...SOURCES.map((path) => entry(root, path, summary(80, 100))), entry(root, 'native/Sources/Helper/App.swift', summary(10_000, 10_000)));
  assertFails(evaluate(compensated, root), /lines 80\.00% is below 90%/, 'Helper cannot raise the BridgeCore total');
  // Global, not per file: one weaker file is fine while the combined total reaches 90%.
  const mixed = reportOf(entry(root, SOURCES[0], summary(100, 100)), entry(root, SOURCES[1], summary(100, 100)), entry(root, SOURCES[2], summary(70, 100)));
  assert.deepEqual(evaluate(mixed, root).failures, [], '270/300 = 90% passes globally');
});

test('malformed report shapes produce clear failures instead of throwing', (t) => {
  const root = fixtureRoot(t);
  const shapes = [[null, 'null'], [[], 'array'], ['text', 'string'], [{}, 'no data'], [{ data: [] }, 'empty data'], [{ data: {} }, 'data object']];
  for (const [shape, label] of shapes) assertFails(evaluate(shape, root), /malformed report: expected a non-empty "data" array/, label);
  assertFails(evaluate({ data: [{}] }, root), /data\[0\] has no "files" array/, 'entry without files');
  assertFails(evaluate({ data: [{ files: 'x' }] }, root), /data\[0\] has no "files" array/, 'files not array');
  assertFails(evaluate({ data: [null] }, root), /data\[0\] has no "files" array/, 'null entry');
  const noName = reportOf(...SOURCES.map((path) => entry(root, path)), { summary: summary() }, null, { filename: 7, summary: summary() }, { filename: '', summary: summary() });
  const result = evaluate(noName, root);
  assert.equal(result.failures.filter((failure) => /no string "filename"/.test(failure)).length, 4);
});

function runCli(t, report, { raw } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'native-gate-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'codecov.json');
  writeFileSync(path, raw ?? JSON.stringify(report));
  return spawnSync(process.execPath, [script, path], { encoding: 'utf8', timeout: 10_000 });
}
const realFiles = (summaryValue = summary()) => listBridgeCoreSources(realRoot).map((path) => entry(realRoot, path, summaryValue));

test('CLI passes a report covering the real BridgeCore inventory and states its honest scope', (t) => {
  const result = runCli(t, reportOf(...realFiles(), entry(realRoot, 'native/Sources/Helper/App.swift', summary(0, 10))));
  assert.equal(result.status, 0, result.stderr);
  // The count is derived from the real inventory, so adding a BridgeCore source cannot make this assertion stale
  // while removing or skipping one still changes the on-disk/reported pair the gate prints.
  const expected = listBridgeCoreSources(realRoot).length;
  assert.match(result.stdout, new RegExp(`BridgeCore/\\*\\.swift \\(${expected} files on disk, ${expected} reported\\)`));
  assert.match(result.stdout, /Excludes Helper \(Catalyst app\)/);
  assert.match(result.stdout, /no branch metric is claimed/);
});

test('CLI exits 1 for a missing real source, below-90 totals, zero totals and bad numbers, and 2 for unreadable input', (t) => {
  const files = realFiles();
  const missingStdio = runCli(t, reportOf(...files.filter((file) => !file.filename.endsWith('StdioServer.swift'))));
  assert.equal(missingStdio.status, 1);
  assert.match(missingStdio.stderr, /StdioServer\.swift is absent from the native coverage report/);
  // Every real source is individually required: dropping any one of them (even with perfect numbers elsewhere) fails.
  for (const source of listBridgeCoreSources(realRoot)) {
    const without = runCli(t, reportOf(...realFiles(summary(100, 100)).filter((file) => !file.filename.endsWith(source))));
    assert.equal(without.status, 1, `omitting ${source} must fail`);
    assert.ok(without.stderr.includes(`${source} is absent from the native coverage report`), without.stderr);
  }
  const below = runCli(t, reportOf(...realFiles(summary(50, 100))));
  assert.equal(below.status, 1);
  assert.match(below.stderr, /lines 50\.00% is below 90%/);
  assert.equal(runCli(t, reportOf(...realFiles(summary(0, 0)))).status, 1);
  const raw = JSON.stringify(reportOf(...realFiles())).replace('"covered":95', '"covered":1e999');
  const infinite = runCli(t, undefined, { raw });
  assert.equal(infinite.status, 1);
  assert.match(infinite.stderr, /covered\/count must be finite nonnegative integers/);
  assert.equal(runCli(t, undefined, { raw: '{ not json' }).status, 2);
  assert.equal(runCli(t, undefined, { raw: '{}' }).status, 1);
  assert.equal(spawnSync(process.execPath, [script], { encoding: 'utf8' }).status, 2, 'no argument');
  assert.equal(spawnSync(process.execPath, [script, '/nonexistent/codecov.json'], { encoding: 'utf8' }).status, 2, 'missing file');
});

// The CLI must never be skipped silently: a gate that "passes" because main() did not run checks nothing.
test('entry detection compares real paths and is false for importers, empty and unresolvable arguments', (t) => {
  const moduleUrl = pathToFileURL(script).href;
  assert.equal(isEntryModule(script, moduleUrl), true, 'absolute path');
  assert.equal(isEntryModule(relative(process.cwd(), script), moduleUrl), true, 'relative path');
  const directory = mkdtempSync(join(tmpdir(), 'native-gate-entry-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const link = join(directory, 'gate-link.mjs');
  symlinkSync(script, link);
  assert.equal(isEntryModule(link, moduleUrl), true, 'symlinked launch');
  assert.equal(isEntryModule(import.meta.filename, moduleUrl), false, 'an importing script is not the entry');
  assert.equal(isEntryModule(undefined, moduleUrl), false);
  assert.equal(isEntryModule('', moduleUrl), false);
  assert.equal(isEntryModule(join(directory, 'missing.mjs'), moduleUrl), false);
});

test('CLI really runs when launched by relative path or through a symlink (exit 2 with usage, never a silent 0)', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'native-gate-launch-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const link = join(directory, 'gate-link.mjs');
  symlinkSync(script, link);
  const launches = [
    ['relative', spawnSync(process.execPath, ['./native-coverage-check.mjs'], { cwd: import.meta.dirname, encoding: 'utf8', timeout: 10_000 })],
    ['symlink', spawnSync(process.execPath, [link], { encoding: 'utf8', timeout: 10_000 })],
  ];
  for (const [label, result] of launches) {
    assert.equal(result.status, 2, `${label}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /usage: native-coverage-check\.mjs <codecov\.json>/, label);
  }
});
