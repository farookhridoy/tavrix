/** Terminal appearance and connection options: defaults, limits, and sanitising of anything that came from the UI or disk. */

export const THEMES = ['tavrix-dark', 'light', 'solarized-dark', 'dracula', 'monokai'] as const;
export type ThemeName = (typeof THEMES)[number];
export const CURSORS = ['block', 'bar', 'underline'] as const;
export type CursorStyle = (typeof CURSORS)[number];

export interface TerminalPrefs {
  fontFamily: string;
  fontSize: number;
  theme: ThemeName;
  scrollback: number;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  /** Copy the selection to the clipboard as soon as it is made. */
  copyOnSelect: boolean;
}

export const DEFAULT_TERMINAL: TerminalPrefs = {
  fontFamily: 'Menlo, Monaco, "Courier New", monospace',
  fontSize: 13,
  theme: 'tavrix-dark',
  scrollback: 5000,
  cursorStyle: 'block',
  cursorBlink: true,
  copyOnSelect: false,
};

/** Connection options a session can set; blank means "use the default". */
export interface ConnectionPrefs {
  /** Seconds between keep-alive probes; 0 turns them off. Stops idle sessions being dropped by routers and firewalls. */
  keepAliveSec: number;
  compression: boolean;
  connectTimeoutSec: number;
}

export const DEFAULT_CONNECTION: ConnectionPrefs = { keepAliveSec: 30, compression: false, connectTimeoutSec: 20 };

const clampInt = (v: unknown, min: number, max: number): number | undefined => {
  const n = typeof v === 'string' && v.trim() === '' ? NaN : Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : undefined;
};
const oneOf = <T extends string>(v: unknown, list: readonly T[]): T | undefined => (list as readonly unknown[]).includes(v) ? (v as T) : undefined;
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
/** A CSS font list: letters, digits, spaces, commas, quotes, dots, dashes and underscores only. */
const fontList = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() && v.length <= 120 && /^[\w ,'".-]+$/.test(v) ? v.trim() : undefined;

/** Keep only valid fields. Anything missing or out of range is left out so the caller's default applies. */
export function sanitizeTerminal(input: unknown): Partial<TerminalPrefs> {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const out: Partial<TerminalPrefs> = {
    fontFamily: fontList(o.fontFamily),
    fontSize: clampInt(o.fontSize, 8, 32),
    theme: oneOf(o.theme, THEMES),
    scrollback: clampInt(o.scrollback, 0, 100_000),
    cursorStyle: oneOf(o.cursorStyle, CURSORS),
    cursorBlink: bool(o.cursorBlink),
    copyOnSelect: bool(o.copyOnSelect),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as Partial<TerminalPrefs>;
}

export function sanitizeConnection(input: unknown): Partial<ConnectionPrefs> {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const out: Partial<ConnectionPrefs> = {
    keepAliveSec: clampInt(o.keepAliveSec, 0, 3600),
    compression: bool(o.compression),
    connectTimeoutSec: clampInt(o.connectTimeoutSec, 5, 120),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as Partial<ConnectionPrefs>;
}

/** A session folder name: one level, trimmed, no slashes or control characters, bounded. */
export function sanitizeFolder(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const name = v.replace(/[\u0000-\u001f/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  return name || undefined;
}

/** Quote a path for a POSIX shell so spaces, quotes and `$` stay literal. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** What to type into a new shell for a session's startup folder and command; newlines are stripped so one field is one line. */
export function startupInput(dir?: string, command?: string): string {
  const oneLine = (t: string): string => t.replace(/[\r\n]+/g, ' ').trim();
  const lines: string[] = [];
  if (dir && oneLine(dir)) lines.push(`cd -- ${shellQuote(oneLine(dir))}`);
  if (command && oneLine(command)) lines.push(oneLine(command));
  return lines.map((l) => l + '\r').join('');
}
