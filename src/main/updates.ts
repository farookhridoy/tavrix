/** Update check against this project's GitHub Releases. Pure logic: no Electron imports, fetch is injected. */

export const REPO = 'farookhridoy/tavrix';
export const FEED_URL = `https://api.github.com/repos/${REPO}/releases/latest`;

export interface UpdateInfo {
  current: string;
  latest: string;
  releaseUrl: string;
  /** Direct link to the installer for this computer (macOS .dmg or Windows .exe) when the release has one. */
  downloadUrl?: string;
  notes: string;
}

export type UpdateResult =
  | { kind: 'available'; info: UpdateInfo }
  | { kind: 'current'; current: string; latest: string }
  | { kind: 'none' } // no release published yet
  | { kind: 'error'; message: string };

export type Version = [number, number, number];

/** Strict x.y.z with an optional leading "v"; anything else (nightly, 1.2, 1.2.3-beta) is not a release. */
export function parseVersion(text: string): Version | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** True when `a` is a later version than `b`. */
export function isNewer(a: Version, b: Version): boolean {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** Only links into this repository on github.com are ever opened, whatever the feed says. */
export function isTrustedUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && u.hostname === 'github.com' && !u.username && !u.password && u.pathname.startsWith(`/${REPO}/`);
  } catch {
    return false;
  }
}

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

interface Asset {
  name?: unknown;
  browser_download_url?: unknown;
}

/**
 * The installer for this computer: a .dmg on macOS, an .exe on Windows. Prefer the one built for this CPU
 * ('arm64' | 'x64'), then a universal one, then any of the right kind.
 */
export function pickInstaller(assets: unknown, arch: string, platform: string = process.platform): string | undefined {
  if (!Array.isArray(assets)) return undefined;
  const ext = platform === 'win32' ? 'exe' : 'dmg';
  const files = (assets as Asset[]).filter((a) => typeof a?.name === 'string' && new RegExp(`\\.${ext}$`, 'i').test(a.name) && isTrustedUrl(a.browser_download_url));
  const named = (re: RegExp) => files.find((a) => re.test(a.name as string));
  const best = named(new RegExp(`[-_.]${arch}\\.${ext}$`, 'i')) ?? named(/universal/i) ?? files[0];
  return best?.browser_download_url as string | undefined;
}

export async function checkForUpdate(
  current: string,
  fetchImpl: FetchLike,
  url: string = FEED_URL,
  timeoutMs = 8000,
  arch: string = process.arch,
  platform: string = process.platform,
): Promise<UpdateResult> {
  const have = parseVersion(current);
  if (!have) return { kind: 'error', message: `This build has an unrecognised version (${current})` };
  let res;
  try {
    res = await fetchImpl(url, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Tavrix/${current}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { kind: 'error', message: `Could not reach GitHub: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (res.status === 404) return { kind: 'none' };
  if (!res.ok) return { kind: 'error', message: res.status === 403 ? 'GitHub is rate limiting update checks; try again later' : `GitHub answered ${res.status}` };

  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    return { kind: 'error', message: 'GitHub sent a reply that is not valid JSON' };
  }
  const tag = typeof body?.tag_name === 'string' ? body.tag_name : '';
  const latest = parseVersion(tag);
  if (!latest) return { kind: 'error', message: `The latest release has an unrecognised version tag (${tag || 'missing'})` };
  if (!isNewer(latest, have)) return { kind: 'current', current, latest: latest.join('.') };
  if (!isTrustedUrl(body.html_url)) return { kind: 'error', message: 'The latest release points somewhere other than this project; ignoring it' };
  return {
    kind: 'available',
    info: {
      current,
      latest: latest.join('.'),
      releaseUrl: body.html_url,
      downloadUrl: pickInstaller(body.assets, arch, platform),
      notes: typeof body.body === 'string' ? body.body.slice(0, 1500) : '',
    },
  };
}

/** The URL to open for a banner button, or null if there is nothing safe to open. */
export function openTarget(info: UpdateInfo | null, kind: 'download' | 'notes'): string | null {
  if (!info) return null;
  const url = kind === 'download' ? (info.downloadUrl ?? info.releaseUrl) : info.releaseUrl;
  return isTrustedUrl(url) ? url : null;
}
