// Re-compress release/*.dmg with LZMA (hdiutil's ULMO). electron-builder cannot write this format; it is ~17% smaller than bzip2.
// Skipped for signed/notarized builds: converting a disk image after it was signed would break its signature.
import { readdirSync, renameSync, statSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const dir = 'release';
const mb = (f) => (statSync(f).size / 1048576).toFixed(0);
for (const name of readdirSync(dir).filter((n) => n.endsWith('.dmg'))) {
  const src = join(dir, name);
  const tmp = join(dir, name.replace(/\.dmg$/, '.lzma.dmg'));
  const before = mb(src);
  rmSync(tmp, { force: true });
  execFileSync('hdiutil', ['convert', src, '-format', 'ULMO', '-o', tmp, '-quiet']);
  execFileSync('hdiutil', ['verify', tmp, '-quiet']);
  renameSync(tmp, src);
  console.log(`${name}: ${before} MB -> ${mb(src)} MB`);
}
