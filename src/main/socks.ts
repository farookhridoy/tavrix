/** Minimal SOCKS5 (RFC 1928) server-side parsing: no authentication, CONNECT only. */

export type Step<T> =
  | { state: 'need-more' }
  | { state: 'ok'; value: T; consumed: number }
  | { state: 'error'; reply: number; message: string };

export const REPLY = { ok: 0, failure: 1, notAllowed: 2, hostUnreachable: 4, refused: 5, badCommand: 7, badAddress: 8 } as const;

/** Server reply: version 5, code, reserved, IPv4 0.0.0.0:0 as the bound address. */
export const socksReply = (code: number): Buffer => Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);

export function parseGreeting(buf: Buffer): Step<null> {
  if (buf.length < 2) return { state: 'need-more' };
  if (buf[0] !== 5) return { state: 'error', reply: 0xff, message: 'Not SOCKS5' };
  const end = 2 + buf[1];
  if (buf.length < end) return { state: 'need-more' };
  if (!buf.subarray(2, end).includes(0)) return { state: 'error', reply: 0xff, message: 'No acceptable auth method' };
  return { state: 'ok', value: null, consumed: end };
}

function ipv6(b: Buffer): string {
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(b.readUInt16BE(i).toString(16));
  return groups.join(':');
}

export function parseRequest(buf: Buffer): Step<{ host: string; port: number }> {
  if (buf.length < 5) return { state: 'need-more' };
  if (buf[0] !== 5) return { state: 'error', reply: REPLY.failure, message: 'Not SOCKS5' };
  if (buf[1] !== 1) return { state: 'error', reply: REPLY.badCommand, message: 'Only CONNECT is supported' };
  const atyp = buf[3];
  let host: string;
  let addrEnd: number;
  if (atyp === 1) {
    addrEnd = 4 + 4;
    if (buf.length < addrEnd + 2) return { state: 'need-more' };
    host = [...buf.subarray(4, 8)].join('.');
  } else if (atyp === 3) {
    addrEnd = 5 + buf[4];
    if (buf.length < addrEnd + 2) return { state: 'need-more' };
    host = buf.subarray(5, addrEnd).toString('utf8');
  } else if (atyp === 4) {
    addrEnd = 4 + 16;
    if (buf.length < addrEnd + 2) return { state: 'need-more' };
    host = ipv6(buf.subarray(4, 20));
  } else {
    return { state: 'error', reply: REPLY.badAddress, message: 'Unsupported address type' };
  }
  if (!host) return { state: 'error', reply: REPLY.badAddress, message: 'Empty host' };
  return { state: 'ok', value: { host, port: buf.readUInt16BE(addrEnd) }, consumed: addrEnd + 2 };
}
