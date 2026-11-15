import { createHash } from 'node:crypto';

const packages = [
  { name: 'opencode-magpie-plugin', directory: 'packages/opencode-magpie-plugin' },
  { name: 'claude-opencode-adapter', directory: 'packages/claude-opencode-adapter' },
];

export const releasePackages = (event, ref, requested = 'all') => {
  if (event === 'workflow_dispatch') {
    const selected = packages.filter((pkg) => requested === 'all' || pkg.name === requested);
    if (!selected.length) throw new Error(`Unknown package: ${requested}`);
    return selected;
  }
  if (event !== 'push') throw new Error(`Unsupported release event: ${event}`);
  const selected = packages.filter(
    (pkg) =>
      ref.startsWith(`${pkg.name}/v`) ||
      (pkg.name === 'opencode-magpie-plugin' && ref.startsWith('v')),
  );
  if (selected.length !== 1) throw new Error(`Unknown release tag: ${ref}`);
  return selected;
};

export const releaseTag = (pkg, event, ref) => {
  const semver =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;
  if (
    pkg.private ||
    !packages.some((entry) => entry.name === pkg.name) ||
    !semver.test(pkg.version) ||
    Object.keys(pkg.dependencies ?? {}).length ||
    Object.keys(pkg.optionalDependencies ?? {}).length
  ) {
    throw new Error(
      'Release requires a known public package, valid SemVer and no runtime dependencies',
    );
  }
  const tag = `${pkg.name}/v${pkg.version}`;
  if (event === 'workflow_dispatch') return tag;
  if (
    event !== 'push' ||
    (ref !== tag && !(pkg.name === 'opencode-magpie-plugin' && ref === `v${pkg.version}`))
  ) {
    throw new Error(`Tag ${ref} must match ${tag}`);
  }
  return ref;
};

export const tarballIntegrity = (bytes) =>
  `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

export const assertPublishedArtifact = (published, expected) => {
  if (published.name !== expected.name || published.version !== expected.version) {
    throw new Error(
      `Expected ${expected.name}@${expected.version}, got ${published.name}@${published.version}`,
    );
  }
  if (published.dist?.integrity !== expected.integrity) {
    throw new Error('Published tarball integrity differs from the artifact built for this tag');
  }
  if (
    Object.keys(published.dependencies ?? {}).length ||
    Object.keys(published.optionalDependencies ?? {}).length
  ) {
    throw new Error('Published package unexpectedly has runtime dependencies');
  }
};
