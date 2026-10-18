// Harmless read-only host checks: no framework initialization, signing or allocation.
import { execFileSync } from 'node:child_process';
import { existsSync, statfsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function command(file, args) {
  try { return execFileSync(file, args, { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return 'unavailable'; }
}
const sdk = command('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-path']);
const identities = command('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']);
const disk = statfsSync(root);
const report = {
  checkedAt: new Date().toISOString(), platform: process.platform, architecture: process.arch,
  macOS: command('/usr/bin/sw_vers', ['-productVersion']), build: command('/usr/bin/sw_vers', ['-buildVersion']),
  developerDirectory: command('/usr/bin/xcode-select', ['-p']),
  swift: command('/usr/bin/xcrun', ['swift', '--version']), node: process.version, nodeExecutable: process.execPath,
  sdk, publicNativeMacOSHomeKit: existsSync(`${sdk}/System/Library/Frameworks/HomeKit.framework`),
  publicCatalystHomeKit: existsSync(`${sdk}/System/iOSSupport/System/Library/Frameworks/HomeKit.framework`),
  validSigningIdentityCount: identities.match(/(\d+) valid identities found/)?.[1] ?? 'unavailable',
  compileOnlyDevelopmentAppBuilt: existsSync(resolve(root, 'native/build/HomeKitMCPBridge.app/Contents/MacOS/HomeKitMCPBridge')),
  diskAvailableBytes: disk.bavail * disk.bsize,
  developmentProvisioningVerified: false, homeKitAuthorizationAttempted: false,
  recordingEnabled: false, cacheAllocatedBytes: 0, clientConfigurationInstalled: false,
  note: 'Disk free space is a point-in-time check, not a reservation. No HomeKit, NAS or cloud access attempted.',
};
console.log(JSON.stringify(report, null, 2));
