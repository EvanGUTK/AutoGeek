import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

const ManifestSchema = z.object({
  name: z.string().optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
  optionalDependencies: z.record(z.string(), z.string()).optional(),
  peerDependencies: z.record(z.string(), z.string()).optional(),
});

async function workspaceFile(): Promise<string> {
  return readFile(join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8');
}

/** Minimal reader for the flat `catalog:` mapping in pnpm-workspace.yaml. */
function catalogEntries(yaml: string): Map<string, string> {
  const entries = new Map<string, string>();
  let inCatalog = false;
  for (const line of yaml.split('\n')) {
    if (/^catalog:\s*$/.test(line)) {
      inCatalog = true;
      continue;
    }
    if (inCatalog && /^\S/.test(line)) {
      inCatalog = false;
    }
    const match = /^\s+['"]?([^'":]+)['"]?:\s*(\S+)\s*$/.exec(line);
    if (inCatalog && match?.[1] !== undefined && match[2] !== undefined) {
      entries.set(match[1], match[2]);
    }
  }
  return entries;
}

async function manifestPaths(): Promise<string[]> {
  const paths = [join(REPO_ROOT, 'package.json'), join(REPO_ROOT, 'tooling', 'package.json')];
  for (const group of ['apps', 'packages']) {
    const entries = await readdir(join(REPO_ROOT, group), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        paths.push(join(REPO_ROOT, group, entry.name, 'package.json'));
      }
    }
  }
  return paths.filter((path) => path.endsWith('package.json'));
}

async function manifests(): Promise<{ path: string; manifest: z.infer<typeof ManifestSchema> }[]> {
  const result: { path: string; manifest: z.infer<typeof ManifestSchema> }[] = [];
  for (const path of await manifestPaths()) {
    const raw = await readFile(path, 'utf8').then(
      (text): string | undefined => text,
      (failure: unknown) => {
        // A directory without a package.json (for example only node_modules) is not a package.
        if (
          typeof failure === 'object' &&
          failure !== null &&
          'code' in failure &&
          failure.code === 'ENOENT'
        ) {
          return undefined;
        }
        throw failure;
      },
    );
    if (raw !== undefined) {
      result.push({ path, manifest: ManifestSchema.parse(JSON.parse(raw)) });
    }
  }
  return result;
}

describe('supply-chain settings in pnpm-workspace.yaml', () => {
  it('has no minimumReleaseAgeExclude: a too-young release must never bypass the cooldown', async () => {
    expect(await workspaceFile()).not.toMatch(/^minimumReleaseAgeExclude\s*:/m);
  });

  it('pins the cooldown to at least 24 hours (1440 minutes) so it cannot be lowered or zeroed', async () => {
    const match = /^minimumReleaseAge:\s*(\d+)\s*$/m.exec(await workspaceFile());
    expect(match, 'minimumReleaseAge must be set explicitly in pnpm-workspace.yaml').not.toBeNull();
    expect(Number(match?.[1])).toBeGreaterThanOrEqual(1440);
  });

  it('does not override the cooldown in .npmrc', async () => {
    const npmrc = await readFile(join(REPO_ROOT, '.npmrc'), 'utf8');
    expect(npmrc).not.toMatch(/minimum-?release-?age/i);
  });

  it('refuses silent exclusions with minimumReleaseAgeStrict', async () => {
    expect(await workspaceFile()).toMatch(/^minimumReleaseAgeStrict:\s*true\s*$/m);
  });
});

describe('dependency declarations', () => {
  it('pins every catalog entry to an exact version', async () => {
    const entries = catalogEntries(await workspaceFile());
    expect(entries.size).toBeGreaterThan(0);
    for (const [name, version] of entries) {
      expect(version, `${name} must be exact`).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
    }
  });

  it('declares every third-party dependency as `catalog:` so versions cannot drift or float', async () => {
    const offenders: string[] = [];
    for (const { path, manifest } of await manifests()) {
      for (const field of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
        for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
          if (spec !== 'catalog:' && !spec.startsWith('workspace:')) {
            offenders.push(`${path} ${field}.${name} = ${spec}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('has a catalog entry for every catalog: reference', async () => {
    const entries = catalogEntries(await workspaceFile());
    const missing: string[] = [];
    for (const { path, manifest } of await manifests()) {
      for (const field of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
        for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
          if (spec === 'catalog:' && !entries.has(name)) {
            missing.push(`${path} ${name}`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
