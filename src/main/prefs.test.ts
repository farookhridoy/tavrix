import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeTerminal, sanitizeConnection, sanitizeFolder, sanitizeKind, shellQuote, startupInput, DEFAULT_TERMINAL, THEMES } from './prefs';

test('terminal prefs: valid values pass, out-of-range ones are clamped, junk is dropped', () => {
  assert.deepEqual(sanitizeTerminal({ fontSize: 15, theme: 'dracula', scrollback: 1000, cursorStyle: 'bar', cursorBlink: false, copyOnSelect: true, fontFamily: 'Menlo, monospace' }),
    { fontSize: 15, theme: 'dracula', scrollback: 1000, cursorStyle: 'bar', cursorBlink: false, copyOnSelect: true, fontFamily: 'Menlo, monospace' });
  assert.equal(sanitizeTerminal({ fontSize: 400 }).fontSize, 32);
  assert.equal(sanitizeTerminal({ fontSize: 1 }).fontSize, 8);
  assert.equal(sanitizeTerminal({ scrollback: -5 }).scrollback, 0);
  assert.equal(sanitizeTerminal({ scrollback: '2500' }).scrollback, 2500);
  assert.deepEqual(sanitizeTerminal({ fontSize: '', theme: 'neon', cursorStyle: 'blob', cursorBlink: 'yes', fontFamily: 'x; } body { display:none', scrollback: 'many' }), {}, 'blank/unknown values mean "use the default"');
  assert.deepEqual(sanitizeTerminal(null), {});
  assert.deepEqual(sanitizeTerminal('nope'), {});
  assert.ok(THEMES.includes(DEFAULT_TERMINAL.theme));
});

test('connection prefs: keep-alive 0 is a real value (off); timeouts are bounded', () => {
  assert.deepEqual(sanitizeConnection({ keepAliveSec: 0 }), { keepAliveSec: 0 });
  assert.equal(sanitizeConnection({ keepAliveSec: 99999 }).keepAliveSec, 3600);
  assert.equal(sanitizeConnection({ connectTimeoutSec: 1 }).connectTimeoutSec, 5);
  assert.deepEqual(sanitizeConnection({ keepAliveSec: '' , compression: 'x'}), {});
  assert.deepEqual(sanitizeConnection({ compression: true }), { compression: true });
});

test('folder names are one tidy level', () => {
  assert.equal(sanitizeFolder('  Work / Prod  '), 'Work Prod');
  assert.equal(sanitizeFolder('a\u0000b\nc'), 'a b c');
  assert.equal(sanitizeFolder('x'.repeat(200))?.length, 60);
  assert.equal(sanitizeFolder('   '), undefined);
  assert.equal(sanitizeFolder(42), undefined);
});

test('startup input is quoted, one line per field, and cannot be split into extra commands by newlines', () => {
  assert.equal(shellQuote("it's $HOME"), `'it'\\''s $HOME'`);
  assert.equal(startupInput('/var/www', 'ls -la'), "cd -- '/var/www'\rls -la\r");
  assert.equal(startupInput('/my dir/$x', undefined), "cd -- '/my dir/$x'\r");
  assert.equal(startupInput(undefined, 'htop'), 'htop\r');
  assert.equal(startupInput('', '  '), '');
  assert.equal(startupInput('/a\nrm -rf /', undefined), "cd -- '/a rm -rf /'\r", 'a newline cannot smuggle in a second command');
  assert.equal(startupInput(undefined, 'echo a\necho b'), 'echo a echo b\r');
});

test('session kind: only "sftp" is kept; everything else is a normal SSH session', () => {
  assert.equal(sanitizeKind('sftp'), 'sftp');
  for (const v of ['ssh', 'SFTP', 'ftp', '', null, undefined, 1, {}, ['sftp']]) assert.equal(sanitizeKind(v), undefined, String(v));
});
