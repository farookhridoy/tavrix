export interface ConfigHost {
  alias: string;
  host: string;
  port: number;
  username: string;
  privateKeyPath?: string;
}

/** Parse the concrete (non-wildcard) Host blocks of an OpenSSH client config. */
export function parseSshConfig(text: string, home: string): ConfigHost[] {
  const out: ConfigHost[] = [];
  let aliases: string[] = [];
  let current: Partial<ConfigHost> = {};

  const flush = (): void => {
    for (const alias of aliases) {
      out.push({
        alias,
        host: current.host ?? alias,
        port: current.port ?? 22,
        username: current.username ?? '',
        privateKeyPath: current.privateKeyPath,
      });
    }
    aliases = [];
    current = {};
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(\S+?)(?:\s*=\s*|\s+)(.+)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim().replace(/^"(.*)"$/, '$1');
    if (key === 'host') {
      flush();
      aliases = value.split(/\s+/).filter((a) => !/[*?!]/.test(a));
    } else if (key === 'match') {
      flush();
    } else if (aliases.length) {
      if (key === 'hostname') current.host = value;
      else if (key === 'user') current.username = value;
      else if (key === 'port') current.port = Number(value) || 22;
      else if (key === 'identityfile' && !current.privateKeyPath) {
        current.privateKeyPath = value.replace(/^~(?=\/|$)/, home);
      }
    }
  }
  flush();
  return out;
}
