import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ access: vi.fn(), spawn: vi.fn() }));
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  access: mocks.access,
  readFile: vi.fn(),
}));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));

import { ensureGateway, INSTALL_MESSAGE, startCommand } from '../src/gateway.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

it('gives the installation URL when the gateway is down and no executable exists', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('connection refused')));
  mocks.access.mockRejectedValue(new Error('ENOENT'));
  await expect(ensureGateway('http://127.0.0.1:3425')).rejects.toThrow(INSTALL_MESSAGE);
  expect(mocks.spawn).not.toHaveBeenCalled();
});

it('starts one detached gateway for concurrent callers and verifies readiness', async () => {
  let running = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      if (!running) throw new TypeError('connection refused');
      return Response.json({ name: 'magpie' });
    }),
  );
  mocks.access.mockResolvedValue(undefined);
  const unref = vi.fn();
  mocks.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { unref });
    queueMicrotask(() => {
      running = true;
      child.emit('spawn');
    });
    return child;
  });
  await Promise.all([
    ensureGateway('http://127.0.0.1:3425'),
    ensureGateway('http://127.0.0.1:3425'),
  ]);
  expect(mocks.spawn).toHaveBeenCalledTimes(1);
  expect(mocks.spawn).toHaveBeenCalledWith(expect.any(String), ['serve'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  expect(unref).toHaveBeenCalledOnce();
});

it('opens the Magpie app, not a windowless gateway, when the executable is the bundled app', () => {
  // A windowless `magpie serve` takes the port a window would use, which is what hides
  // Magpie's Routing view. Starting from Magpie.app must therefore start the app.
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  try {
    expect(startCommand('/Applications/Magpie.app/Contents/MacOS/magpie')).toEqual({
      mode: 'app',
      args: ['tray'],
    });
    // The installer links the app into ~/.local/bin, so the symlink path must count as the app.
    expect(startCommand('/Users/me/.local/bin/magpie')).toEqual({ mode: 'serve', args: ['serve'] });
    expect(startCommand('/opt/homebrew/bin/magpie')).toEqual({ mode: 'serve', args: ['serve'] });
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true });
  }
});

it('propagates a spawn failure and allows a later retry', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('connection refused')));
  mocks.access.mockResolvedValue(undefined);
  mocks.spawn.mockImplementation(() => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('error', new Error('EACCES')));
    return child;
  });
  await expect(ensureGateway('http://127.0.0.1:3425')).rejects.toThrow('EACCES');
  await expect(ensureGateway('http://127.0.0.1:3425')).rejects.toThrow('EACCES');
  expect(mocks.spawn).toHaveBeenCalledTimes(2);
});
