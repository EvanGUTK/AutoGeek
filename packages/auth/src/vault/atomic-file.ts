import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { err, ok } from '../result.ts';
import type { Result } from '../result.ts';

/** The subset of a `node:fs/promises` FileHandle the writer uses. */
export interface WritableHandle {
  writeFile(data: Uint8Array): Promise<void>;
  chmod(mode: number): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

/** The subset of `node:fs/promises` the writer uses; injected so every step can be failed in tests. */
export interface AtomicWriteFs {
  open(path: string, flags: 'wx' | 'r', mode?: number): Promise<WritableHandle>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
  lstat(path: string): Promise<{ readonly mode: number; isFile(): boolean }>;
}

export interface StaleTempFs {
  readdir(path: string): Promise<string[]>;
  unlink(path: string): Promise<void>;
}

export const WRITE_STEPS = [
  'open_temp',
  'write',
  'chmod',
  'sync',
  'close',
  'rename',
  'sync_dir',
  'verify',
] as const;
export type WriteStep = (typeof WRITE_STEPS)[number];

/**
 * Which step failed, its errno code if the OS gave one, and whether cleaning up the temp file also
 * failed. Never contains the data or a path. A failure at `sync_dir` or `verify` happens AFTER the
 * rename: the new contents are in place but durability or permissions are not confirmed.
 */
export interface AtomicWriteError {
  readonly step: WriteStep;
  readonly errno: string | null;
  readonly cleanupFailed: boolean;
}

export interface AtomicWriteOptions {
  readonly fs: AtomicWriteFs;
  /**
   * POSIX platforms enforce mode 0600 (chmod before rename, verified after) and fsync the directory
   * so the rename is durable. Windows has neither POSIX modes nor directory handles; there the
   * file inherits the per-user ACL of the app's userData directory.
   */
  readonly posix: boolean;
}

const FILE_MODE = 0o600;
const TEMP_SUFFIX_BYTES = 8;

function tempNameFor(target: string): string {
  return `.${basename(target)}.${randomBytes(TEMP_SUFFIX_BYTES).toString('hex')}.tmp`;
}

function errnoOf(thrown: unknown): string | null {
  if (!(thrown instanceof Error)) throw thrown;
  return 'code' in thrown && typeof thrown.code === 'string' ? thrown.code : null;
}

type StepResult = Result<void, { readonly step: WriteStep; readonly errno: string | null }>;

async function attempt(step: WriteStep, run: () => Promise<void>): Promise<StepResult> {
  try {
    await run();
    return ok(undefined);
  } catch (thrown) {
    return err({ step, errno: errnoOf(thrown) });
  }
}

/**
 * Runs a cleanup action after a primary failure, reporting whether it succeeded. Its own errno is
 * not kept: the primary failure is what the caller acts on, and `cleanupFailed` records the rest.
 */
async function cleanedUp(run: () => Promise<void>): Promise<boolean> {
  try {
    await run();
    return true;
  } catch (thrown) {
    errnoOf(thrown);
    return false;
  }
}

async function syncDirectory(fs: AtomicWriteFs, dir: string): Promise<StepResult> {
  let handle: WritableHandle;
  try {
    handle = await fs.open(dir, 'r');
  } catch (thrown) {
    return err({ step: 'sync_dir', errno: errnoOf(thrown) });
  }
  const synced = await attempt('sync_dir', () => handle.sync());
  const closed = await attempt('sync_dir', () => handle.close());
  return synced.ok ? closed : synced;
}

async function verifyTarget(
  fs: AtomicWriteFs,
  target: string,
  posix: boolean,
): Promise<StepResult> {
  let stats: { readonly mode: number; isFile(): boolean };
  try {
    stats = await fs.lstat(target);
  } catch (thrown) {
    return err({ step: 'verify', errno: errnoOf(thrown) });
  }
  const modeOk = !posix || (stats.mode & 0o777) === FILE_MODE;
  return stats.isFile() && modeOk ? ok(undefined) : err({ step: 'verify', errno: null });
}

/**
 * Replaces `target` with `data` so that a crash at any point leaves either the old file or the new
 * one, never a mix: write a temp file in the same directory (O_CREAT|O_EXCL, mode 0600), fsync it,
 * rename it over the target, then fsync the directory. A symlink at `target` is replaced, never
 * written through.
 *
 * Callers must serialize writes to the same target.
 */
export async function writeFileAtomic(
  target: string,
  data: Uint8Array,
  options: AtomicWriteOptions,
): Promise<Result<void, AtomicWriteError>> {
  const { fs, posix } = options;
  const dir = dirname(target);
  const temp = join(dir, tempNameFor(target));

  let handle: WritableHandle;
  try {
    handle = await fs.open(temp, 'wx', FILE_MODE);
  } catch (thrown) {
    return err({ step: 'open_temp', errno: errnoOf(thrown), cleanupFailed: false });
  }

  const steps: readonly (readonly [WriteStep, () => Promise<void>])[] = [
    ['write', () => handle.writeFile(data)],
    ...(posix ? [['chmod', () => handle.chmod(FILE_MODE)] as const] : []),
    ['sync', () => handle.sync()],
  ];
  for (const [step, run] of steps) {
    const result = await attempt(step, run);
    if (!result.ok) {
      const closed = await cleanedUp(() => handle.close());
      const unlinked = await cleanedUp(() => fs.unlink(temp));
      return err({ ...result.error, cleanupFailed: !(closed && unlinked) });
    }
  }

  for (const [step, run] of [
    ['close', () => handle.close()],
    ['rename', () => fs.rename(temp, target)],
  ] as const) {
    const result = await attempt(step, run);
    if (!result.ok) {
      const unlinked = await cleanedUp(() => fs.unlink(temp));
      return err({ ...result.error, cleanupFailed: !unlinked });
    }
  }

  if (posix) {
    const synced = await syncDirectory(fs, dir);
    if (!synced.ok) return err({ ...synced.error, cleanupFailed: false });
  }
  const verified = await verifyTarget(fs, target, posix);
  if (!verified.ok) return err({ ...verified.error, cleanupFailed: false });
  return ok(undefined);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Deletes temp files a crashed `writeFileAtomic` left next to `target`, returning how many were
 * removed. Call it before the first write, while no write to `target` is in flight.
 */
export async function removeStaleTemps(
  target: string,
  fs: StaleTempFs,
): Promise<Result<number, { readonly errno: string | null }>> {
  const dir = dirname(target);
  const pattern = new RegExp(
    `^\\.${escapeRegExp(basename(target))}\\.[0-9a-f]{${String(TEMP_SUFFIX_BYTES * 2)}}\\.tmp$`,
  );
  try {
    const stale = (await fs.readdir(dir)).filter((name) => pattern.test(name));
    for (const name of stale) await fs.unlink(join(dir, name));
    return ok(stale.length);
  } catch (thrown) {
    return err({ errno: errnoOf(thrown) });
  }
}
