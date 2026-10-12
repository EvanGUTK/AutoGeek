/**
 * Realpath containment: the second stage of the path-security module (docs/workspace-path-cases.md
 * sections 3 and 4). It takes root-relative segments the lexical stage already normalized and
 * decides, against the real filesystem, where they land and whether that is inside the root.
 *
 * Rules:
 * - The decision is made on the REALPATH, never on the spelling. Every symlink hop is followed by the
 *   OS, so chains, relative targets that re-enter the root and `/tmp` vs `/private/tmp` all resolve
 *   the same way the kernel will.
 * - A path that does not exist yet (a new file) is judged by its deepest existing ancestor, which is
 *   realpath'd and must be contained. Nothing is created here.
 * - `entry` mode (delete, rename source, listing) resolves the PARENT and looks at the final
 *   component with `lstat`, so a link is operated on, never its target (row 3.16).
 * - A dangling link is `not_found` for a read, and is refused for a write (an outside target is
 *   `symlink_escape`), so a write can never be steered through a link that does not resolve yet.
 * - On a case-insensitive volume the realpath carries the on-disk spelling; that spelling is what
 *   callers classify and compare (row 4.5), and containment is compared with the same fold.
 * - Errors are core errors with a constant message and a constant `details.reason`. No path, segment
 *   or errno text is ever echoed.
 *
 * This stage is a CHECK. Between it and the use there is a window, which the open stage closes with
 * `O_NOFOLLOW` and a `(dev, ino)` re-check (section 5). Callers must not treat a result as a
 * capability.
 */
import { lstat, readdir, readlink, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { coreError, err, ok, type CoreError, type Err, type Result } from '@autogeek/core';
import { foldSegment } from './classifier.ts';

export const CONTAINMENT_REASONS = [
  'symlink_escape',
  'symlink_loop',
  'not_found',
  'not_a_directory',
  'dangling_symlink',
  'invalid_segment',
  'is_root',
  'unreadable',
] as const;

export type ContainmentReason = (typeof CONTAINMENT_REASONS)[number];

const REASON_CODE = {
  symlink_escape: 'outside_workspace',
  symlink_loop: 'invalid_input',
  not_found: 'not_found',
  not_a_directory: 'invalid_input',
  dangling_symlink: 'invalid_input',
  invalid_segment: 'invalid_input',
  is_root: 'invalid_input',
  unreadable: 'io',
} as const satisfies Record<ContainmentReason, CoreError['code']>;

export type ContainmentMode = 'read' | 'write' | 'entry';

export type LeafKind = 'file' | 'directory' | 'symlink' | 'other' | 'missing';

export interface ContainmentRoot {
  /** `realpath` of the folder: the one spelling every comparison uses. */
  readonly realPath: string;
  /** From the volume probe. Widens comparison only; the realpath is still authoritative. */
  readonly caseInsensitive: boolean;
}

export interface ContainedPath {
  /** Absolute, canonical, and inside the root. For an `entry` the final link is not followed. */
  readonly realPath: string;
  /** `realPath` below the root, in the on-disk spelling. Classify and compare these. */
  readonly relativeSegments: readonly string[];
  readonly exists: boolean;
  readonly leaf: LeafKind;
}

export interface ContainmentOptions {
  readonly root: ContainmentRoot;
  /** Root-relative segments from `resolveLexically`. Validated again here. */
  readonly segments: readonly string[];
  readonly mode: ContainmentMode;
  readonly signal?: AbortSignal;
}

export type ContainmentResult = Result<ContainedPath, CoreError>;

function fail(reason: ContainmentReason): Err<CoreError> {
  return err(coreError(REASON_CODE[reason], { reason }));
}

function cancelled(): Err<CoreError> {
  return err(coreError('cancelled'));
}

function errnoOf(thrown: unknown): string | undefined {
  if (typeof thrown === 'object' && thrown !== null && 'code' in thrown) {
    const { code } = thrown;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function splitAbsolute(absolute: string): readonly string[] {
  return absolute.split(path.sep).filter((part) => part !== '');
}

function foldFor(name: string, caseInsensitive: boolean): string {
  return caseInsensitive ? foldSegment(name) : name;
}

export type InsideResult =
  | { readonly inside: true; readonly relativeSegments: readonly string[] }
  | { readonly inside: false };

/** Segment-wise containment, never a string prefix (`/w/proj-evil` is not inside `/w/proj`). */
export function isInside(
  rootPath: string,
  candidatePath: string,
  caseInsensitive: boolean,
): InsideResult {
  const rootParts = splitAbsolute(rootPath);
  const candidateParts = splitAbsolute(candidatePath);
  if (candidateParts.length < rootParts.length) {
    return { inside: false };
  }
  for (const [index, part] of rootParts.entries()) {
    const other = candidateParts[index];
    if (other === undefined || foldFor(other, caseInsensitive) !== foldFor(part, caseInsensitive)) {
      return { inside: false };
    }
  }
  return { inside: true, relativeSegments: candidateParts.slice(rootParts.length) };
}

function kindOf(stats: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }) {
  if (stats.isSymbolicLink()) {
    return 'symlink';
  }
  if (stats.isDirectory()) {
    return 'directory';
  }
  return stats.isFile() ? 'file' : 'other';
}

function flipCase(name: string): string {
  const lower = name.toLowerCase();
  return lower === name ? name.toUpperCase() : lower;
}

/**
 * Decides whether the volume under `rootRealPath` ignores case, WITHOUT writing anything: it looks
 * up an existing entry under a case-flipped spelling and compares `(dev, ino)`. If it cannot decide
 * (empty folder, no cased names, every lookup errors) it answers `true`, which is the safe side:
 * the answer only widens a pre-filter, and the realpath still decides containment.
 */
export async function probeCaseInsensitive(rootRealPath: string): Promise<boolean> {
  try {
    const names = await readdir(rootRealPath);
    let tried = 0;
    for (const name of names) {
      const flipped = flipCase(name);
      if (flipped === name) {
        continue;
      }
      tried += 1;
      if (tried > 64) {
        break;
      }
      let original;
      try {
        original = await lstat(path.join(rootRealPath, name), { bigint: true });
      } catch {
        continue;
      }
      if (original.isSymbolicLink() || original.ino === 0n) {
        continue;
      }
      try {
        const other = await lstat(path.join(rootRealPath, flipped), { bigint: true });
        return other.dev === original.dev && other.ino === original.ino;
      } catch (thrown) {
        if (errnoOf(thrown) === 'ENOENT') {
          return false;
        }
      }
    }
  } catch {
    // Unreadable folder: fall through to the safe answer.
  }
  return true;
}

/** Opens a folder as a containment root: absolute, a directory, stored as its realpath. */
export async function openContainmentRoot(
  folder: string,
  signal?: AbortSignal,
): Promise<Result<ContainmentRoot, CoreError>> {
  if (!path.isAbsolute(folder) || folder.includes('\u0000')) {
    return err(coreError('invalid_input'));
  }
  try {
    const real = await realpath(folder);
    if (signal?.aborted === true) {
      return cancelled();
    }
    if (!(await stat(real)).isDirectory()) {
      return err(coreError('invalid_input'));
    }
    const caseInsensitive = await probeCaseInsensitive(real);
    return ok({ realPath: real, caseInsensitive });
  } catch (thrown) {
    const code = errnoOf(thrown);
    return err(coreError(code === 'ENOENT' || code === 'ENOTDIR' ? 'root_unavailable' : 'io'));
  }
}

type Step<T> = { readonly ok: true; readonly value: T } | Err<CoreError>;

function segmentsAreValid(segments: readonly string[]): boolean {
  return segments.every(
    (segment) =>
      segment !== '' &&
      segment !== '.' &&
      segment !== '..' &&
      !segment.includes(path.sep) &&
      !segment.includes('/') &&
      !segment.includes('\u0000'),
  );
}

function mapFsError(thrown: unknown, mode: ContainmentMode): Err<CoreError> {
  const code = errnoOf(thrown);
  if (code === 'ELOOP') {
    return fail('symlink_loop');
  }
  if (code === 'ENOTDIR') {
    return fail(mode === 'read' ? 'not_found' : 'not_a_directory');
  }
  return fail(code === 'ENOENT' ? 'not_found' : 'unreadable');
}

class Resolver {
  private readonly root: ContainmentRoot;
  private readonly mode: ContainmentMode;
  private readonly signal: AbortSignal | undefined;

  constructor(root: ContainmentRoot, mode: ContainmentMode, signal: AbortSignal | undefined) {
    this.root = root;
    this.mode = mode;
    this.signal = signal;
  }

  private aborted(): boolean {
    return this.signal?.aborted === true;
  }

  private contain(real: string): Step<readonly string[]> {
    const inside = isInside(this.root.realPath, real, this.root.caseInsensitive);
    return inside.inside ? { ok: true, value: inside.relativeSegments } : fail('symlink_escape');
  }

  /** `realpath` of a path built under an already-canonical directory, with errno -> reason. */
  private async real(candidate: string): Promise<Step<string> | 'ENOENT'> {
    try {
      return { ok: true, value: await realpath(candidate) };
    } catch (thrown) {
      if (errnoOf(thrown) === 'ENOENT') {
        return 'ENOENT';
      }
      return mapFsError(thrown, this.mode);
    }
  }

  async resolve(segments: readonly string[]): Promise<ContainmentResult> {
    if (!segmentsAreValid(segments)) {
      return fail('invalid_segment');
    }
    if (this.aborted()) {
      return cancelled();
    }
    try {
      return this.mode === 'entry'
        ? await this.resolveEntry(segments)
        : await this.resolveFollow(segments);
    } catch (thrown) {
      return mapFsError(thrown, this.mode);
    }
  }

  private async resolveFollow(segments: readonly string[]): Promise<ContainmentResult> {
    const full = path.join(this.root.realPath, ...segments);
    const direct = await this.real(full);
    if (this.aborted()) {
      return cancelled();
    }
    if (direct !== 'ENOENT') {
      if (!direct.ok) {
        return direct;
      }
      const contained = this.contain(direct.value);
      if (!contained.ok) {
        return contained;
      }
      const stats = await lstat(direct.value);
      return ok({
        realPath: direct.value,
        relativeSegments: contained.value,
        exists: true,
        leaf: kindOf(stats),
      });
    }
    return this.resolveMissing(segments);
  }

  /** The full path did not resolve: find the deepest ancestor that does, and judge by that. */
  private async resolveMissing(segments: readonly string[]): Promise<ContainmentResult> {
    for (let depth = segments.length - 1; depth >= 0; depth -= 1) {
      const ancestor = path.join(this.root.realPath, ...segments.slice(0, depth));
      const resolved = await this.real(ancestor);
      if (this.aborted()) {
        return cancelled();
      }
      if (resolved === 'ENOENT') {
        continue;
      }
      if (!resolved.ok) {
        return resolved;
      }
      const contained = this.contain(resolved.value);
      if (!contained.ok) {
        return contained;
      }
      if (this.mode === 'read') {
        return fail('not_found');
      }
      const missing = segments.slice(depth);
      const first = missing[0];
      if (first === undefined) {
        return fail('unreadable');
      }
      const dangling = await this.refuseDangling(resolved.value, first);
      if (dangling !== null) {
        return dangling;
      }
      return ok({
        realPath: path.join(resolved.value, ...missing),
        relativeSegments: [...contained.value, ...missing],
        exists: false,
        leaf: 'missing',
      });
    }
    // Not even the root resolves: it was removed or unmounted under us.
    return err(coreError('root_unavailable'));
  }

  /**
   * `name` under `directory` failed to resolve for a write. If an entry by that name EXISTS it can
   * only be a link whose target is missing, and a write never goes through one: `symlink_escape`
   * when the link would create its target outside the root, `dangling_symlink` otherwise.
   */
  private async refuseDangling(directory: string, name: string): Promise<Err<CoreError> | null> {
    let entry;
    try {
      entry = await lstat(path.join(directory, name));
    } catch (thrown) {
      return errnoOf(thrown) === 'ENOENT' ? null : mapFsError(thrown, this.mode);
    }
    if (!entry.isSymbolicLink()) {
      // Present but unresolvable and not a link: it changed under us. Fail closed.
      return fail('unreadable');
    }
    const target = path.resolve(directory, await readlink(path.join(directory, name)));
    return (await this.targetIsInside(target)) ? fail('dangling_symlink') : fail('symlink_escape');
  }

  /**
   * Where a link target would be created: below its deepest existing ancestor, realpath'd. Anything
   * unclear (an error, no ancestor) counts as outside.
   */
  private async targetIsInside(target: string): Promise<boolean> {
    const parts = splitAbsolute(target);
    for (let depth = parts.length; depth > 0; depth -= 1) {
      const resolved = await this.real(`${path.sep}${parts.slice(0, depth).join(path.sep)}`);
      if (resolved === 'ENOENT') {
        continue;
      }
      return resolved.ok && this.contain(resolved.value).ok;
    }
    return false;
  }

  private async resolveEntry(segments: readonly string[]): Promise<ContainmentResult> {
    const leafName = segments[segments.length - 1];
    if (leafName === undefined) {
      return fail('is_root');
    }
    const parentSegments = segments.slice(0, -1);
    const parentFull = path.join(this.root.realPath, ...parentSegments);
    const parent = await this.real(parentFull);
    if (this.aborted()) {
      return cancelled();
    }
    if (parent === 'ENOENT') {
      return fail('not_found');
    }
    if (!parent.ok) {
      return parent;
    }
    const contained = this.contain(parent.value);
    if (!contained.ok) {
      return contained;
    }
    if (!(await stat(parent.value)).isDirectory()) {
      return fail('not_found');
    }
    const onDisk = await this.onDiskName(parent.value, leafName);
    if (!onDisk.ok) {
      return onDisk;
    }
    const entryPath = path.join(parent.value, onDisk.value);
    let leaf: LeafKind = 'missing';
    try {
      leaf = kindOf(await lstat(entryPath));
    } catch (thrown) {
      if (errnoOf(thrown) !== 'ENOENT') {
        return mapFsError(thrown, this.mode);
      }
    }
    return ok({
      realPath: entryPath,
      relativeSegments: [...contained.value, onDisk.value],
      exists: leaf !== 'missing',
      leaf,
    });
  }

  /**
   * On a case-insensitive volume the leaf may be spelled differently from the entry on disk. Read
   * the parent to get the real spelling; more than one fold-equal entry is ambiguous and refused.
   */
  private async onDiskName(parent: string, name: string): Promise<Step<string>> {
    if (!this.root.caseInsensitive) {
      return { ok: true, value: name };
    }
    const names = await readdir(parent);
    if (this.aborted()) {
      return cancelled();
    }
    if (names.includes(name)) {
      return { ok: true, value: name };
    }
    const folded = foldSegment(name);
    const matches = names.filter((candidate) => foldSegment(candidate) === folded);
    if (matches.length > 1) {
      return fail('unreadable');
    }
    return { ok: true, value: matches[0] ?? name };
  }
}

/**
 * Resolves root-relative segments to a canonical, contained location, or refuses with a core error
 * whose `details.reason` is one of `CONTAINMENT_REASONS`.
 */
export function resolveContained(options: ContainmentOptions): Promise<ContainmentResult> {
  return new Resolver(options.root, options.mode, options.signal).resolve(options.segments);
}
