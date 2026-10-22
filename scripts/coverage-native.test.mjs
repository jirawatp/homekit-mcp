// Regression tests for scripts/coverage-native.sh. Pure Node + bash: an isolated temporary project (its directory
// name contains a space) and a stub `swift` on PATH. No Swift, Xcode, HomeKit, device or network is used and no
// real build output is read or modified. Run with: npm run test:gates
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const scriptsDirectory = import.meta.dirname;
const SOURCES = ['BridgeCore.swift', 'SessionCoordinator.swift', 'StdioServer.swift'].map((name) => `native/Sources/BridgeCore/${name}`);

// Records the environment and arguments each SwiftPM call receives, then behaves like the two calls the script makes.
const STUB = `#!/bin/bash
{ echo "CLANG=\${CLANG_MODULE_CACHE_PATH-<unset>}"; echo "SPM=\${SWIFTPM_MODULECACHE_OVERRIDE-<unset>}"; echo "CWD=$PWD"; echo "ARGS=$*"; } >> "$STUB_LOG"
case " $* " in
  *" --show-codecov-path "*) printf '%b\\n' "$STUB_OUT"; exit 0 ;;
  *" --enable-code-coverage "*) if [ -n "\${STUB_REPORT:-}" ]; then cp "$STUB_REPORT" "$STUB_OUT"; fi; exit "\${STUB_TEST_STATUS:-0}" ;;
esac
exit 0
`;

function project(t) {
  // Real path (macOS temp dirs are symlinked), as llvm-cov reports and the gate's own root resolution use.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native script test-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts'));
  for (const name of ['coverage-native.sh', 'test-native.sh', 'native-env.sh', 'native-coverage-check.mjs']) {
    copyFileSync(join(scriptsDirectory, name), join(root, 'scripts', name));
  }
  mkdirSync(join(root, 'native/Sources/BridgeCore'), { recursive: true });
  for (const source of SOURCES) writeFileSync(join(root, source), '// synthetic\n');
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin/swift'), STUB);
  chmodSync(join(root, 'bin/swift'), 0o755);
  return root;
}

const counter = (covered, count) => ({ covered, count, percent: (covered / count) * 100 });
const report = (root, { percent = 95, sources = SOURCES } = {}) => JSON.stringify({
  data: [{ files: sources.map((source) => ({
    filename: join(root, source),
    summary: { lines: counter(percent, 100), functions: counter(percent, 100), regions: counter(percent, 100), branches: { covered: 0, count: 0, percent: 0 } },
  })) }],
});

/** Runs the script. `produce` is the report the stub writes during the test call (undefined: the stub writes nothing). */
function run(root, { produce, out = join(root, 'external/codecov.json'), testStatus = 0, env = {} } = {}) {
  mkdirSync(join(root, 'external'), { recursive: true });
  const log = join(root, 'stub.log');
  const reportPath = join(root, 'report-to-write.json');
  if (produce !== undefined) writeFileSync(reportPath, produce);
  const result = spawnSync('bash', [join(root, 'scripts/coverage-native.sh')], {
    encoding: 'utf8', timeout: 30_000, cwd: tmpdir(),
    env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, STUB_LOG: log, STUB_OUT: out,
      STUB_REPORT: produce === undefined ? '' : reportPath, STUB_TEST_STATUS: String(testStatus), ...env },
  });
  const lines = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
  const calls = [];
  for (let index = 0; index < lines.length; index += 4) calls.push(Object.fromEntries(lines.slice(index, index + 4).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])));
  return { ...result, calls };
}

test('both SwiftPM stages receive identical scoped scratch/cache settings, even when the caller exports others', (t) => {
  const root = project(t);
  const result = run(root, { produce: report(root), env: { CLANG_MODULE_CACHE_PATH: '/elsewhere/clang', SWIFTPM_MODULECACHE_OVERRIDE: '/elsewhere/spm' } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls.length, 2, 'the test run and the coverage-path lookup');
  const scoped = join(root, 'native/.build');
  for (const call of result.calls) {
    assert.equal(call.CLANG, join(scoped, 'module-cache'));
    assert.equal(call.SPM, join(scoped, 'module-cache'));
    assert.equal(call.CWD, join(root, 'native'));
    for (const flag of [`--scratch-path ${scoped}`, `--cache-path ${join(scoped, 'cache')}`, `--config-path ${join(scoped, 'config')}`, `--security-path ${join(scoped, 'security')}`, '--disable-sandbox']) {
      assert.ok(call.ARGS.includes(flag), `${flag} in ${call.ARGS}`);
    }
  }
  assert.ok(result.calls[0].ARGS.endsWith('--enable-code-coverage'));
  assert.ok(result.calls[1].ARGS.endsWith('--show-codecov-path'));
  assert.match(result.stdout, /\(3 files on disk, 3 reported\)/);
});

test('the freshness marker is cleaned up and nothing but it is created in the build directory', (t) => {
  const root = project(t);
  const result = run(root, { produce: report(root) });
  assert.equal(result.status, 0, result.stderr);
  const leftovers = spawnSync('bash', ['-c', 'ls -A native/.build'], { cwd: root, encoding: 'utf8' }).stdout.split('\n').filter(Boolean).sort();
  assert.deepEqual(leftovers, ['cache', 'config', 'module-cache', 'security']);
});

test('a report below 90% or missing a BridgeCore source fails the gate (exit 1)', (t) => {
  const root = project(t);
  const low = run(root, { produce: report(root, { percent: 80 }) });
  assert.equal(low.status, 1);
  assert.match(low.stderr, /lines 80\.00% is below 90%/);
  const missing = run(root, { produce: report(root, { sources: SOURCES.slice(0, 2) }) });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /StdioServer\.swift is absent from the native coverage report/);
});

test('a coverage report from an earlier build is refused instead of gated (exit 2)', (t) => {
  const root = project(t);
  const out = join(root, 'external/codecov.json');
  mkdirSync(join(root, 'external'), { recursive: true });
  writeFileSync(out, report(root)); // a perfectly good-looking report...
  const anHourAgo = new Date(Date.now() - 3_600_000);
  utimesSync(out, anHourAgo, anHourAgo); // ...that this run did not produce
  const result = run(root, { out });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /older than this run \(stale report/);
  assert.doesNotMatch(result.stdout, /Native coverage scope/, 'the stale file must never reach the gate');
  assert.equal(readFileSync(out, 'utf8'), report(root), 'the old file is left alone, not deleted');
});

test('a missing, empty or multi-line reported path fails closed (exit 2)', (t) => {
  const root = project(t);
  for (const [label, out] of [['missing file', join(root, 'external/none.json')], ['empty path', ''], ['multi-line output', `${join(root, 'external/a.json')}\\n${join(root, 'external/b.json')}`]]) {
    const result = run(root, { out });
    assert.equal(result.status, 2, label);
    assert.match(result.stderr, /not produced at the reported path/, label);
    assert.doesNotMatch(result.stdout, /Native coverage scope/, label);
  }
});

test('a failing test run stops before any path lookup or gate evaluation', (t) => {
  const root = project(t);
  const result = run(root, { produce: report(root), testStatus: 1 });
  assert.notEqual(result.status, 0);
  assert.equal(result.calls.length, 1, 'no coverage-path lookup after failed tests');
  assert.doesNotMatch(result.stdout, /Native coverage scope/);
});

test('test-native.sh forwards its arguments through the same scoped settings', (t) => {
  const root = project(t);
  const log = join(root, 'stub.log');
  const result = spawnSync('bash', [join(root, 'scripts/test-native.sh'), '--filter', 'Some Suite'], {
    encoding: 'utf8', timeout: 30_000, cwd: tmpdir(),
    env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, STUB_LOG: log, STUB_OUT: '', STUB_REPORT: '' },
  });
  assert.equal(result.status, 0, result.stderr);
  const logged = readFileSync(log, 'utf8');
  assert.match(logged, new RegExp(`CLANG=${resolve(root, 'native/.build/module-cache').replace(/[.*+?^${}()|[\]\\ ]/g, '\\$&')}`));
  assert.match(logged, /--disable-sandbox --filter Some Suite/);
});
