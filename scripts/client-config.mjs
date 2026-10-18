// Prints a scoped, disabled snippet. Never opens or edits a client's configuration.
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const template = process.argv.includes('--template');
const displayRoot = template ? '/absolute/path/to/homekit-mcp' : root;
const native = process.argv.includes('--native');
const docker = process.argv.includes('--docker');
if (native && docker) throw new Error('Choose --native or --docker; approved Docker host mode is documented separately.');
let args = [resolve(displayRoot, 'dist/src/index.js'), '--mode', native ? 'native' : 'mock',
  '--config', resolve(displayRoot, native ? 'config/homekit.local.json' : 'config/mock.json')];
if (native) args.push('--bridge', resolve(displayRoot, 'native/build/HomeKitMCPBridge.app/Contents/MacOS/HomeKitMCPBridge'), '--native-user-approved');
if (docker) args = ['run', '--rm', '-i', '--pull=never', '--network=none', '--read-only', '--user=1000:1000',
  '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--memory=192m', '--memory-swap=192m',
  '--cpus=0.5', '--pids-limit=64', '--init', '--log-driver=none',
  '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777', 'homekit-mcp:local'];
const name = docker ? 'homekit_own_docker_mock' : native ? 'homekit_own_native' : 'homekit_own_mock';
console.log(`# Review before adding to a LOCAL client's scoped configuration. Nothing has been installed.
# Native profile needs a signed/provisioned app, explicit access approval and accessory allowlist.
[mcp_servers.${name}]
enabled = false
command = ${JSON.stringify(docker ? 'docker' : template ? 'node' : process.execPath)}
args = ${JSON.stringify(args)}
startup_timeout_sec = 15
tool_timeout_sec = 60`);
