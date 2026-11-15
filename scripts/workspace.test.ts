import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { releasePackages } from './release-metadata.mjs';

const manifest = (path: string) =>
  JSON.parse(readFileSync(new URL(`../${path}/package.json`, import.meta.url), 'utf8'));

describe('workspace package boundaries', () => {
  it('keeps the root private and free of published runtime entrypoints', () => {
    const root = manifest('.');
    expect(root.private).toBe(true);
    expect(root.main).toBeUndefined();
    expect(root.exports).toBeUndefined();
    expect(root.publishConfig).toBeUndefined();
  });

  it.each(
    releasePackages('workflow_dispatch', 'main'),
  )('publishes $name only from its own package directory', ({ name, directory }) => {
    expect(directory).toBe(`packages/${name}`);
    const pkg = manifest(directory);
    expect(pkg.name).toBe(name);
    expect(pkg.private).not.toBe(true);
    expect(pkg.repository.directory).toBe(directory);
    expect(pkg.files.length).toBeGreaterThan(0);
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
    expect(Object.keys(pkg.optionalDependencies ?? {})).toEqual([]);
  });
});
