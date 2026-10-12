import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ERROR_MESSAGES } from '@autogeek/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CONTAINMENT_REASONS,
  isInside,
  openContainmentRoot,
  probeCaseInsensitive,
  resolveContained,
  type ContainedPath,
  type ContainmentMode,
  type ContainmentReason,
  type ContainmentRoot,
} from './containment.ts';

/**
 * Real-filesystem tests for the containment stage (docs/workspace-path-cases.md section 3-4).
 * The temp base is reached through a symlink on macOS (/var -> /private/var), which is row 3.14
 * for free; the root itself is also opened through an explicit link below.
 */

interface Fixture {
  readonly base: string;
  /** The root exactly as a caller would spell it (through the temp symlink on macOS). */
  readonly rootSpelling: string;
  readonly outside: string;
  readonly root: ContainmentRoot;
}

let fixture: Fixture;

async function fresh(): Promise<Fixture> {
  const base = await mkdtemp(path.join(tmpdir(), 'ag-contain-'));
  const rootSpelling = path.join(base, 'R');
  const outside = path.join(base, 'outside');
  await mkdir(path.join(rootSpelling, 'src'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(rootSpelling, 'src', 'a.ts'), 'a');
  await writeFile(path.join(outside, 'secret'), 'secret');
  const opened = await openContainmentRoot(rootSpelling);
  if (!opened.ok) {
    throw new Error(`fixture root did not open: ${opened.error.code}`);
  }
  return { base, rootSpelling, outside, root: opened.value };
}

beforeAll(async () => {
  fixture = await fresh();
});

afterAll(async () => {
  await rm(fixture.base, { recursive: true, force: true });
});

function link(name: string, target: string): Promise<void> {
  return symlink(target, path.join(fixture.rootSpelling, name));
}

function resolve(
  segments: readonly string[],
  mode: ContainmentMode = 'read',
  extra: { readonly signal?: AbortSignal } = {},
) {
  return resolveContained({ root: fixture.root, segments, mode, ...extra });
}

function value(result: Awaited<ReturnType<typeof resolve>>): ContainedPath {
  if (!result.ok) {
    throw new Error(
      `expected ok, got ${result.error.code} ${JSON.stringify(result.error.details)}`,
    );
  }
  return result.value;
}

function reasonOf(result: Awaited<ReturnType<typeof resolve>>): ContainmentReason | undefined {
  if (result.ok) {
    throw new Error(`expected an error, got ${result.value.realPath}`);
  }
  const details = result.error.details;
  if (typeof details !== 'object' || details === null || Array.isArray(details)) {
    return undefined;
  }
  const reason = details['reason'];
  return CONTAINMENT_REASONS.find((known) => known === reason);
}

describe('openContainmentRoot (row 3.14)', () => {
  it('stores the realpath, so the root has one spelling', async () => {
    expect(fixture.root.realPath).toBe(await realpath(fixture.rootSpelling));
  });

  it('opens a root reached through a symlink to the same canonical root', async () => {
    const viaLink = path.join(fixture.base, 'root-link');
    await symlink(fixture.rootSpelling, viaLink);
    const opened = await openContainmentRoot(viaLink);
    expect(opened.ok && opened.value.realPath).toBe(fixture.root.realPath);
  });

  it.each([
    ['a missing folder', 'missing-dir', 'root_unavailable'],
    ['a file', 'src/a.ts', 'invalid_input'],
  ] as const)('refuses %s', async (_label, relative, code) => {
    const opened = await openContainmentRoot(path.join(fixture.rootSpelling, relative));
    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.error.code).toBe(code);
      expect(opened.error.message).toBe(ERROR_MESSAGES[code]);
    }
  });

  it('refuses a relative path (a programmer error becomes a typed refusal, not a cwd lookup)', async () => {
    const opened = await openContainmentRoot('R');
    expect(opened.ok).toBe(false);
  });
});

describe('3.x symlinks', () => {
  it('3.1 inside link to inside: resolves to the target', async () => {
    await link('l31', 'src');
    const found = value(await resolve(['l31', 'a.ts']));
    expect(found.realPath).toBe(path.join(fixture.root.realPath, 'src', 'a.ts'));
    expect(found.relativeSegments).toEqual(['src', 'a.ts']);
    expect(found.exists).toBe(true);
    expect(found.leaf).toBe('file');
  });

  it.each([
    ['3.2 directory link to outside (read)', 'l32', 'outside', ['l32', 'secret'], 'read'],
    ['3.2 directory link to outside (write new)', 'l32w', 'outside', ['l32w', 'new'], 'write'],
    ['3.3 file link to outside', 'l33', 'outside/secret', ['l33'], 'read'],
    ['3.17 leaf link outside for read', 'l317', 'outside/secret', ['l317'], 'read'],
    [
      '3.12 deepest existing ancestor links outside',
      'l312',
      'outside',
      ['l312', 'n', 'x'],
      'write',
    ],
    ['3.10 parent link to outside for a new file', 'l310', 'outside', ['l310', 'new.txt'], 'write'],
  ] as const)('%s is symlink_escape', async (_label, name, target, segments, mode) => {
    await link(name, path.join('..', target));
    const result = await resolve(segments, mode);
    expect(reasonOf(result)).toBe('symlink_escape');
    if (!result.ok) {
      expect(result.error.code).toBe('outside_workspace');
    }
    expect(existsSync(path.join(fixture.outside, 'new'))).toBe(false);
    expect(existsSync(path.join(fixture.outside, 'new.txt'))).toBe(false);
  });

  it('3.4 an absolute link target outside the root', async () => {
    await link('l34', path.parse(fixture.base).root === '/' ? '/etc' : fixture.outside);
    expect(reasonOf(await resolve(['l34']))).toBe('symlink_escape');
  });

  it('3.5 every hop of a chain is followed to the final realpath', async () => {
    await link('l35c', '../outside');
    await link('l35b', 'l35c');
    await link('l35a', 'l35b');
    expect(reasonOf(await resolve(['l35a', 'secret']))).toBe('symlink_escape');
  });

  it('3.6 a chain deeper than the OS limit is symlink_loop', async () => {
    await writeFile(path.join(fixture.rootSpelling, 'l36-end'), 'end');
    await link('l36-49', 'l36-end');
    for (let hop = 48; hop >= 0; hop -= 1) {
      await link(`l36-${String(hop)}`, `l36-${String(hop + 1)}`);
    }
    const result = await resolve(['l36-0']);
    expect(reasonOf(result)).toBe('symlink_loop');
    if (!result.ok) {
      expect(result.error.code).toBe('invalid_input');
    }
  });

  it('3.7 a self-referential link is symlink_loop', async () => {
    await link('l37', 'l37');
    expect(reasonOf(await resolve(['l37']))).toBe('symlink_loop');
    expect(reasonOf(await resolve(['l37'], 'write'))).toBe('symlink_loop');
  });

  it('3.8 a dangling link read is not_found, not an escape', async () => {
    await link('l38', 'missing');
    const result = await resolve(['l38']);
    expect(reasonOf(result)).toBe('not_found');
    if (!result.ok) {
      expect(result.error.code).toBe('not_found');
    }
  });

  it('3.9 a dangling link whose target is outside is symlink_escape for a write and creates nothing', async () => {
    await link('l39', '../outside/new');
    expect(reasonOf(await resolve(['l39'], 'write'))).toBe('symlink_escape');
    expect(existsSync(path.join(fixture.outside, 'new'))).toBe(false);
  });

  it('3.9b a dangling link whose target stays inside is refused as dangling for a write', async () => {
    await link('l39b', 'not-yet');
    expect(reasonOf(await resolve(['l39b'], 'write'))).toBe('dangling_symlink');
    expect(existsSync(path.join(fixture.rootSpelling, 'not-yet'))).toBe(false);
  });

  it('3.9c a dangling link in the middle of the path is refused for a write', async () => {
    await link('l39c', 'nowhere');
    expect(reasonOf(await resolve(['l39c', 'x'], 'write'))).toBe('dangling_symlink');
    expect(reasonOf(await resolve(['l39c', 'x'], 'read'))).toBe('not_found');
  });

  it('3.11 a new file under a missing directory resolves under the deepest existing ancestor', async () => {
    const found = value(await resolve(['newdir', 'deeper', 'x.txt'], 'write'));
    expect(found.realPath).toBe(path.join(fixture.root.realPath, 'newdir', 'deeper', 'x.txt'));
    expect(found.relativeSegments).toEqual(['newdir', 'deeper', 'x.txt']);
    expect(found.exists).toBe(false);
    expect(found.leaf).toBe('missing');
    expect(existsSync(path.join(fixture.rootSpelling, 'newdir'))).toBe(false);
  });

  it('3.11b a missing path is not_found for a read', async () => {
    expect(reasonOf(await resolve(['newdir', 'x'], 'read'))).toBe('not_found');
  });

  it('3.13 a relative target that leaves and re-enters the root is allowed', async () => {
    await link('l313', '../R/src');
    const found = value(await resolve(['l313', 'a.ts']));
    expect(found.relativeSegments).toEqual(['src', 'a.ts']);
  });

  it('3.16 an entry (delete or rename source) never follows the final link', async () => {
    await link('l316', '../outside/secret');
    const found = value(await resolve(['l316'], 'entry'));
    expect(found.realPath).toBe(path.join(fixture.root.realPath, 'l316'));
    expect(found.relativeSegments).toEqual(['l316']);
    expect(found.leaf).toBe('symlink');
    expect(found.exists).toBe(true);
  });

  it('3.16b an entry whose PARENT is a link to outside is an escape', async () => {
    await link('l316p', '../outside');
    expect(reasonOf(await resolve(['l316p', 'secret'], 'entry'))).toBe('symlink_escape');
  });

  it('3.18 listing sees the link entry; following it is a separate checked call', async () => {
    await link('l318', '../outside');
    expect(value(await resolve(['l318'], 'entry')).leaf).toBe('symlink');
    expect(reasonOf(await resolve(['l318'], 'read'))).toBe('symlink_escape');
  });

  it('an entry that does not exist reports missing with its parent canonicalized', async () => {
    await link('l-parent', 'src');
    const found = value(await resolve(['l-parent', 'gone.ts'], 'entry'));
    expect(found.exists).toBe(false);
    expect(found.leaf).toBe('missing');
    expect(found.realPath).toBe(path.join(fixture.root.realPath, 'src', 'gone.ts'));
  });

  it('refuses an entry for the root itself', async () => {
    expect(reasonOf(await resolve([], 'entry'))).toBe('is_root');
  });

  it('resolves the root itself for a read', async () => {
    const found = value(await resolve([]));
    expect(found.realPath).toBe(fixture.root.realPath);
    expect(found.relativeSegments).toEqual([]);
    expect(found.leaf).toBe('directory');
  });

  it('a file used as a directory is not_found for a read and not_a_directory for a write', async () => {
    expect(reasonOf(await resolve(['src', 'a.ts', 'x'], 'read'))).toBe('not_found');
    expect(reasonOf(await resolve(['src', 'a.ts', 'x'], 'write'))).toBe('not_a_directory');
  });
});

describe('segments are validated again here (defence in depth)', () => {
  it.each([
    ['empty', ''],
    ['dot', '.'],
    ['dot-dot', '..'],
    ['a separator', `a${path.sep}b`],
    ['a NUL', 'a\u0000b'],
  ])('refuses a segment that is %s', async (_label, segment) => {
    expect(reasonOf(await resolve(['src', segment]))).toBe('invalid_segment');
  });
});

describe('errors never echo the input', () => {
  it('keeps a secret-looking segment out of the error', async () => {
    const result = await resolve(['secret-token-123', 'x'], 'read');
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('secret-token-123');
    expect(JSON.stringify(result)).not.toContain(fixture.base);
  });
});

describe('abort', () => {
  it('returns cancelled for an already-aborted signal and touches nothing', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await resolve(['src', 'a.ts'], 'read', { signal: controller.signal });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('cancelled');
    }
  });
});

describe('4.x case folding follows the volume, and the realpath carries the on-disk spelling', () => {
  it('4.1 / 4.7 agrees with the volume the root is on', async () => {
    const probe = await probeCaseInsensitive(fixture.root.realPath);
    expect(fixture.root.caseInsensitive).toBe(probe);
    const flipped = await resolve(['SRC', 'A.TS']);
    if (probe) {
      const found = value(flipped);
      expect(found.relativeSegments).toEqual(['src', 'a.ts']);
      expect(found.realPath).toBe(path.join(fixture.root.realPath, 'src', 'a.ts'));
    } else {
      expect(reasonOf(flipped)).toBe('not_found');
    }
  });

  it('4.5 two spellings of one file give one canonical path', async () => {
    const lower = await resolve(['src', 'a.ts'], 'write');
    const upper = await resolve(['SRC', 'A.TS'], 'write');
    if (fixture.root.caseInsensitive) {
      expect(value(upper).realPath).toBe(value(lower).realPath);
    } else {
      expect(value(lower).exists).toBe(true);
      expect(value(upper).exists).toBe(false);
    }
  });

  it('an entry reports the on-disk spelling of its leaf', async () => {
    await writeFile(path.join(fixture.rootSpelling, 'MixedCase.txt'), 'x');
    const found = value(await resolve(['MixedCase.txt'], 'entry'));
    expect(found.relativeSegments).toEqual(['MixedCase.txt']);
    if (fixture.root.caseInsensitive) {
      const other = value(await resolve(['mixedcase.TXT'], 'entry'));
      expect(other.relativeSegments).toEqual(['MixedCase.txt']);
      expect(other.realPath).toBe(found.realPath);
    }
  });

  it('4.7 the probe writes nothing', async () => {
    const before = await readdir(fixture.root.realPath);
    await probeCaseInsensitive(fixture.root.realPath);
    expect(await readdir(fixture.root.realPath)).toEqual(before);
  });

  it('4.7 falls back to case-insensitive (the safe assumption) when it cannot decide', async () => {
    const empty = await mkdtemp(path.join(tmpdir(), 'ag-probe-empty-'));
    try {
      expect(await probeCaseInsensitive(empty)).toBe(true);
      expect(await probeCaseInsensitive(path.join(empty, 'does-not-exist'))).toBe(true);
      await writeFile(path.join(empty, '12345'), 'digits have no case');
      expect(await probeCaseInsensitive(empty)).toBe(true);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});

describe('isInside', () => {
  const sep = path.sep;
  const abs = (...parts: string[]): string => `${sep}${parts.join(sep)}`;

  it.each([
    ['the root itself', abs('w', 'proj'), abs('w', 'proj'), false, true],
    ['a child', abs('w', 'proj'), abs('w', 'proj', 'a'), false, true],
    ['a prefix lookalike', abs('w', 'proj'), abs('w', 'proj-evil', 'a'), false, false],
    ['a parent', abs('w', 'proj'), abs('w'), false, false],
    ['a sibling', abs('w', 'proj'), abs('w', 'other'), false, false],
    [
      'a case-different child, case-sensitive',
      abs('w', 'proj'),
      abs('w', 'PROJ', 'a'),
      false,
      false,
    ],
    [
      'a case-different child, case-insensitive',
      abs('w', 'proj'),
      abs('w', 'PROJ', 'a'),
      true,
      true,
    ],
    ['a prefix lookalike, case-insensitive', abs('w', 'proj'), abs('w', 'PROJ-evil'), true, false],
    ['a decomposed name, case-insensitive', abs('w', 'café'), abs('w', 'café', 'a'), true, true],
    ['a decomposed name, case-sensitive', abs('w', 'café'), abs('w', 'café', 'a'), false, false],
  ] as const)('%s', (_label, root, candidate, caseInsensitive, expected) => {
    const result = isInside(root, candidate, caseInsensitive);
    expect(result.inside).toBe(expected);
  });

  it('returns the segments below the root in the candidate spelling', () => {
    const result = isInside(abs('w', 'proj'), abs('w', 'PROJ', 'Src', 'a.ts'), true);
    expect(result).toEqual({ inside: true, relativeSegments: ['Src', 'a.ts'] });
  });
});
