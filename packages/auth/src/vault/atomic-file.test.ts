import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WRITE_STEPS, removeStaleTemps, writeFileAtomic } from './atomic-file.ts';
import type { AtomicWriteFs, WritableHandle, WriteStep } from './atomic-file.ts';

const OLD = Buffer.from('old store contents');
const NEW = Buffer.from('new store contents');

let dir: string;
let target: string;

beforeEach(async () => {
  dir = await fsp.mkdtemp(join(tmpdir(), 'ag-auth-atomic-'));
  target = join(dir, 'credentials.v1.bin');
});

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

async function entries(): Promise<string[]> {
  return (await fsp.readdir(dir)).sort();
}

function errnoError(code: string): Error {
  return Object.assign(new Error(`injected ${code}`), { code });
}

/**
 * Wraps the real fs and injects a failure at `failAt`. `crash` additionally makes every later
 * call fail, as if the process died at that point (no cleanup runs).
 */
function faultyFs(failAt: WriteStep, behavior: 'throw' | 'crash'): AtomicWriteFs {
  let crashed = false;
  const gate = async <T>(step: WriteStep | null, run: () => Promise<T>): Promise<T> => {
    if (crashed) throw errnoError('ECRASHED');
    if (step === failAt) {
      if (behavior === 'crash') crashed = true;
      throw errnoError('EIO');
    }
    return run();
  };
  const wrapHandle = (handle: WritableHandle, isDir: boolean): WritableHandle => ({
    writeFile: (data) => gate('write', () => handle.writeFile(data)),
    chmod: (mode) => gate('chmod', () => handle.chmod(mode)),
    sync: () => gate(isDir ? 'sync_dir' : 'sync', () => handle.sync()),
    close: () => gate(isDir ? null : 'close', () => handle.close()),
  });
  return {
    open: async (path, flags, mode) => {
      const isDir = flags === 'r';
      const handle = await gate(isDir ? null : 'open_temp', () => fsp.open(path, flags, mode));
      return wrapHandle(handle, isDir);
    },
    rename: (from, to) => gate('rename', () => fsp.rename(from, to)),
    unlink: (path) => gate(null, () => fsp.unlink(path)),
    lstat: (path) => gate('verify', () => fsp.lstat(path)),
  };
}

describe('writeFileAtomic', () => {
  it('creates the file with the data and mode 0600', async () => {
    expect(await writeFileAtomic(target, NEW, { fs: fsp, posix: true })).toEqual({
      ok: true,
      value: undefined,
    });
    expect(await fsp.readFile(target)).toEqual(NEW);
    expect((await fsp.stat(target)).mode & 0o777).toBe(0o600);
    expect(await entries()).toEqual(['credentials.v1.bin']);
  });

  it('replaces an existing file and tightens a loose mode to 0600', async () => {
    await fsp.writeFile(target, OLD, { mode: 0o644 });
    await fsp.chmod(target, 0o644);
    expect((await writeFileAtomic(target, NEW, { fs: fsp, posix: true })).ok).toBe(true);
    expect(await fsp.readFile(target)).toEqual(NEW);
    expect((await fsp.stat(target)).mode & 0o777).toBe(0o600);
    expect(await entries()).toEqual(['credentials.v1.bin']);
  });

  it('ends at 0600 even under a umask that strips the owner write bit', async () => {
    const previous = process.umask(0o277);
    try {
      expect((await writeFileAtomic(target, NEW, { fs: fsp, posix: true })).ok).toBe(true);
    } finally {
      process.umask(previous);
    }
    expect((await fsp.stat(target)).mode & 0o777).toBe(0o600);
  });

  it('replaces a symlink at the target instead of writing through it', async () => {
    const elsewhere = join(dir, 'elsewhere.txt');
    await fsp.writeFile(elsewhere, OLD);
    await fsp.symlink(elsewhere, target);
    expect((await writeFileAtomic(target, NEW, { fs: fsp, posix: true })).ok).toBe(true);
    expect((await fsp.lstat(target)).isFile()).toBe(true);
    expect(await fsp.readFile(target)).toEqual(NEW);
    expect(await fsp.readFile(elsewhere)).toEqual(OLD);
  });

  function recordingFs(calls: string[]): AtomicWriteFs {
    return {
      open: async (path, flags, mode) => {
        const kind = flags === 'r' ? 'dir' : 'temp';
        calls.push(`open:${kind}:${flags}:${mode === undefined ? '-' : mode.toString(8)}`);
        const handle = await fsp.open(path, flags, mode);
        const record =
          <A extends unknown[]>(name: string, run: (...args: A) => Promise<void>) =>
          (...args: A) => {
            calls.push(`${name}:${kind}`);
            return run(...args);
          };
        return {
          writeFile: record('writeFile', (data: Uint8Array) => handle.writeFile(data)),
          chmod: record('chmod', (m: number) => handle.chmod(m)),
          sync: record('sync', () => handle.sync()),
          close: record('close', () => handle.close()),
        };
      },
      rename: (from, to) => {
        calls.push('rename');
        return fsp.rename(from, to);
      },
      unlink: (path) => {
        calls.push('unlink');
        return fsp.unlink(path);
      },
      lstat: (path) => {
        calls.push('lstat');
        return fsp.lstat(path);
      },
    };
  }

  it('performs the POSIX steps in a crash-safe order with an exclusive 0600 create', async () => {
    const calls: string[] = [];
    expect((await writeFileAtomic(target, NEW, { fs: recordingFs(calls), posix: true })).ok).toBe(
      true,
    );
    expect(calls).toEqual([
      'open:temp:wx:600',
      'writeFile:temp',
      'chmod:temp',
      'sync:temp',
      'close:temp',
      'rename',
      'open:dir:r:-',
      'sync:dir',
      'close:dir',
      'lstat',
    ]);
  });

  it('skips chmod and directory sync when posix is false', async () => {
    const calls: string[] = [];
    expect((await writeFileAtomic(target, NEW, { fs: recordingFs(calls), posix: false })).ok).toBe(
      true,
    );
    expect(calls).toEqual([
      'open:temp:wx:600',
      'writeFile:temp',
      'sync:temp',
      'close:temp',
      'rename',
      'lstat',
    ]);
    expect(await fsp.readFile(target)).toEqual(NEW);
  });

  describe.each(['throw', 'crash'] as const)('when a step fails (%s)', (behavior) => {
    const beforeRename = WRITE_STEPS.slice(0, WRITE_STEPS.indexOf('rename') + 1);

    it.each(beforeRename)('at %s, the old file is intact', async (step) => {
      await fsp.writeFile(target, OLD, { mode: 0o600 });
      const result = await writeFileAtomic(target, NEW, {
        fs: faultyFs(step, behavior),
        posix: true,
      });
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.step).toBe(step);
      expect(!result.ok && result.error.errno).toBe('EIO');
      expect(await fsp.readFile(target)).toEqual(OLD);
      if (behavior === 'throw') {
        expect(!result.ok && result.error.cleanupFailed).toBe(false);
        expect(await entries()).toEqual(['credentials.v1.bin']);
      } else {
        expect(!result.ok && result.error.cleanupFailed).toBe(step !== 'open_temp');
        expect((await removeStaleTemps(target, fsp)).ok).toBe(true);
        expect(await entries()).toEqual(['credentials.v1.bin']);
      }
    });

    it.each(['sync_dir', 'verify'] as const)(
      'at %s, the new file is in place and the failure is reported',
      async (step) => {
        await fsp.writeFile(target, OLD, { mode: 0o600 });
        const result = await writeFileAtomic(target, NEW, {
          fs: faultyFs(step, behavior),
          posix: true,
        });
        expect(!result.ok && result.error.step).toBe(step);
        expect(await fsp.readFile(target)).toEqual(NEW);
        expect(await entries()).toEqual(['credentials.v1.bin']);
      },
    );
  });

  it('reports verify when the file ends up with a mode other than 0600', async () => {
    const loose: AtomicWriteFs = {
      open: async (path, flags, mode) => {
        const handle = await fsp.open(path, flags, mode);
        return {
          writeFile: (data) => handle.writeFile(data),
          chmod: () => handle.chmod(0o644),
          sync: () => handle.sync(),
          close: () => handle.close(),
        };
      },
      rename: (from, to) => fsp.rename(from, to),
      unlink: (path) => fsp.unlink(path),
      lstat: (path) => fsp.lstat(path),
    };
    const result = await writeFileAtomic(target, NEW, { fs: loose, posix: true });
    expect(result).toEqual({
      ok: false,
      error: { step: 'verify', errno: null, cleanupFailed: false },
    });
  });

  it('never puts the data or the path in the error', async () => {
    const result = await writeFileAtomic(target, NEW, {
      fs: faultyFs('write', 'throw'),
      posix: true,
    });
    expect(JSON.stringify(result)).not.toContain('new store contents');
    expect(JSON.stringify(result)).not.toContain(dir);
  });
});

describe('removeStaleTemps', () => {
  it('removes only temp files belonging to the target', async () => {
    await fsp.writeFile(target, OLD);
    const stale = '.credentials.v1.bin.0123456789abcdef.tmp';
    const keep = [
      '.credentials.v1.bin.0123456789abcdef.tmp.extra',
      '.other.bin.0123456789abcdef.tmp',
      '.credentials.v1.bin.xyz.tmp',
      'notes.txt',
    ];
    await fsp.writeFile(join(dir, stale), NEW);
    for (const name of keep) await fsp.writeFile(join(dir, name), NEW);
    expect(await removeStaleTemps(target, fsp)).toEqual({ ok: true, value: 1 });
    expect(await entries()).toEqual(['credentials.v1.bin', ...keep].sort());
  });

  it('treats a base name with regex metacharacters literally', async () => {
    const odd = join(dir, 'a+b.bin');
    await fsp.writeFile(join(dir, '.aab.bin.0123456789abcdef.tmp'), NEW);
    expect(await removeStaleTemps(odd, fsp)).toEqual({ ok: true, value: 0 });
  });
});
