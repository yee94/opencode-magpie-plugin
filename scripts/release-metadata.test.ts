import { describe, expect, it } from 'vitest';
import {
  assertPublishedArtifact,
  releasePackages,
  releaseTag,
  tarballIntegrity,
} from './release-metadata.mjs';

const expected = {
  name: 'opencode-magpie-plugin',
  version: '0.1.3',
  integrity: tarballIntegrity(Buffer.from('artifact')),
};
const published = {
  name: expected.name,
  version: expected.version,
  dist: { integrity: expected.integrity },
};

describe('release verification', () => {
  it('accepts an exact artifact when npm omits gitHead', () => {
    expect(() => assertPublishedArtifact(published, expected)).not.toThrow();
  });

  it('rejects different content even when version and gitHead look right', () => {
    expect(() =>
      assertPublishedArtifact(
        {
          ...published,
          gitHead: 'same-commit',
          dist: { integrity: tarballIntegrity(Buffer.from('other')) },
        },
        expected,
      ),
    ).toThrow('integrity');
  });

  it('rejects a missing integrity rather than silently weakening verification', () => {
    expect(() => assertPublishedArtifact({ ...published, dist: {} }, expected)).toThrow(
      'integrity',
    );
  });

  it('rejects a different version or package', () => {
    expect(() => assertPublishedArtifact({ ...published, version: '0.1.2' }, expected)).toThrow(
      'Expected',
    );
    expect(() => assertPublishedArtifact({ ...published, name: 'other' }, expected)).toThrow(
      'Expected',
    );
  });

  it('rejects runtime dependencies, including optional ones', () => {
    expect(() =>
      assertPublishedArtifact({ ...published, dependencies: { unexpected: '1.0.0' } }, expected),
    ).toThrow('runtime dependencies');
    expect(() =>
      assertPublishedArtifact(
        { ...published, optionalDependencies: { unexpected: '1.0.0' } },
        expected,
      ),
    ).toThrow('runtime dependencies');
  });
});

describe('independent workspace release planning', () => {
  it('dispatches both package directories without publishing the private root', () => {
    expect(releasePackages('workflow_dispatch', 'main')).toEqual([
      { name: 'opencode-magpie-plugin', directory: 'packages/opencode-magpie-plugin' },
      { name: 'claude-opencode-adapter', directory: 'packages/claude-opencode-adapter' },
    ]);
    expect(releasePackages('workflow_dispatch', 'main', 'claude-opencode-adapter')).toHaveLength(1);
  });

  it.each([
    ['v0.7.1', 'opencode-magpie-plugin'],
    ['opencode-magpie-plugin/v0.7.1', 'opencode-magpie-plugin'],
    ['claude-opencode-adapter/v0.1.0', 'claude-opencode-adapter'],
  ])('selects only the owning package for %s', (tag, name) => {
    const selected = releasePackages('push', tag);
    expect(selected).toHaveLength(1);
    expect(selected[0].name).toBe(name);
  });

  it('uses independent versions for package releases and supports prereleases', () => {
    expect(releaseTag({ name: 'opencode-magpie-plugin', version: '0.7.1' }, 'push', 'v0.7.1')).toBe(
      'v0.7.1',
    );
    expect(
      releaseTag(
        { name: 'claude-opencode-adapter', version: '0.1.0' },
        'workflow_dispatch',
        'main',
      ),
    ).toBe('claude-opencode-adapter/v0.1.0');
    expect(
      releaseTag(
        { name: 'claude-opencode-adapter', version: '0.2.0-beta.1' },
        'workflow_dispatch',
        'main',
      ),
    ).toBe('claude-opencode-adapter/v0.2.0-beta.1');
  });

  it('rejects unknown selections, wrong tags, private packages and runtime dependencies', () => {
    expect(() => releasePackages('workflow_dispatch', 'main', 'unknown')).toThrow();
    expect(() => releasePackages('push', 'unknown/v1.0.0')).toThrow();
    expect(() =>
      releaseTag({ name: 'claude-opencode-adapter', version: '0.1.0' }, 'push', 'v0.1.0'),
    ).toThrow('must match');
    for (const override of [
      { private: true },
      { version: '0.1.0+build' },
      { dependencies: { other: '*' } },
      { optionalDependencies: { other: '*' } },
    ]) {
      expect(() =>
        releaseTag(
          { name: 'claude-opencode-adapter', version: '0.1.0', ...override },
          'workflow_dispatch',
          'main',
        ),
      ).toThrow();
    }
  });
});
