// A syntax error in renderer.js leaves the window blank with no visible error, so fail the build instead.
import { readFileSync } from 'node:fs';
try {
  new Function(readFileSync('src/renderer/renderer.js', 'utf8'));
  console.log('renderer.js: syntax ok');
} catch (err) {
  console.error('renderer.js has a syntax error:', err.message);
  process.exit(1);
}
