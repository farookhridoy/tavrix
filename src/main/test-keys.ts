import { utils } from 'ssh2';

type KeyPair = { public: string; private: string };

/**
 * A throwaway key pair for tests. ssh2's generator occasionally (about 0.4% of the time) writes an ed25519 key that it
 * cannot read back ("Malformed OpenSSH private key"), which made tests fail at random. Every key is read back here, and a
 * bad one is simply replaced.
 */
export function makeKeyPair(opts?: { passphrase?: string; cipher?: string; rounds?: number }): KeyPair {
  for (let attempt = 0; attempt < 50; attempt++) {
    const pair = (opts ? utils.generateKeyPairSync('ed25519', opts as never) : utils.generateKeyPairSync('ed25519')) as KeyPair;
    if (!(utils.parseKey(pair.private, opts?.passphrase) instanceof Error)) return pair;
  }
  throw new Error('Could not generate a readable test key');
}
