import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { _internal, MagpieRemoteClaudeCodePlugin } from '../index.mjs';
import { rootOf } from '../src/remote.mjs';
import { pickCard, usageOf } from '../src/usage.mjs';
import { afterSend, emptyState, plan, staggerTimes, validTimes } from '../src/warmup.mjs';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const HOUR = 3600e3;
const idle5 = { name: '5 hours', span: 5 * 3600, used: 0 };
const idle7 = { name: '7 days', span: 7 * 86400, used: 0 };

const card = {
  provider: 'claude',
  kind: 'subscription',
  user: 'a@example.com',
  plan: 'Max',
  windows: [
    { name: '5 hours', used: 30, resetsAt: '2026-11-18T12:00:00Z' },
    { name: '7 days · Opus', used: 5 },
    { name: 'Usage credits', used: 10, text: true },
  ],
  routing: [{ span: 18000e9 }, { span: 604800e9, model: 'opus' }, { span: 0, aside: true }],
};

describe('manifest', () => {
  it('is a provider plugin with Claude icon and no runtime dependencies', () => {
    expect(manifest.name).toBe('magpie-remote-claude-code');
    expect(manifest.magpie.icon).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.main).toBe('./index.mjs');
  });

  it('packages the settings page and registers a provider menu action', () => {
    expect(manifest.files).toContain('page');
    expect(manifest.magpie.actions).toContainEqual(
      expect.objectContaining({ id: 'remote-cc-warmup', menu: 'provider' }),
    );
    const html = readFileSync(new URL(`../${manifest.magpie.page.file}`, import.meta.url), 'utf8');
    expect(html).toContain('_magpie/bridge.js');
    expect(html).toContain('id="gap"');
    expect(manifest.magpie.options.warmAts).toEqual(['06:00']);
  });
});

describe('remote address', () => {
  it('normalizes however it was typed', () => {
    expect(rootOf('host:3425')).toBe('http://host:3425');
    expect(rootOf('https://a.example/v1/')).toBe('https://a.example');
    expect(() => rootOf('ftp://x')).toThrow();
  });
});

describe('usage', () => {
  it('maps the remote card with routing facts', () => {
    const usage = usageOf(pickCard([{ provider: 'codex' }, card]));
    expect(usage.plan).toBe('Max');
    expect(usage.windows.map((w) => [w.name, w.span, w.model, w.aside])).toEqual([
      ['5 hours', 18000, '', false],
      ['7 days · Opus', 604800, 'opus', false],
      ['Usage credits', 0, '', true],
    ]);
    expect(usage.windows[2].used).toBeNull();
  });

  it('selects an account by user and reports a missing card', () => {
    expect(pickCard([card], 'b@example.com')).toBeUndefined();
    expect(usageOf(undefined).error).toMatch(/no Claude Code card/);
  });
});

describe('warm-up plan', () => {
  const base = { ats: [], daily: false, state: emptyState() };

  it('does nothing when off', () => {
    const p = plan({ ...base, windows: [idle5, idle7], mode: 'off', now: Date.now() });
    expect(p.due).toEqual([]);
  });

  it('warms idle windows by mode and backs off after a send', () => {
    const now = Date.now();
    expect(plan({ ...base, windows: [idle5, idle7], mode: 'week', now }).due).toEqual(['7 days']);
    const p = plan({ ...base, windows: [idle5, idle7], mode: 'all', now });
    expect(p.due).toEqual(['5 hours', '7 days']);
    const state = afterSend({ state: base.state, plan: p, now, ok: true, windows: [idle5, idle7] });
    expect(
      plan({ ...base, state, windows: [idle5, idle7], mode: 'all', now: now + HOUR / 6 }).due,
    ).toEqual([]);
    expect(
      plan({ ...base, state, windows: [idle5, idle7], mode: 'all', now: now + HOUR }).due,
    ).toEqual(['5 hours', '7 days']);
  });

  it('leaves running windows and starts one whose reset passed', () => {
    const now = Date.now();
    const running = { ...idle5, used: 20, resetsAt: new Date(now + 2 * HOUR).toISOString() };
    expect(plan({ ...base, windows: [running, idle7], mode: 'all', now }).due).toEqual(['7 days']);
    const passed = { ...running, resetsAt: new Date(now - 1000).toISOString() };
    expect(plan({ ...base, windows: [passed], mode: 'all', now }).due).toContain('5 hours');
  });

  it('starts the 5-hour window at the day time once', () => {
    const at = new Date();
    at.setHours(6, 5, 0, 0);
    const ats = ['06:00'];
    const p = plan({
      ats,
      daily: true,
      state: emptyState(),
      windows: [idle5],
      mode: 'off',
      now: at.getTime(),
    });
    expect(p.due).toEqual(['5 hours']);
    const state = afterSend({
      state: emptyState(),
      plan: p,
      now: at.getTime(),
      ok: true,
      windows: [idle5],
    });
    expect(
      plan({ ats, daily: true, state, windows: [idle5], mode: 'off', now: at.getTime() + 60e3 })
        .due,
    ).toEqual([]);
    const late = at.getTime() + 2 * HOUR;
    expect(
      plan({ ats, daily: true, state: emptyState(), windows: [idle5], mode: 'off', now: late }).due,
    ).toEqual([]);
  });

  it('validates times of day', () => {
    expect(validTimes(['6:00', '25:00', '06:00', 'x'])).toEqual(['06:00']);
    expect(staggerTimes(['06:00', '23:30'], 60)).toEqual(['00:30', '07:00']);
    expect(staggerTimes(['06:00'], -1)).toEqual(['06:00']);
  });

  it('reserves time for a daily start only if daily warm-up is enabled', () => {
    const now = new Date(2026, 10, 18, 5, 30).getTime();
    const args = { ...base, ats: ['06:00'], windows: [idle5, idle7], mode: 'all', now };
    expect(plan(args).due).toEqual(['5 hours', '7 days']);
    expect(plan({ ...args, daily: true }).due).toEqual([]);
  });
});

describe('plugin hooks', () => {
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const auth = { type: 'api', key: 'sk-magpie-1', metadata: { url: 'http://remote:3425' } };

  it('signs in with URL and key and points the loader at the remote', async () => {
    const fetchImpl = vi.fn(async () => json({ data: [] }));
    const hooks = _internal.createPlugin({ fetchImpl });
    const method = hooks.auth.methods[0];
    expect(method.prompts.map((p) => p.key)).toEqual(['url', 'token']);
    expect(await method.authorize({ url: 'remote:3425/v1', token: ' sk-magpie-1 ' })).toEqual({
      type: 'success',
      key: 'sk-magpie-1',
      metadata: { url: 'http://remote:3425' },
    });
    expect(fetchImpl.mock.calls[0][1].headers['x-api-key']).toBe('sk-magpie-1');
    expect(fetchImpl.mock.calls[0][1].headers.authorization).toBe('Bearer sk-magpie-1');
    expect(await hooks.auth.loader(async () => auth)).toMatchObject({
      baseURL: 'http://remote:3425/v1',
      apiKey: 'sk-magpie-1',
    });
    const refused = _internal.createPlugin({ fetchImpl: async () => json({}, 401) });
    expect((await refused.auth.methods[0].authorize({ url: 'remote', token: 'k' })).type).toBe(
      'failed',
    );
  });

  it('discovers the Claude card and refreshes using the gateway’s exact card identity', async () => {
    let now = 1_000_000;
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push(`${init.method ?? 'GET'} ${url}`);
      const scopedCard = { ...card, provider: 'claude-kathy', icon: 'claude' };
      if (init.method === 'POST' && !url.endsWith('provider=claude-kathy&user=a%40example.com')) {
        return json({ error: { code: 'quota_forbidden' } }, 403);
      }
      return json({ data: [scopedCard] });
    });
    const hooks = _internal.createPlugin({
      fetchImpl,
      now: () => now,
      options: { refreshEvery: 60 },
    });
    const first = await hooks.auth.usage(async () => auth);
    expect(first.plan).toBe('Max');
    now += 10_000;
    await hooks.auth.usage(async () => auth);
    now += 61_000;
    await hooks.auth.usage(async () => auth);
    expect(calls).toEqual([
      'GET http://remote:3425/v1/magpie/quotas/cards',
      'POST http://remote:3425/v1/magpie/quotas/refresh?provider=claude-kathy&user=a%40example.com',
      'GET http://remote:3425/v1/magpie/quotas/cards',
      'GET http://remote:3425/v1/magpie/quotas/cards',
      'POST http://remote:3425/v1/magpie/quotas/refresh?provider=claude-kathy&user=a%40example.com',
    ]);
    const denied = _internal.createPlugin({ fetchImpl: async () => json({}, 401) });
    expect(await denied.auth.usage(async () => auth)).toMatchObject({ signIn: 'expired' });
  });

  it('keeps readable quota windows if the refresh is forbidden', async () => {
    const hooks = _internal.createPlugin({
      fetchImpl: async (_url, init) =>
        init.method === 'POST'
          ? json({ error: { code: 'quota_forbidden' } }, 403)
          : json({ data: [{ ...card, provider: 'claude-kathy' }] }),
    });
    expect(await hooks.auth.usage(async () => auth)).toMatchObject({
      signIn: 'renewed',
      windows: [{ name: '5 hours' }, { name: '7 days · Opus' }, { name: 'Usage credits' }],
    });
  });

  it('does not send a warm-up when the gateway has no visible Claude card', async () => {
    const fetchImpl = vi.fn(async () => json({ data: [] }));
    const hooks = _internal.createPlugin({ fetchImpl, magpie: { option: () => true } });
    expect(await hooks.auth.usage(async () => auth)).toMatchObject({ windows: [] });
    await hooks._tick();
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'http://remote:3425/v1/magpie/quotas/cards',
      'http://remote:3425/v1/magpie/quotas/cards',
    ]);
  });

  it('manual warm-up skips a running window and pins an idle request to the card’s account', async () => {
    let window = card.windows[0];
    const sent = [];
    const fetchImpl = async (url, init) => {
      if (url.endsWith('/v1/messages')) {
        sent.push(init);
        return json({});
      }
      return json({ data: [{ ...card, windows: [window] }] });
    };
    const hooks = _internal.createPlugin({
      fetchImpl,
      now: () => Date.parse('2026-11-18T10:00:00Z'),
      options: { warmModel: 'claude-haiku' },
    });
    expect(await hooks.auth.warmup(async () => auth)).toEqual({ skip: 'running' });
    expect(sent).toHaveLength(0);
    window = { name: '5 hours', used: 0 };
    expect(await hooks.auth.warmup(async () => auth)).toEqual({ ok: true });
    expect(sent[0].headers['x-magpie-account']).toBe('a%40example.com');
  });

  it('warms official Magpie’s saved accounts at separate times without prior chat or usage', async () => {
    let now = new Date(2026, 10, 18, 6, 0).getTime();
    const second = { ...auth, metadata: { url: 'http://other:3425' } };
    const sent = [];
    const directory = await mkdtemp(join(tmpdir(), 'remote-cc-auth-'));
    try {
      await writeFile(
        join(directory, 'plugin-auth.json'),
        JSON.stringify({
          'remote-claude-code#b': second,
          'remote-claude-code': auth,
          unrelated: auth,
        }),
      );
      const hooks = _internal.createPlugin({
        now: () => now,
        directory,
        magpie: { account: () => 'remote-claude-code' },
        options: {
          warmMode: 'off',
          warmDaily: true,
          warmAts: ['06:00'],
          warmModel: 'claude-haiku',
        },
        fetchImpl: async (url, init) => {
          if (url.endsWith('/v1/messages')) {
            sent.push([new URL(url).hostname, init.headers['x-magpie-account']]);
            return json({});
          }
          return json({
            data: [
              {
                ...card,
                user: new URL(url).hostname === 'other' ? 'b@example.com' : 'a@example.com',
                windows: [{ name: '5 hours', used: 0 }],
              },
            ],
          });
        },
      });
      await hooks._tick();
      expect(sent).toEqual([['remote', 'a%40example.com']]);
      now += HOUR;
      await hooks._tick();
      expect(sent).toEqual([['remote', 'a%40example.com']]);
      now += HOUR;
      await hooks._tick();
      expect(sent).toEqual([
        ['remote', 'a%40example.com'],
        ['other', 'b%40example.com'],
      ]);
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  it('sends one warm-up request when a switch is on and the window is idle', async () => {
    const sent = [];
    const fetchImpl = vi.fn(async (url, init) => {
      if (url.endsWith('/v1/models')) return json({ data: [{ id: 'claude/claude-haiku-5-5' }] });
      if (url.endsWith('/v1/messages')) {
        sent.push(JSON.parse(init.body));
        return json({});
      }
      return json({
        data: [
          {
            ...card,
            windows: [
              { name: '5 hours', used: 0 },
              { name: '7 days', used: 0 },
            ],
            routing: undefined,
          },
        ],
      });
    });
    const usage = vi.fn();
    const magpie = { option: (_p, key) => key === 'warm-on-reset', usage };
    const hooks = _internal.createPlugin({ fetchImpl, magpie });
    await hooks.auth.usage(async () => auth);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ model: 'claude/claude-haiku-5-5', max_tokens: 1 });
    expect(usage).toHaveBeenCalledWith(
      'remote-claude-code',
      expect.objectContaining({ kind: 'warmup' }),
    );
  });

  it('registers Remote CC and declares the warm-up switches', async () => {
    const hooks = await MagpieRemoteClaudeCodePlugin({}, {});
    const config = {};
    await hooks.config(config);
    expect(config.provider['remote-claude-code'].name).toBe('Remote CC');
    expect(hooks.auth.options.map((o) => o.key)).toEqual([
      'warm-on-reset',
      'warm-week-on-reset',
      'warm-daily',
    ]);
  });

  it('lists only Claude models of the remote', async () => {
    const hooks = _internal.createPlugin({
      fetchImpl: async () => json({ data: [{ id: 'claude/claude-sonnet-5-5' }, { id: 'gpt-6' }] }),
    });
    const models = await hooks.provider.models({ models: {} }, { auth });
    expect(Object.keys(models)).toEqual(['claude-sonnet-5-5']);
  });

  it('uses readable labels when the remote repeats a model ID as its name', () => {
    const { rows } = _internal.modelCatalog([
      { id: 'claude-haiku-5-5', display_name: 'claude-haiku-5-5' },
      { id: 'claude/claude-sonnet-5-5', display_name: 'claude/claude-sonnet-5-5' },
      { id: 'claude-opus-4-5-latest', display_name: 'Claude Opus 4.5 (latest)' },
    ]);
    expect(Object.values(rows).map((model) => model.name)).toEqual([
      'Claude Haiku 5.5',
      'Claude Sonnet 5.5',
      'Claude Opus 4.5 (latest)',
    ]);
  });

  it('lists one shared model ID and sends each account its own upstream ID', async () => {
    const alt = { ...auth, metadata: { url: 'http://other:3425' } };
    const shared = 'claude-sonnet-5-5';
    const sent = [];
    const hooks = _internal.createPlugin({
      fetchImpl: async (url, init) => {
        const host = new URL(url).hostname;
        if (url.endsWith('/v1/models')) {
          return json({
            data:
              host === 'remote'
                ? [{ id: shared }]
                : [{ id: `claude/${shared}` }, { id: 'claude/claude-sonnet-5' }],
          });
        }
        sent.push([
          host,
          JSON.parse(init.body).model,
          new Headers(init.headers).has('content-length'),
        ]);
        return json({});
      },
    });
    const [a, b] = await Promise.all(
      [auth, alt].map((auth) => hooks.provider.models({ models: {} }, { auth })),
    );
    expect(Object.keys(a)).toEqual([shared]);
    expect(Object.keys(b)).toEqual([shared, 'claude-sonnet-5']);
    for (const account of [auth, alt]) {
      const loader = await hooks.auth.loader(async () => account);
      await loader.fetch(`${loader.baseURL}/messages`, {
        method: 'POST',
        headers: { 'content-length': '30' },
        body: JSON.stringify({ model: shared }),
      });
    }
    expect(sent).toEqual([
      ['remote', shared, true],
      ['other', `claude/${shared}`, false],
    ]);
    const loader = await hooks.auth.loader(async () => auth);
    await expect(
      loader.fetch(`${loader.baseURL}/messages`, {
        method: 'POST',
        body: JSON.stringify({ model: 'claude-sonnet-5' }),
      }),
    ).rejects.toThrow(/does not list/);
    expect(sent).toHaveLength(2);
  });
});
