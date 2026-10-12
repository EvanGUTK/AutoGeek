import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUTH_ERROR_PROJECTION } from './auth-error.ts';
import { ERROR_CODES } from './errors.ts';

// The approved contract docs are the source of truth for which error names exist. These tests read
// them (so core#test is never cached, see turbo.json) and fail when a doc names a code that
// ErrorCode lacks, so that drift cannot recur. Review K2.

const DOCS = join(import.meta.dirname, '..', '..', '..', 'docs');
const read = (name: string): Promise<string> => readFile(join(DOCS, name), 'utf8');

const known = new Set<string>(ERROR_CODES);
const BACKTICKED = /`([a-z][a-z0-9]*(?:_[a-z0-9]+)*)`/g;
const names = (text: string): string[] => [...text.matchAll(BACKTICKED)].map((m) => m[1] ?? '');

/**
 * Backticked words that appear in error lists but are not error codes. Each entry says why; a new
 * name that is not here and not an ErrorCode fails the test and forces a decision.
 */
const NOT_CODES: Readonly<Record<string, string>> = {
  details: 'a field name in prose',
  message: 'a field name in prose',
  none: 'prose',
  more: 'a response field named in the agent.replay row, not an error',
  gap: 'a result kind of agent.replay ({ kind: gap }), not an error',
  offered: 'a request field named in a permissions row, not an error',
};

/**
 * Workspace-internal path-security reasons (docs/workspace-path-cases.md). They are PathError
 * kinds owned by @autogeek/workspace and are projected onto ErrorCode at the IPC boundary
 * (outside_root, symlink_escape and friends to outside_workspace, invalid_path to invalid_input).
 * They are NOT error codes; they are listed so a new, unclassified reason cannot slip in.
 */
const WORKSPACE_PATH_REASONS: ReadonlySet<string> = new Set([
  'invalid_path',
  'symlink_escape',
  'outside_root',
  'unsupported_path_form',
  'symlink_loop',
  'root_too_broad',
  'not_a_file',
  'not_a_directory',
  'git_internal',
]);

const unknownNames = (
  found: readonly string[],
  extraAllowed: ReadonlySet<string> = new Set(),
): string[] =>
  [...new Set(found)].filter(
    (name) => !known.has(name) && !(name in NOT_CODES) && !extraAllowed.has(name),
  );

describe('ErrorCode against the approved docs', () => {
  it('covers the common-error table in docs/ipc-channels.md §1.3', async () => {
    const doc = await read('ipc-channels.md');
    const section = doc.slice(doc.indexOf('### 1.3'), doc.indexOf('### 1.4'));
    const rows = [...section.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1] ?? '');
    expect(rows.length).toBeGreaterThan(10);
    expect(unknownNames(rows)).toEqual([]);
  });

  it('covers every code named on an "Errors:" line of docs/ipc-channels.md', async () => {
    const doc = await read('ipc-channels.md');
    const lines = doc.split('\n').filter((line) => /\bErrors?:/.test(line));
    expect(lines.length).toBeGreaterThan(10);
    const found = lines.flatMap((line) => names(line.slice(line.search(/\bErrors?:/))));
    expect(unknownNames(found)).toEqual([]);
  });

  it('covers the Errors column of the agent.* and permissions.* tables in docs/agent-contract.md', async () => {
    const doc = await read('agent-contract.md');
    const rows = doc.split('\n').filter((line) => /^\| `(agent|permissions)\./.test(line));
    expect(rows.length).toBeGreaterThan(10);
    // Cells are separated by unescaped pipes; the last cell lists the errors.
    const found = rows.flatMap((row) => {
      const cells = row
        .split(/(?<!\\)\|/)
        .map((cell) => cell.trim())
        .filter((cell) => cell.length > 0);
      return names(cells[cells.length - 1] ?? '');
    });
    expect(unknownNames(found)).toEqual([]);
  });

  it('classifies every "reject `x`" reason in docs/workspace-path-cases.md', async () => {
    const doc = await read('workspace-path-cases.md');
    const found = [...doc.matchAll(/\breject(?:s|ed)?\s+`([a-z][a-z0-9_]*)`/g)].map(
      (m) => m[1] ?? '',
    );
    expect(found.length).toBeGreaterThan(10);
    expect(unknownNames(found, WORKSPACE_PATH_REASONS)).toEqual([]);
  });

  it('names root_unavailable (workspace cases 6.4 and 6.12) as a real code', () => {
    expect(known.has('root_unavailable')).toBe(true);
  });

  it('keeps the workspace-internal reasons out of ErrorCode', () => {
    expect([...WORKSPACE_PATH_REASONS].filter((reason) => known.has(reason))).toEqual([]);
  });
});

describe('AuthError projection against the approved docs', () => {
  it('matches the AuthError table in docs/ipc-channels.md §6 row for row', async () => {
    const doc = await read('ipc-channels.md');
    const start = doc.indexOf('| AuthError kind | Crosses as |');
    expect(start).toBeGreaterThan(0);
    const rows = doc.slice(start).split('\n').slice(2);
    const table = rows.slice(
      0,
      rows.findIndex((row) => !row.startsWith('|')),
    );
    const documented: Record<string, string> = {};
    for (const row of table) {
      const [kinds = '', target = ''] = row.split('|').slice(1);
      for (const kind of names(kinds)) {
        documented[kind] = target.includes('the same universal code')
          ? kind
          : (names(target)[0] ?? '');
      }
    }
    expect(documented).toEqual(AUTH_ERROR_PROJECTION);
  });
});
