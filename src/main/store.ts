import { app, safeStorage } from 'electron';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

export interface Profile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  privateKeyPath?: string;
  /** Saved session to pass through first (ProxyJump). */
  jumpHostId?: string;
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
}

export function getSettings(): Settings {
  return { updateCheck: true, ...load<Partial<Settings>>('settings.json', {}) };
}

export function saveSettings(patch: Partial<Settings>): void {
  save('settings.json', { ...getSettings(), ...patch });
}
