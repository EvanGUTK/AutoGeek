import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { err, ok } from '../result.ts';
import type { Result } from '../result.ts';
import { createEncryptedFile, nodeVaultFs } from './encrypted-file.ts';
import type { EncryptedFile, VaultFs } from './encrypted-file.ts';
import type { CipherBackend, SecretCipher } from './secret-cipher.ts';

/** Minimal stand-in for safeStorage: a tagged reversible wrap whose backend can be switched. */
function switchableCipher(): SecretCipher & {
  setBackend(b: CipherBackend): void;
  breakUnwrap(): void;
} {
  let backend: CipherBackend = 'os_keychain';
  let unwrapBroken = false;
  const TAG = Buffer.from('wrapped:');
  return {
    backend: () => backend,
    setBackend(next) {
      backend = next;
    },
    breakUnwrap() {
      unwrapBroken = true;
    },
    wrap: (key): Result<Uint8Array, 'wrap_failed'> => ok(Buffer.concat([TAG, key])),
    unwrap(wrapped): Result<Uint8Array, 'unwrap_failed'> {
      const buf = Buffer.from(wrapped);
      if (unwrapBroken || !buf.subarray(0, TAG.length).equals(TAG)) return err('unwrap_failed');
      return ok(buf.subarray(TAG.length));
    },
  };
}

let dir: string;
let path: string;
let cipher: ReturnType<typeof switchableCipher>;
const fs = nodeVaultFs({ posix: true });

function store(
  overrides: { readonly fs?: VaultFs; readonly now?: () => Date } = {},
): EncryptedFile {
  return createEncryptedFile({
    path,
    cipher,
    fs: overrides.fs ?? fs,
    posix: true,
    now: overrides.now ?? (() => new Date('2026-10-11T12:34:56.789Z')),
  });
}

beforeEach(async () => {
  dir = await fsp.mkdtemp(join(tmpdir(), 'ag-auth-store-'));
  path = join(dir, 'credentials.v1.bin');
  cipher = switchableCipher();
});

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

const DOC = Buffer.from('{"v":1,"credentials":[]}');
const DOC2 = Buffer.from('{"v":1,"credentials":[{"id":"cred_x"}]}');

async function readOk(file: EncryptedFile): Promise<Uint8Array | null> {
  const result = await file.read();
  if (!result.ok) throw new Error(`read failed: ${JSON.stringify(result.error)}`);
  return result.value;
}

describe('createEncryptedFile', () => {
  it('reads null when no store exists yet, then writes and reads back', async () => {
    const file = store();
    expect(await readOk(file)).toBeNull();
    expect(await file.write(DOC)).toEqual(ok(undefined));
    expect(Buffer.from((await readOk(store())) ?? [])).toEqual(DOC);
    expect((await fsp.stat(path)).mode & 0o777).toBe(0o600);
  });

  it('keeps the data key across writes and re-reads', async () => {
    const file = store();
    await readOk(file);
    await file.write(DOC);
    await file.write(DOC2);
    const header = (await fsp.readFile(path)).subarray(0, 40);
    const reopened = store();
    expect(Buffer.from((await readOk(reopened)) ?? [])).toEqual(DOC2);
    await reopened.write(DOC);
    expect((await fsp.readFile(path)).subarray(0, 40)).toEqual(header);
  });

  it('refuses to write before a successful read (programmer error)', async () => {
    await expect(store().write(DOC)).rejects.toThrow(/read/);
  });

  it('removes temp files a crashed write left behind when first read', async () => {
    await fsp.writeFile(join(dir, '.credentials.v1.bin.0123456789abcdef.tmp'), 'partial');
    await readOk(store());
    expect(await fsp.readdir(dir)).toEqual([]);
  });

  describe('fails closed', () => {
    async function corrupt(mutate: (blob: Buffer) => Buffer): Promise<void> {
      const file = store();
      await readOk(file);
      await file.write(DOC);
      await fsp.writeFile(path, mutate(await fsp.readFile(path)), { mode: 0o600 });
    }

    it.each([
      [
        'a flipped ciphertext byte',
        (b: Buffer) => Buffer.concat([b.subarray(0, -1), Buffer.from([(b.at(-1) ?? 0) ^ 1])]),
        'auth_failed',
      ],
      ['a truncated file', (b: Buffer) => b.subarray(0, 10), 'malformed'],
      ['garbage', () => Buffer.from('not a vault'), 'malformed'],
      ['an empty file', () => Buffer.alloc(0), 'malformed'],
      [
        'a future version',
        (b: Buffer) => Buffer.concat([b.subarray(0, 4), Buffer.from([9]), b.subarray(5)]),
        'unsupported_version',
      ],
    ] as const)('reports %s as store_corrupt and refuses writes', async (_name, mutate, reason) => {
      await corrupt(mutate);
      const before = await fsp.readFile(path);
      const file = store();
      expect(await file.read()).toEqual(err({ kind: 'store_corrupt', reason }));
      await expect(file.write(DOC2)).rejects.toThrow(/read/);
      expect(await fsp.readFile(path)).toEqual(before);
    });

    it('reports a key the keychain cannot unwrap as store_corrupt', async () => {
      await corrupt((b) => b);
      cipher.breakUnwrap();
      expect(await store().read()).toEqual(err({ kind: 'store_corrupt', reason: 'unwrap_failed' }));
    });

    it('reports a symlink at the store path as store_corrupt without following it', async () => {
      const elsewhere = join(dir, 'elsewhere.bin');
      await fsp.writeFile(elsewhere, 'x');
      await fsp.symlink(elsewhere, path);
      expect(await store().read()).toEqual(
        err({ kind: 'store_corrupt', reason: 'not_a_regular_file' }),
      );
    });

    it('reports a directory at the store path as store_corrupt', async () => {
      await fsp.mkdir(path);
      expect(await store().read()).toEqual(
        err({ kind: 'store_corrupt', reason: 'not_a_regular_file' }),
      );
    });

    it('reports an oversized file as store_corrupt without reading it', async () => {
      const handle = await fsp.open(path, 'w', 0o600);
      await handle.truncate(17 * 1024 * 1024);
      await handle.close();
      expect(await store().read()).toEqual(err({ kind: 'store_corrupt', reason: 'too_large' }));
    });

    it.each([
      ['basic_text', 'insecure_backend'],
      ['unavailable', 'encryption_unavailable'],
    ] as const)('refuses to read or create a store on %s', async (backend, kind) => {
      await corrupt((b) => b);
      cipher.setBackend(backend);
      const refused = store();
      const before = await fsp.readFile(path);
      expect(await refused.read()).toEqual(err({ kind }));
      await expect(refused.write(DOC2)).rejects.toThrow(/read/);
      expect(await fsp.readFile(path)).toEqual(before);
      await fsp.rm(path);
      const fresh = store();
      expect(await fresh.read()).toEqual(ok(null));
      expect(await fresh.write(DOC)).toEqual(err({ kind }));
      expect(await fsp.readdir(dir)).toEqual([]);
    });

    it('allows writes again after a later read succeeds', async () => {
      await corrupt((b) => b);
      cipher.setBackend('unavailable');
      const file = store();
      expect((await file.read()).ok).toBe(false);
      cipher.setBackend('os_keychain');
      expect((await file.read()).ok).toBe(true);
      expect(await file.write(DOC2)).toEqual(ok(undefined));
    });
  });

  describe('reset', () => {
    it('moves a corrupt store aside and starts empty', async () => {
      await fsp.writeFile(path, 'garbage', { mode: 0o600 });
      const file = store();
      expect((await file.read()).ok).toBe(false);
      expect(await file.reset()).toEqual(ok(undefined));
      expect(await fsp.readdir(dir)).toEqual(['credentials.v1.bin.corrupt-20261011T123456789Z']);
      expect(await file.read()).toEqual(ok(null));
      expect(await file.write(DOC)).toEqual(ok(undefined));
    });

    it('refuses to reset after a transient read I/O failure', async () => {
      const healthy = store();
      await readOk(healthy);
      await healthy.write(DOC);
      const flaky: VaultFs = {
        ...fs,
        openNoFollow: () => Promise.reject(Object.assign(new Error('injected'), { code: 'EIO' })),
      };
      const file = store({ fs: flaky });
      expect(await file.read()).toEqual(err({ kind: 'store_io', step: 'read', errno: 'EIO' }));
      await expect(file.reset()).rejects.toThrow(/corrupt/);
      await expect(file.write(DOC2)).rejects.toThrow(/read/);
      expect(Buffer.from((await readOk(store())) ?? [])).toEqual(DOC);
    });

    it('refuses to reset a store that is not known to be corrupt', async () => {
      const file = store();
      await readOk(file);
      await file.write(DOC);
      await expect(file.reset()).rejects.toThrow(/corrupt/);
      expect(Buffer.from((await readOk(store())) ?? [])).toEqual(DOC);
    });
  });

  it('reports an I/O failure during write as store_io and keeps the old store', async () => {
    const file = store();
    await readOk(file);
    await file.write(DOC);
    const failing: VaultFs = {
      ...fs,
      rename: () => Promise.reject(Object.assign(new Error('injected'), { code: 'ENOSPC' })),
    };
    const second = store({ fs: failing });
    await readOk(second);
    expect(await second.write(DOC2)).toEqual(
      err({ kind: 'store_io', step: 'rename', errno: 'ENOSPC' }),
    );
    expect(Buffer.from((await readOk(store())) ?? [])).toEqual(DOC);
  });

  it('serializes concurrent writes in call order', async () => {
    // Earlier renames are slower, so any overlap would let an earlier write land last.
    let renames = 0;
    const slowFirst: VaultFs = {
      ...fs,
      rename: async (from, to) => {
        renames += 1;
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, 40 - renames * 2)));
        await fs.rename(from, to);
      },
    };
    const file = store({ fs: slowFirst });
    await readOk(file);
    const docs = Array.from({ length: 20 }, (_, i) => Buffer.from(`{"n":${String(i)}}`));
    const results = await Promise.all(docs.map((doc) => file.write(doc)));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(Buffer.from((await readOk(store())) ?? [])).toEqual(docs.at(-1));
    expect(await fsp.readdir(dir)).toEqual(['credentials.v1.bin']);
  });
});
