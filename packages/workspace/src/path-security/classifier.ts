/**
 * The sensitive-path classifier and `isExecVector` (docs/workspace-path-cases.md section 7, 7a).
 *
 * A pure function of the canonical, root-relative path segments and the operation. It reads the
 * rule table in `rules.ts` and nothing else: no filesystem, no ignore state (the `ignored` flag is
 * cosmetic and has no parameter here by design), no per-call options.
 *
 * Combination when several rules match (reviewer W4):
 * - `access` is the most restrictive match (deny over confirm over free);
 * - `elevated` is true for a write when any matched rule is an exec vector;
 * - `category` is the first category in `CATEGORY_ORDER` among the matched rules that restrict this
 *   operation (or are exec vectors), so a read of `.git/FETCH_HEAD` says credentials and a write
 *   says git internals.
 */
import {
  CATEGORY_ORDER,
  PATH_RULES,
  type PathAccess,
  type PathCategory,
  type PathRule,
} from './rules.ts';

export type PathOp = 'read' | 'write';

export interface PathClassification {
  /** Null when no rule matched (an ordinary path). */
  readonly category: PathCategory | null;
  readonly access: PathAccess;
  /** A write to an exec vector: never session-grantable, always a diff prompt, clears grants. */
  readonly elevated: boolean;
  /** True iff any exec-vector rule matched, whatever the operation. */
  readonly execVector: boolean;
  /** Ids of the rules that applied, for the approval prompt. */
  readonly rules: readonly string[];
}

interface CompiledPattern {
  readonly segments: readonly string[];
  readonly open: boolean;
}

interface CompiledRule {
  readonly rule: PathRule;
  readonly patterns: readonly CompiledPattern[];
}

const MAX_PATH_BYTES = 4096;
const MAX_COMPONENT_BYTES = 255;
const ACCESS_RANK: Readonly<Record<PathAccess, number>> = { free: 0, confirm: 1, deny: 2 };

export function foldSegment(segment: string): string {
  return segment.normalize('NFC').toLowerCase();
}

function compilePattern(pattern: string): CompiledPattern {
  const parts = pattern.split('/');
  const open = parts[parts.length - 1] === '**';
  const segments = (open ? parts.slice(0, -1) : parts).map(foldSegment);
  return { segments, open };
}

const COMPILED: readonly CompiledRule[] = PATH_RULES.map((rule) => ({
  rule,
  patterns: rule.patterns.map(compilePattern),
}));

/** Linear-time glob for a single segment: `*` matches any run of characters. */
function globMatches(pattern: string, name: string): boolean {
  let p = 0;
  let n = 0;
  let star = -1;
  let mark = 0;
  while (n < name.length) {
    if (p < pattern.length && pattern.charAt(p) === '*') {
      star = p;
      p += 1;
      mark = n;
    } else if (p < pattern.length && pattern.charAt(p) === name.charAt(n)) {
      p += 1;
      n += 1;
    } else if (star !== -1) {
      p = star + 1;
      mark += 1;
      n = mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern.charAt(p) === '*') {
    p += 1;
  }
  return p === pattern.length;
}

function patternMatches(pattern: CompiledPattern, folded: readonly string[]): boolean {
  const length = pattern.segments.length;
  for (let start = 0; start + length <= folded.length; start += 1) {
    if (!pattern.open && start + length !== folded.length) {
      continue;
    }
    const aligned = pattern.segments.every((segment, index) =>
      globMatches(segment, folded[start + index] ?? ''),
    );
    if (aligned) {
      return true;
    }
  }
  return false;
}

function matchedRules(folded: readonly string[]): readonly PathRule[] {
  const raw = COMPILED.filter((compiled) =>
    compiled.patterns.some((pattern) => patternMatches(pattern, folded)),
  ).map((compiled) => compiled.rule);
  const groups = new Set(raw.flatMap((rule) => (rule.group === undefined ? [] : [rule.group])));
  const superseded = new Set(raw.flatMap((rule) => rule.supersedes ?? []));
  return raw.filter(
    (rule) =>
      !superseded.has(rule.id) &&
      (rule.unlessGroupMatched === undefined || !groups.has(rule.unlessGroupMatched)),
  );
}

export function classifyPath(segments: readonly string[], op: PathOp): PathClassification {
  const rules = matchedRules(segments.map(foldSegment));
  let access: PathAccess = 'free';
  for (const rule of rules) {
    const imposed = op === 'read' ? rule.read : rule.write;
    if (ACCESS_RANK[imposed] > ACCESS_RANK[access]) {
      access = imposed;
    }
  }
  const execVector = rules.some((rule) => rule.execVector);
  // The category explains why THIS operation is restricted, so only rules that restrict it (or are
  // exec vectors) compete; a path that only matched free rules reports the first of those.
  const restricting = rules.filter(
    (rule) =>
      (op === 'read' ? rule.read : rule.write) !== 'free' || (op === 'write' && rule.execVector),
  );
  const categories = new Set(
    (restricting.length > 0 ? restricting : rules).map((rule) => rule.category),
  );
  return {
    category: CATEGORY_ORDER.find((category) => categories.has(category)) ?? null,
    access,
    elevated: op === 'write' && execVector,
    execVector,
    rules: rules.map((rule) => rule.id),
  };
}

function isWellFormedRelativePath(path: string): boolean {
  if (path.length === 0 || Buffer.byteLength(path, 'utf8') > MAX_PATH_BYTES) {
    return false;
  }
  for (let index = 0; index < path.length; index += 1) {
    const unit = path.charCodeAt(index);
    if (
      unit < 0x20 ||
      unit === 0x7f ||
      (unit >= 0x80 && unit <= 0x9f) ||
      path.charAt(index) === '\\'
    ) {
      return false;
    }
  }
  if (path.startsWith('/')) {
    return false;
  }
  return path
    .split('/')
    .every(
      (segment) =>
        segment !== '' &&
        segment !== '.' &&
        segment !== '..' &&
        Buffer.byteLength(segment, 'utf8') <= MAX_COMPONENT_BYTES,
    );
}

/**
 * True when writing `rootRelativePath` can change what an already-approved command runs.
 * The input is root-relative POSIX with no leading `./` (the gate passes it after realpath and
 * containment). Malformed input returns true (fail closed); a valid path that matches no rule
 * returns false, because ordinary source edits must not clear grants.
 */
export function isExecVector(rootRelativePath: string): boolean {
  if (!isWellFormedRelativePath(rootRelativePath)) {
    return true;
  }
  return classifyPath(rootRelativePath.split('/'), 'write').execVector;
}
