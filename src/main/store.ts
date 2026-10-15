import { app, safeStorage } from 'electron';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { TerminalPrefs, ConnectionPrefs, DEFAULT_TERMINAL, DEFAULT_CONNECTION, sanitizeTerminal, sanitizeConnection } from './prefs';

export interface Profile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  privateKeyPath?: string;
  /** Saved session to pass through first (ProxyJump). */
  jumpHostId?: string;
  /** Group in the sidebar. */
  folder?: string;
  /** Typed into the first shell after login: `cd` to this folder, then run the command. */
  startupDir?: string;
  startupCommand?: string;
  /** Connection options; undefined means the global default. */
  keepAliveSec?: number;
  compression?: boolean;
  connectTimeoutSec?: number;
  /** Terminal appearance overrides for this session; undefined fields use the global setting. */
  terminal?: Partial<TerminalPrefs>;
  /** base64 of safeStorage-encrypted password/passphrase (macOS Keychain-backed). */
  secret?: string;
}

function file(name: string): string {
  const dir = app.getPath('userData');
  mkdirSync(dir, { recursive: true });
  return join(dir, name);
}

function load<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file(name), 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function save(name: string, data: unknown): void {
  writeFileSync(file(name), JSON.stringify(data, null, 2), { mode: 0o600 });
}

export function listProfiles(): Profile[] {
  return load<Profile[]>('sessions.json', []);
}

export function getProfile(id: string): Profile | undefined {
  return listProfiles().find((p) => p.id === id);
}

export function saveProfile(p: Profile, secret?: string): void {
  const all = listProfiles().filter((x) => x.id !== p.id);
  const prev = getProfile(p.id);
  let enc = prev?.secret;
  if (secret) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Keychain encryption is unavailable; secret not saved');
    enc = safeStorage.encryptString(secret).toString('base64');
  }
  all.push({ ...p, secret: enc });
  save('sessions.json', all);
}

export function deleteProfile(id: string): void {
  save('sessions.json', listProfiles().filter((p) => p.id !== id));
}

export function readSecret(p: Profile): string | undefined {
  if (!p.secret) return undefined;
  return safeStorage.decryptString(Buffer.from(p.secret, 'base64'));
}

type KnownHosts = Record<string, string>;

export function knownFingerprint(host: string, port: number): string | undefined {
  return load<KnownHosts>('known_hosts.json', {})[`${host}:${port}`];
}

export function trustHost(host: string, port: number, fingerprint: string): void {
  const all = load<KnownHosts>('known_hosts.json', {});
  all[`${host}:${port}`] = fingerprint;
  save('known_hosts.json', all);
}

export interface Snippet {
  id: string;
  name: string;
  text: string;
  /** Press Enter after inserting the text. Off by default so nothing runs unseen. */
  run: boolean;
}

export function listSnippets(): Snippet[] {
  return load<Snippet[]>('snippets.json', []);
}

export function saveSnippet(s: Snippet): void {
  save('snippets.json', [...listSnippets().filter((x) => x.id !== s.id), s]);
}

export function deleteSnippet(id: string): void {
  save('snippets.json', listSnippets().filter((x) => x.id !== id));
}

export interface Settings {
  /** Look for a newer release on GitHub at startup and every 12 hours. */
  updateCheck: boolean;
  /** A release version the user chose not to be told about again. */
  skippedVersion?: string;
  /** The first-run quick tour was shown and closed (finished or skipped). */
  tourSeen: boolean;
  /** Terminal appearance for every session unless the session overrides it. */
  terminal: TerminalPrefs;
  /** Connection defaults for every session unless the session overrides them. */
  connection: ConnectionPrefs;
}

interface StoredSettings extends Partial<Omit<Settings, 'terminal' | 'connection'>> {
  terminal?: unknown;
  connection?: unknown;
}

export function getSettings(): Settings {
  const stored = load<StoredSettings>('settings.json', {});
  return {
    updateCheck: stored.updateCheck ?? true,
    skippedVersion: stored.skippedVersion,
    tourSeen: stored.tourSeen ?? false,
    terminal: { ...DEFAULT_TERMINAL, ...sanitizeTerminal(stored.terminal) },
    connection: { ...DEFAULT_CONNECTION, ...sanitizeConnection(stored.connection) },
  };
}

/** Merge a change into the saved settings. Terminal and connection values are validated; unknown keys are ignored. */
export function saveSettings(patch: { updateCheck?: boolean; skippedVersion?: string; tourSeen?: boolean; terminal?: unknown; connection?: unknown }): Settings {
  const cur = getSettings();
  const next: Settings = {
    updateCheck: typeof patch.updateCheck === 'boolean' ? patch.updateCheck : cur.updateCheck,
    skippedVersion: 'skippedVersion' in patch ? patch.skippedVersion : cur.skippedVersion,
    tourSeen: typeof patch.tourSeen === 'boolean' ? patch.tourSeen : cur.tourSeen,
    terminal: { ...cur.terminal, ...sanitizeTerminal(patch.terminal) },
    connection: { ...cur.connection, ...sanitizeConnection(patch.connection) },
  };
  save('settings.json', next);
  return next;
}
