import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeTransport } from '../src/native-transport.js';

async function harness(code: string, run: (transport: NativeTransport) => Promise<void>, timeout = 1000) {
  const directory = await mkdtemp(join(tmpdir(), 'homekit-transport-test-'));
  const executable = join(directory, 'mock-helper.mjs');
  await writeFile(executable, `#!${process.execPath}\n${code}`, { mode: 0o700 });
  const transport = new NativeTransport(executable, join(directory, 'unused.json'), timeout);
  try { await run(transport); }
  finally { await transport.close(); await rm(directory, { recursive: true, force: true }); }
}
const lines = `import {createInterface} from 'node:readline';\nconst lines=createInterface({input:process.stdin});\n`;

test('private transport correlates split frames and strips inherited secrets', async () => {
  process.env.HOMEKIT_TEST_SECRET = 'never pass this';
  try {
    await harness(lines + `lines.on('line', line=>{ const q=JSON.parse(line); const s=JSON.stringify({id:q.id,ok:true,result:{command:q.command,secretPresent:process.env.HOMEKIT_TEST_SECRET!==undefined}})+'\\n';process.stdout.write(s.slice(0,9));setTimeout(()=>process.stdout.write(s.slice(9)),10); });`,
      async transport => assert.deepEqual(await transport.request('status'), { command: 'status', secretPresent: false }));
  } finally { delete process.env.HOMEKIT_TEST_SECRET; }
});

test('malformed or oversized helper output fails closed', async () => {
  for (const payload of [`process.stdout.write('not-json\\n')`, `process.stdout.write('x'.repeat(1024*1024+1))`]) {
    await harness(lines + `lines.on('line',()=>{${payload}});`, async transport => {
      await assert.rejects(transport.request('status'), /BRIDGE_(PROTOCOL_ERROR|FRAME_TOO_LARGE)/);
      await assert.rejects(transport.request('status'), /BRIDGE_CLOSED/);
    });
  }
});

test('helper timeout terminates a stuck process even when it ignores SIGTERM', async () => {
  await harness(lines + `process.on('SIGTERM',()=>{});let ready=false;lines.on('line',line=>{if(!ready){ready=true;process.stdout.write(JSON.stringify({id:JSON.parse(line).id,ok:true,result:'ready'})+'\\n');}});setInterval(()=>{},1000);`, async transport => {
    assert.equal(await transport.request('status'), 'ready', 'SIGTERM handler installed before timeout test');
    await assert.rejects(transport.request('status'), /BRIDGE_TIMEOUT/);
    const start = Date.now();
    await transport.close();
    assert.ok(Date.now() - start >= 700, 'helper really ignored TERM until the KILL fallback');
    assert.ok(Date.now() - start < 2500, 'bounded SIGKILL fallback');
  }, 1000);
});

test('concurrent read is refused instead of timing out behind native serial queue', async () => {
  await harness(lines + `lines.on('line',line=>setTimeout(()=>process.stdout.write(JSON.stringify({id:JSON.parse(line).id,ok:true,result:1})+'\\n'),100));`, async transport => {
    const first = transport.request('status');
    await assert.rejects(transport.request('list_accessories'), /BRIDGE_BUSY/);
    assert.equal(await first, 1);
  });
});

test('native error codes are safe and household messages are not forwarded', async () => {
  await harness(lines + `lines.on('line',line=>process.stdout.write(JSON.stringify({id:JSON.parse(line).id,ok:false,error:{code:'homekit_unauthorized',message:'private household text'}})+'\\n'));`, async transport => {
    await assert.rejects(transport.request('list_accessories'), error => error instanceof Error
      && error.message === 'HOMEKIT_UNAUTHORIZED');
  });
});
