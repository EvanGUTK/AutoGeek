/**
 * Lexical path resolution: the first, pure stage of the path-security module.
 *
 * It turns an untrusted path string into root-relative segments WITHOUT touching the disk. It never
 * decides that a path is safe, only that it is not obviously unsafe: containment on the real
 * filesystem (symlinks, case folding by the volume, races) is the later realpath stage's job.
 *
 * Decisions (docs/workspace-path-cases.md §1-§2):
 * - `.` and `..` are collapsed HERE, before any filesystem call, and the normalized segments are the
 *   only thing later stages ever hand to the OS. The raw input is never passed on, so the kernel's
 *   physical `link/..` semantics can never differ from what was checked.
 * - A `..` that would leave the root is `outside_root` at the moment it happens, even if a later
 *   segment would re-enter the root. This is deliberately stricter than needed.
 * - Absolute input is accepted only when it lies inside the root.
 * - `~`, `$VAR`, `%VAR%` and `file://` are literal names. Nothing is ever expanded.
 * - Windows forms (UNC, verbatim and device prefixes, drive-relative, rooted-without-drive) are
 *   `unsupported_path_form`. The `platform` is an explicit option, so win32 rules are testable on
 *   every host.
 * - Errors carry a stable code and never echo the input.
 *
 * Case folding (`caseInsensitive`) only widens what this stage accepts, as a pre-filter: the final
 * containment decision is made on the realpath, which carries the on-disk spelling.
 */

import { coreError, err, ok, type CoreError, type Result } from '@autogeek/core';

export type LexicalPlatform = 'posix' | 'win32';

/**
 * Why a path was refused. It rides in the error's `details` as a constant string, never any part of
 * the input. The core code is `invalid_input` (invalid_path), `unsupported` (unsupported_path_form)
 * or `outside_workspace` (outside_root).
 */
export type LexicalReason = 'invalid_path' | 'unsupported_path_form' | 'outside_root';

export interface LexicalOptions {
  /** Absolute, already-normalized root. A malformed root is a programmer error and throws. */
  readonly root: string;
  /** The untrusted path, relative to the root or absolute inside it. */
  readonly input: string;
  readonly platform: LexicalPlatform;
  /** Defaults to true on win32 and false on posix. Set from the volume probe on macOS. */
  readonly caseInsensitive?: boolean;
}

export interface LexicalValue {
  /** The input's own spelling, relative to the root. Empty when the path is the root itself. */
  readonly relativeSegments: readonly string[];
  /** The root's spelling plus `relativeSegments`, with the platform's separator. */
  readonly absolute: string;
  readonly isRoot: boolean;
  /** The input ended with a separator. This module does not decide what that means. */
  readonly trailingSlash: boolean;
}

export type LexicalResult = Result<LexicalValue, CoreError>;

const MAX_PATH_BYTES: Readonly<Record<LexicalPlatform, number>> = { posix: 4096, win32: 32767 };
const MAX_COMPONENT_BYTES = 255;

const WIN_RESERVED_BASE =
  /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])$/i;
const WIN_ILLEGAL_CHARS = /[<>:"|?*]/;
const DRIVE_PREFIX = /^[A-Za-z]:/;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

interface Prefix {
  readonly absolute: boolean;
  readonly drive: string | null;
  readonly components: readonly string[];
  readonly trailingSlash: boolean;
}

type PrefixResult =
  | { readonly ok: true; readonly prefix: Prefix }
  | { readonly ok: false; readonly code: 'unsupported_path_form' };

const REASON_CODE = {
  invalid_path: 'invalid_input',
  unsupported_path_form: 'unsupported',
  outside_root: 'outside_workspace',
} as const satisfies Record<LexicalReason, CoreError['code']>;

function fail(reason: LexicalReason): LexicalResult {
  return err(coreError(REASON_CODE[reason], { reason }));
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function hasForbiddenCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x20 || unit === 0x7f || (unit >= 0x80 && unit <= 0x9f)) {
      return true;
    }
  }
  return LONE_SURROGATE.test(text);
}

function splitPosix(text: string): Prefix {
  return {
    absolute: text.startsWith('/'),
    drive: null,
    components: text.split('/'),
    trailingSlash: text.endsWith('/'),
  };
}

function splitWin32(text: string): PrefixResult {
  const normalized = text.replaceAll('\\', '/');
  const trailingSlash = normalized.endsWith('/');
  if (normalized.startsWith('/')) {
    // `//server/share`, `//?/C:/x`, `//./C:/x` and a single leading slash (rooted without a
    // drive) are all refused: each depends on state outside the root.
    return { ok: false, code: 'unsupported_path_form' };
  }
  if (DRIVE_PREFIX.test(normalized)) {
    if (normalized.charAt(2) !== '/') {
      return { ok: false, code: 'unsupported_path_form' };
    }
    return {
      ok: true,
      prefix: {
        absolute: true,
        drive: normalized.charAt(0),
        components: normalized.slice(3).split('/'),
        trailingSlash,
      },
    };
  }
  return {
    ok: true,
    prefix: { absolute: false, drive: null, components: normalized.split('/'), trailingSlash },
  };
}

function componentIsValid(name: string, platform: LexicalPlatform): boolean {
  if (byteLength(name) > MAX_COMPONENT_BYTES) {
    return false;
  }
  if (platform === 'posix') {
    return true;
  }
  if (WIN_ILLEGAL_CHARS.test(name) || name.endsWith('.') || name.endsWith(' ')) {
    return false;
  }
  const dot = name.indexOf('.');
  const base = dot === -1 ? name : name.slice(0, dot);
  return !WIN_RESERVED_BASE.test(base);
}

interface ParsedRoot {
  readonly drive: string | null;
  readonly segments: readonly string[];
}

function parseRoot(root: string, platform: LexicalPlatform): ParsedRoot {
  if (typeof root !== 'string' || root.length === 0 || hasForbiddenCharacter(root)) {
    throw new TypeError('root must be a non-empty string without control characters');
  }
  let components: readonly string[];
  let drive: string | null = null;
  if (platform === 'posix') {
    if (!root.startsWith('/')) {
      throw new TypeError('root must be absolute');
    }
    components = root.split('/');
  } else {
    const normalized = root.replaceAll('\\', '/');
    if (!DRIVE_PREFIX.test(normalized) || normalized.charAt(2) !== '/') {
      throw new TypeError('root must be a drive-absolute path');
    }
    drive = normalized.charAt(0);
    components = normalized.slice(3).split('/');
  }
  const segments: string[] = [];
  for (const component of components) {
    if (component === '' || component === '.') {
      continue;
    }
    if (component === '..') {
      throw new TypeError('root must be normalized');
    }
    segments.push(component);
  }
  return { drive, segments };
}

function foldKey(name: string, caseInsensitive: boolean): string {
  return caseInsensitive ? name.normalize('NFC').toLowerCase() : name;
}

function foldDrive(drive: string | null): string | null {
  return drive === null ? null : drive.toLowerCase();
}

function startsWithSegments(
  candidate: readonly string[],
  prefix: readonly string[],
  caseInsensitive: boolean,
): boolean {
  if (candidate.length < prefix.length) {
    return false;
  }
  return prefix.every(
    (segment, index) =>
      foldKey(candidate[index] ?? '', caseInsensitive) === foldKey(segment, caseInsensitive),
  );
}

function buildAbsolute(
  root: ParsedRoot,
  relative: readonly string[],
  platform: LexicalPlatform,
): string {
  const all = [...root.segments, ...relative];
  if (platform === 'posix') {
    return `/${all.join('/')}`;
  }
  return `${root.drive ?? ''}:\\${all.join('\\')}`;
}

interface Walk {
  readonly stack: readonly string[];
  readonly minDepth: number;
}

/**
 * Collapses `.`/`..`. Returns an error code when a relative path would leave the root or a
 * component is invalid. `minDepth` is the shallowest the stack got after a `..`; an absolute path
 * that dipped below the root is refused even if it came back (same strictness as a relative one).
 */
function walkComponents(
  components: readonly string[],
  startsAbsolute: boolean,
  rootSegments: readonly string[],
  platform: LexicalPlatform,
): Walk | LexicalReason {
  const stack: string[] = startsAbsolute ? [] : [...rootSegments];
  const floor = startsAbsolute ? 0 : rootSegments.length;
  let minDepth = Number.POSITIVE_INFINITY;
  for (const component of components) {
    if (component === '' || component === '.') {
      continue;
    }
    if (component === '..') {
      if (stack.length === floor) {
        if (!startsAbsolute) {
          return 'outside_root';
        }
        // `/..` is `/`: nothing to pop, but the walk touched the top.
        minDepth = 0;
        continue;
      }
      stack.pop();
      minDepth = Math.min(minDepth, stack.length);
      continue;
    }
    if (!componentIsValid(component, platform)) {
      return 'invalid_path';
    }
    stack.push(component);
  }
  return { stack, minDepth };
}

export function resolveLexically(options: LexicalOptions): LexicalResult {
  const { input, platform } = options;
  const caseInsensitive = options.caseInsensitive ?? platform === 'win32';
  const root = parseRoot(options.root, platform);

  if (
    input.length === 0 ||
    hasForbiddenCharacter(input) ||
    byteLength(input) > MAX_PATH_BYTES[platform]
  ) {
    return fail('invalid_path');
  }

  let prefix: Prefix;
  if (platform === 'posix') {
    prefix = splitPosix(input);
  } else {
    const split = splitWin32(input);
    if (!split.ok) {
      return fail(split.code);
    }
    prefix = split.prefix;
  }

  if (prefix.absolute && foldDrive(prefix.drive) !== foldDrive(root.drive)) {
    return fail('outside_root');
  }

  const walked = walkComponents(prefix.components, prefix.absolute, root.segments, platform);
  if (typeof walked === 'string') {
    return fail(walked);
  }
  if (
    !startsWithSegments(walked.stack, root.segments, caseInsensitive) ||
    (prefix.absolute && walked.minDepth < root.segments.length)
  ) {
    return fail('outside_root');
  }

  const relativeSegments = walked.stack.slice(root.segments.length);
  const absolute = buildAbsolute(root, relativeSegments, platform);
  if (byteLength(absolute) > MAX_PATH_BYTES[platform]) {
    return fail('invalid_path');
  }
  return ok({
    relativeSegments,
    absolute,
    isRoot: relativeSegments.length === 0,
    trailingSlash: prefix.trailingSlash,
  });
}
