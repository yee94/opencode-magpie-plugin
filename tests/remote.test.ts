import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Inventory, MagpieModel } from '../src/catalog.js';
import { loadFastModelIDs } from '../src/fast-models.js';
import { fetchModels, resolveConnection } from '../src/gateway.js';
import { setupPlugin } from '../src/index.js';
import type { PluginContext, ProviderEditor } from '../src/opencode.js';

vi.mock('../src/fast-models.js', () => ({ loadFastModelIDs: vi.fn(async () => new Set()) }));
vi.mock('../src/catalog-cache.js', async (original) => ({
  ...(await original<typeof import('../src/catalog-cache.js')>()),
  loadCatalogCache: async () => ({ data: undefined, path: '', stale: false }),
}));

const servers: ReturnType<typeof createServer>[] = [];
const cleanups: (() => Promise<void>)[] = [];
const serve = async (handler: Parameters<typeof createServer>[0]): Promise<string> => {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

describe('remote Magpie gateway', () => {
  it('keeps an arbitrary API path without adding v1 or inspecting local configuration', async () => {
    vi.stubEnv('MAGPIE_ADDR', 'invalid-local-setting');
    const connection = await resolveConnection({
      remote: {
        baseURL: 'https://example.com/rewrite/api/',
        token: 'fixture-key',
      },
    });
    expect(connection.baseURL).toBe('https://example.com/rewrite/api');
    await expect(connection.ensure()).resolves.toBeUndefined();
  });

  it.each([
    null,
    [],
    {},
    { baseURL: '/relative', token: 'fixture-secret' },
    { baseURL: 'ftp://example.com/v1', token: 'fixture-secret' },
    { baseURL: 'https://user:fixture-secret@example.com/v1', token: 'fixture-secret' },
    { baseURL: 'https://example.com/v1?key=fixture-secret', token: 'fixture-secret' },
    { baseURL: 'https://example.com/v1#fragment', token: 'fixture-secret' },
    { baseURL: 'https://example.com/v1', token: '' },
    { baseURL: 'https://example.com/v1', token: 'fixture-secret\n' },
    { baseURL: 'https://example.com/v1', token: 'fixture-secret', typo: true },
  ])('rejects invalid remote options without echoing secrets (%#)', async (remote) => {
    const error = await resolveConnection({ remote }).catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('options.remote');
    expect((error as Error).message).not.toContain('fixture-secret');
  });

  it('discovers and refreshes behind a rewrite, passes credentials to all protocols and scopes session headers', async () => {
    vi.stubEnv('MAGPIE_ADDR', 'invalid-local-setting');
    let rows: MagpieModel[] = [
      { id: 'cursor/chat', owned_by: 'cursor', native_endpoints: ['/v1/chat/completions'] },
      { id: 'cursor/responses', owned_by: 'cursor', native_endpoints: ['/v1/responses'] },
      { id: 'cursor/messages', owned_by: 'cursor', native_endpoints: ['/v1/messages'] },
    ];
    let status = 200;
    const paths: string[] = [];
    const origin = await serve((request, response) => {
      paths.push(request.url ?? '');
      expect(request.headers.authorization).toBe('Bearer fixture-key');
      expect(request.headers['x-magpie-prices']).toBe('1');
      if (request.url !== '/rewrite/api/models') {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: rows }));
    });
    let inventory: Inventory = [];
    let transform = (_editor: ProviderEditor) => {};
    let hook = async (_event: { sessionID: string; request: Request }) => {};
    const ctx = {
      options: { remote: { baseURL: `${origin}/rewrite/api/`, token: 'fixture-key' } },
      provider: {
        transform: async (callback: typeof transform) => {
          transform = callback;
          return { dispose: async () => {} };
        },
        reload: async () => {
          inventory = [];
          transform({ add: (entry) => inventory.push(entry) });
        },
      },
      session: {
        hook: async (name: string, callback: typeof hook) => {
          if (name === 'http.request') hook = callback;
          return { dispose: async () => {} };
        },
      },
    } as unknown as PluginContext;
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const cleanup = await setupPlugin(ctx);
    if (cleanup) cleanups.push(cleanup);
    expect(inventory[0].info.headers?.Authorization).toBe('Bearer fixture-key');
    expect(inventory[0].models.map((model) => model.package)).toEqual([
      '@opencode/ai/providers/openai-compatible',
      '@opencode/ai/providers/openai-compatible/responses',
      '@opencode/ai/providers/anthropic-compatible',
    ]);
    for (const entry of [inventory[0].info, ...inventory[0].models]) {
      expect(entry.settings).toMatchObject({
        baseURL: `${origin}/rewrite/api`,
        apiKey: 'fixture-key',
      });
    }
    for (const endpoint of ['chat/completions', 'responses', 'messages']) {
      const request = new Request(`${origin}/rewrite/api/${endpoint}`);
      await hook({ sessionID: 'remote-session', request });
      expect(request.headers.get('X-Magpie-Session')).toBe('remote-session');
    }
    for (const url of [
      `${origin}/v1/responses`,
      `${origin}/rewrite/api-other/responses`,
      'https://other.example/rewrite/api/responses',
    ]) {
      const request = new Request(url);
      await hook({ sessionID: 'remote-session', request });
      expect(request.headers.has('X-Magpie-Session')).toBe(false);
    }
    rows = [{ id: 'workbuddy/new', owned_by: 'workbuddy' }];
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(inventory[0].info.id).toBe('magpie-workbuddy'));
    status = 401;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(inventory[0].info.id).toBe('magpie-workbuddy');
    expect(loadFastModelIDs).not.toHaveBeenCalled();
    expect(paths).toEqual(Array(paths.length).fill('/rewrite/api/models'));
    expect(paths.length).toBeGreaterThanOrEqual(3);
  });

  it('reports authentication failures and does not follow discovery redirects', async () => {
    let requests = 0;
    let status = 401;
    const origin = await serve((_request, response) => {
      requests++;
      response.writeHead(status, { location: '/another-service', 'content-type': 'text/plain' });
      response.end('private error body');
    });
    await expect(fetchModels(`${origin}/api`, 'fixture-key')).rejects.toThrow('HTTP 401');
    status = 302;
    await expect(fetchModels(`${origin}/api`, 'fixture-key')).rejects.toThrow();
    expect(requests).toBe(2);
  });
});
