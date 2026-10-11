import { constants } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { err, ok } from '../result.ts';
import type { Result } from '../result.ts';
import { errnoOf, removeStaleTemps, writeFileAtomic } from './atomic-file.ts';
import type { AtomicWriteFs, StaleTempFs, WriteStep } from './atomic-file.ts';
import { createDataKey, openEnvelope, sealEnvelope } from './envelope.ts';
import type { DataKey } from './envelope.ts';
import type { SecretCipher } from './secret-cipher.ts';

/** A real vault is a few KiB; anything this large is not ours and is not read into memory. */
const MAX_STORE_BYTES = 16 * 1024 * 1024;

export interface ReadableHandle {
  stat(): Promise<{ readonly size: number; isFile(): boolean }>;
  readFile(): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface VaultFs extends AtomicWriteFs, StaleTempFs {
  /** Opens for reading without following a symlink at `path` (O_NOFOLLOW where supported). */
  openNoFollow(path: string): Promise<ReadableHandle>;
}

/** The production `VaultFs` over `node:fs/promises`. */
export function nodeVaultFs(options: { readonly posix: boolean }): VaultFs {
  const readFlags = constants.O_RDONLY | (options.posix ? constants.O_NOFOLLOW : 0);
  return {
    open: (path, flags, mode) => fsp.open(path, flags, mode),
    openNoFollow: (path) => fsp.open(path, readFlags),
    rename: (from, to) => fsp.rename(from, to),
    unlink: (path) => fsp.unlink(path),
    lstat: (path) => fsp.lstat(path),
    readdir: (path) => fsp.readdir(path),
  };
}

export type StoreCorruptReason =
  | 'malformed'
  | 'unsupported_version'
  | 'unwrap_failed'
  | 'auth_failed'
  | 'not_a_regular_file'
  | 'too_large';

export type StoreError =
  | { readonly kind: 'insecure_backend' }
  | { readonly kind: 'encryption_unavailable' }
  | { readonly kind: 'store_corrupt'; readonly reason: StoreCorruptReason }
  | {
      readonly kind: 'store_io';
      readonly step: WriteStep | 'read' | 'reset';
      readonly errno: string | null;
    };

/**
 * The vault's encrypted file. Bytes in, bytes out: the document format belongs to the caller.
 *
 * Fail-closed rules:
 * - `write` is allowed only after the most recent `read` succeeded. After a corrupt, unreadable
 *   or keychain-refused read, writes are refused, so a store that might still be recoverable
 *   (for example while the keychain is locked) is never overwritten.
 * - `reset` is the only way past a corrupt store. It moves the file aside instead of deleting it,
 *   and it is allowed only after a read reported `store_corrupt`.
 * All operations run one at a time, in call order.
 */
export interface EncryptedFile {
  /** The stored plaintext, or null when no store exists yet. */
  read(): Promise<Result<Uint8Array | null, StoreError>>;
  write(plaintext: Uint8Array): Promise<Result<void, StoreError>>;
  reset(): Promise<Result<void, StoreError>>;
}

export interface EncryptedFileOptions {
  readonly path: string;
  readonly cipher: SecretCipher;
  readonly fs: VaultFs;
  readonly posix: boolean;
  readonly now: () => Date;
}

type State =
  | { readonly type: 'unread' }
  | { readonly type: 'refused' }
  | { readonly type: 'corrupt' }
  | { readonly type: 'empty' }
  | { readonly type: 'open'; readonly dataKey: DataKey };

const corrupt = (reason: StoreCorruptReason): StoreError => ({ kind: 'store_corrupt', reason });

async function readBlob(fs: VaultFs, path: string): Promise<Result<Uint8Array | null, StoreError>> {
  let handle: ReadableHandle;
  try {
    handle = await fs.openNoFollow(path);
  } catch (thrown) {
    const errno = errnoOf(thrown);
    if (errno === 'ENOENT') return ok(null);
    if (errno === 'ELOOP') return err(corrupt('not_a_regular_file'));
    return err({ kind: 'store_io', step: 'read', errno });
  }
  let result: Result<Uint8Array, StoreError>;
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) result = err(corrupt('not_a_regular_file'));
    else if (stats.size > MAX_STORE_BYTES) result = err(corrupt('too_large'));
    else result = ok(await handle.readFile());
  } catch (thrown) {
    result = err({ kind: 'store_io', step: 'read', errno: errnoOf(thrown) });
  }
  try {
    await handle.close();
  } catch (thrown) {
    const errno = errnoOf(thrown);
    if (result.ok) result = err({ kind: 'store_io', step: 'read', errno });
  }
  return result;
}

function backendError(
  error: 'insecure_backend' | 'encryption_unavailable' | 'wrap_failed',
): StoreError {
  // The keychain refusing to wrap a key is, to the user, the same as it being unavailable.
  return { kind: error === 'insecure_backend' ? 'insecure_backend' : 'encryption_unavailable' };
}

function compactTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, '');
}

export function createEncryptedFile(options: EncryptedFileOptions): EncryptedFile {
  const { path, cipher, fs, posix, now } = options;
  let state: State = { type: 'unread' };
  let staleTempsChecked = false;
  let tail: Promise<unknown> = Promise.resolve();

  /** Runs `op` after every earlier operation has finished, whatever their outcome. */
  function serialized<T>(op: () => Promise<T>): Promise<T> {
    const next = tail.then(op, op);
    // The queue only orders operations; each caller still receives its own outcome via `next`.
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async function read(): Promise<Result<Uint8Array | null, StoreError>> {
    if (!staleTempsChecked) {
      const cleaned = await removeStaleTemps(path, fs);
      if (!cleaned.ok) {
        state = { type: 'refused' };
        return err({ kind: 'store_io', step: 'read', errno: cleaned.error.errno });
      }
      staleTempsChecked = true;
    }
    const blob = await readBlob(fs, path);
    if (!blob.ok) {
      state = blob.error.kind === 'store_corrupt' ? { type: 'corrupt' } : { type: 'refused' };
      return blob;
    }
    if (blob.value === null) {
      state = { type: 'empty' };
      return ok(null);
    }
    const opened = openEnvelope(blob.value, cipher);
    if (!opened.ok) {
      switch (opened.error) {
        case 'insecure_backend':
        case 'encryption_unavailable':
          state = { type: 'refused' };
          return err({ kind: opened.error });
        case 'malformed':
        case 'unsupported_version':
        case 'unwrap_failed':
        case 'auth_failed':
          state = { type: 'corrupt' };
          return err(corrupt(opened.error));
      }
    }
    state = { type: 'open', dataKey: opened.value.dataKey };
    return ok(opened.value.plaintext);
  }

  async function write(plaintext: Uint8Array): Promise<Result<void, StoreError>> {
    let dataKey: DataKey;
    switch (state.type) {
      case 'open':
        dataKey = state.dataKey;
        break;
      case 'empty': {
        const created = createDataKey(cipher);
        if (!created.ok) return err(backendError(created.error));
        dataKey = created.value;
        break;
      }
      case 'unread':
      case 'refused':
      case 'corrupt':
        throw new Error('write() requires the most recent read() to have succeeded');
    }
    const written = await writeFileAtomic(path, sealEnvelope(plaintext, dataKey), { fs, posix });
    if (!written.ok) {
      return err({ kind: 'store_io', step: written.error.step, errno: written.error.errno });
    }
    state = { type: 'open', dataKey };
    return ok(undefined);
  }

  async function reset(): Promise<Result<void, StoreError>> {
    if (state.type !== 'corrupt') {
      throw new Error('reset() is only allowed after read() reported store_corrupt');
    }
    try {
      await fs.rename(path, `${path}.corrupt-${compactTimestamp(now())}`);
    } catch (thrown) {
      const errno = errnoOf(thrown);
      if (errno !== 'ENOENT') return err({ kind: 'store_io', step: 'reset', errno });
    }
    state = { type: 'empty' };
    return ok(undefined);
  }

  return {
    read: () => serialized(read),
    write: (plaintext) => serialized(() => write(plaintext)),
    reset: () => serialized(reset),
  };
}
