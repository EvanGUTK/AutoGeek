import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { findOutsideReadsInTests, listWorkspaceDirectories } from './package-policy.ts';

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const DryRun = z.object({
  globalCacheInputs: z.object({ files: z.record(z.string(), z.string()) }),
  tasks: z.array(
    z.object({
      taskId: z.string(),
      resolvedTaskDefinition: z.object({ cache: z.boolean() }),
    }),
  ),
});

async function turbo(args: readonly string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync('pnpm', ['exec', 'turbo', ...args], {
    cwd: REPO_ROOT,
  });
  return stdout + stderr;
}

// These run the real turbo CLI: a config object test would not see how turbo actually hashes.
describe('turbo cache configuration', () => {
  it('hashes root config files that feed every task, so editing them invalidates the cache', async () => {
    const json = await turbo(['run', 'typecheck', '--dry=json']);
    const dryRun = DryRun.parse(JSON.parse(json.slice(json.indexOf('{'))));
    const hashed = Object.keys(dryRun.globalCacheInputs.files);
    expect(hashed).toEqual(
      expect.arrayContaining(['tsconfig.base.json', '.npmrc', 'pnpm-workspace.yaml']),
    );
  });

  it('keeps the local cache isolated to this checkout instead of sharing it across worktrees', async () => {
    const text = await turbo(['run', 'typecheck', '--dry']);
    expect(text).not.toContain('shared worktree cache');
  });

  it('never caches tooling#test: its tests read root files that are not in the turbo hash', async () => {
    // eslint-cli, workspace-policy, dependency-rules and turbo-config tests read the root
    // package.json, turbo.json, .dependency-cruiser.mjs and the apps/ and packages/ listings.
    // A cached green would hide a regression in any of them (review F1, LEARNINGS L-001).
    const json = await turbo(['run', 'test', '--dry=json']);
    const dryRun = DryRun.parse(JSON.parse(json.slice(json.indexOf('{'))));
    const task = dryRun.tasks.find((t) => t.taskId === '@autogeek/tooling#test');
    expect(task?.resolvedTaskDefinition.cache).toBe(false);
  });

  it('never caches the test task of any package whose tests read outside it (review K2)', async () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const flagged: string[] = [];
    for (const dir of await listWorkspaceDirectories(root)) {
      if ((await findOutsideReadsInTests(root, dir)).length > 0) {
        flagged.push(`@autogeek/${dir.split('/').pop() ?? dir}#test`);
      }
    }
    // Both known cases must be detected, or the check itself is blind.
    expect(flagged).toEqual(
      expect.arrayContaining(['@autogeek/tooling#test', '@autogeek/core#test']),
    );
    const json = await turbo(['run', 'test', '--dry=json']);
    const dryRun = DryRun.parse(JSON.parse(json.slice(json.indexOf('{'))));
    for (const taskId of flagged) {
      const task = dryRun.tasks.find((t) => t.taskId === taskId);
      expect(task?.resolvedTaskDefinition.cache, `${taskId} must be uncached`).toBe(false);
    }
  });
});
