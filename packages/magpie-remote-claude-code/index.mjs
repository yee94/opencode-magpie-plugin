// Claude Code on another computer's Magpie, as a Claude Code provider.
//
// The sign-in is the Remote Magpie's address and a gateway key. Requests go to
// the remote's Anthropic API; its Claude Code usage cards are read back as this
// provider's usage, and the warm-up options start the remote's Claude windows.

import { readAccounts } from './src/accounts.mjs';
import { failureOf, networkError, quotaFailureOf, remoteRequest, rootOf } from './src/remote.mjs';
import { pickCard, usageOf } from './src/usage.mjs';
import { afterSend, emptyState, isIdle, plan, staggerTimes } from './src/warmup.mjs';

const ID = 'remote-claude-code';
const NAME = 'Remote CC';
const NPM = '@ai-sdk/anthropic';
const REFRESH_PATH = '/v1/magpie/quotas/refresh';
const CARDS_PATH = '/v1/magpie/quotas/cards';
const TICK = 60 * 1000;
const DEFAULT_REFRESH = 120;

const RESET_ALL = 'warm-on-reset';
const RESET_WEEK = 'warm-week-on-reset';
const DAILY = 'warm-daily';

const SWITCHES = [
  {
    key: RESET_ALL,
    label: 'Warm up on reset: weekly and 5-hour',
    description:
      "When a Claude window of the remote's account starts over, one tiny request through the Remote Magpie starts the next window at once.",
    labels: { zh: '窗口重置时预热：每周和 5 小时' },
    descriptions: {
      zh: '远端账号的 Claude 窗口重置后，立刻经 Remote Magpie 发一个极小请求，开启下一个窗口。',
    },
  },
  {
    key: RESET_WEEK,
    label: 'Warm up on reset: weekly only',
    description:
      'As above, for the weekly window alone. Ignored while the weekly and 5-hour switch is on.',
    labels: { zh: '窗口重置时预热：仅每周' },
    descriptions: { zh: '同上，只处理每周窗口。开启“每周和 5 小时”时忽略此项。' },
  },
  {
    key: DAILY,
    label: 'Daily warm-up',
    description: 'Start the 5-hour window at its scheduled time if it is not running then.',
    labels: { zh: '每日定时预热' },
    descriptions: {
      zh: '到达设定时刻且 5 小时窗口未运行时预热。',
    },
  },
];

const MODEL_BOOT = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];

function row(id, name, extra = {}) {
  const limit = extra.limit ?? { context: 0, output: 0 };
  return {
    id,
    name: name || id,
    limit,
    reasoning: extra.reasoning ?? true,
    tool_call: true,
    modalities: { input: ['text', 'image'], output: ['text'] },
    capabilities: {
      reasoning: extra.reasoning ?? true,
      toolcall: true,
      attachment: true,
      input: { text: true, image: true },
      output: { text: true },
    },
  };
}

const knownClaudeId = /^claude-(?:haiku|sonnet|opus|fable)(?:-[a-z0-9]+)+$/;

function modelId(id) {
  const short = id.startsWith('claude/') ? id.slice('claude/'.length) : id;
  return knownClaudeId.test(short) ? short : id;
}

function modelCatalog(data) {
  const rows = Object.create(null);
  const upstream = new Map();
  for (const m of data) {
    if (typeof m?.id !== 'string' || !m.id) continue;
    if (!/claude|anthropic/i.test(`${m.id} ${m.owned_by ?? ''} ${m.display_name ?? ''}`)) continue;
    const id = modelId(m.id);
    if (upstream.get(id) === id && m.id !== id) continue;
    upstream.set(id, m.id);
    const pretty = /^claude-([a-z]+)-(\d)(?:-(\d+))?$/.exec(id);
    const name = pretty
      ? `Claude ${pretty[1][0].toUpperCase()}${pretty[1].slice(1)} ${pretty[2]}${pretty[3] ? `.${pretty[3]}` : ''}`
      : id;
    const label = [m.display_name, m.name]
      .filter((value) => typeof value === 'string')
      .map((value) => value.trim())
      .find((value) => value && modelId(value) !== id);
    rows[id] = row(id, label || name, {
      limit: {
        context: Number(m.context_window ?? m.context_length ?? m.max_input_tokens) || 0,
        output: Number(m.max_output_tokens) || 0,
      },
      reasoning: m.reasoning !== false,
    });
  }
  return { rows, upstream };
}

function numberOption(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

function createPlugin({
  magpie,
  directory,
  options = {},
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  const switchOn = (key) => magpie?.option?.(ID, key) === true;
  const refreshEvery = () => numberOption(options?.refreshEvery, DEFAULT_REFRESH, 30, 3600) * 1000;
  const report = typeof magpie?.usage === 'function' ? (call) => magpie.usage(ID, call) : null;

  const accounts = new Map();
  const listAccounts =
    magpie?.remoteCCAccounts ??
    (typeof magpie?.account === 'function' && directory ? () => readAccounts(directory, ID) : null);
  let timer;

  function remember(auth, id = magpie?.account?.(ID)) {
    if (auth?.type !== 'api' || !auth.key || !auth.metadata?.url) return undefined;
    const root = rootOf(auth.metadata.url);
    const slot = id ?? JSON.stringify([root, auth.key]);
    let account = accounts.get(slot);
    if (account?.root !== root || account?.key !== auth.key) {
      account = { id, root, key: auth.key, state: emptyState(), refreshedAt: -Infinity };
      accounts.set(slot, account);
    }
    return account;
  }

  async function readCard(account) {
    const read = async (path, method) => {
      const res = await remoteRequest(fetchImpl, account.root, account.key, path, {
        method,
        timeout: 40000,
      });
      if (!res.ok) throw Object.assign(new Error('read'), { failure: await quotaFailureOf(res) });
      return (await res.json())?.data;
    };
    const card = pickCard(await read(CARDS_PATH, 'GET'), options?.claudeUser);
    if (!card || now() - account.refreshedAt < refreshEvery()) return card;
    account.refreshedAt = now();
    const query = new URLSearchParams({ provider: card.provider });
    if (card.user) query.set('user', card.user);
    try {
      const cards = await read(`${REFRESH_PATH}?${query}`, 'POST');
      return cards?.find((c) => c.provider === card.provider && c.user === card.user) ?? card;
    } catch (e) {
      if (e.failure?.signIn === 'expired') throw e;
      // A key can be allowed to see cards but not refresh them.
      return card;
    }
  }

  async function warmModel(account) {
    const configured = options?.warmModel ? String(options.warmModel) : '';
    try {
      const { upstream } = account.catalog ?? (await loadCatalog(account));
      if (configured) return upstream.get(modelId(configured)) ?? configured;
      const ids = [...upstream.values()];
      return ids.find((id) => /haiku/i.test(id)) ?? ids[0] ?? MODEL_BOOT[2];
    } catch {
      return configured || MODEL_BOOT[2];
    }
  }

  async function loadCatalog(account, signal) {
    const res = await remoteRequest(fetchImpl, account.root, account.key, '/v1/models', { signal });
    if (!res.ok) {
      const failure = failureOf(res);
      throw Object.assign(new Error(failure.error), { signIn: failure.signIn });
    }
    const { data } = await res.json();
    if (!Array.isArray(data)) throw new Error('Remote Magpie did not return a model list');
    account.catalog = modelCatalog(data);
    return account.catalog;
  }

  async function forward(account, input, init = {}) {
    const url = new URL(input);
    const base = new URL(`${account.root}/v1/`);
    if (
      url.origin === base.origin &&
      url.pathname.startsWith(base.pathname) &&
      typeof init.body === 'string'
    ) {
      let body;
      try {
        body = JSON.parse(init.body);
      } catch {}
      if (typeof body?.model === 'string' && knownClaudeId.test(modelId(body.model))) {
        const { upstream } = account.catalog ?? (await loadCatalog(account, init.signal));
        const id = upstream.get(modelId(body.model));
        if (!id) throw new Error('This Remote CC account does not list the requested Claude model');
        if (id !== body.model) {
          const headers = new Headers(init.headers);
          headers.delete('content-length');
          init = { ...init, headers, body: JSON.stringify({ ...body, model: id }) };
        }
      }
    }
    return fetchImpl(input, init);
  }

  async function sendWarmup(account, card) {
    if (account.warming) return false;
    account.warming = true;
    try {
      return await sendWarmupRequest(account, card);
    } finally {
      account.warming = false;
    }
  }

  async function sendWarmupRequest(account, card) {
    const model = await warmModel(account);
    const started = now();
    let status = 0;
    let error;
    try {
      const res = await remoteRequest(fetchImpl, account.root, account.key, '/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(card.user ? { 'x-magpie-account': encodeURIComponent(card.user) } : {}),
        },
        body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
        timeout: 120000,
      });
      status = res.status;
      await res.arrayBuffer();
      if (!res.ok) error = `HTTP ${res.status}`;
    } catch (e) {
      error = e?.message || 'request failed';
    }
    try {
      report?.({ kind: 'warmup', model, status, ms: now() - started, error });
    } catch {}
    return !error;
  }

  function scheduleOf(account, rank) {
    const own = options.warmAccounts?.[account.id];
    const mode =
      own?.warmMode ??
      options.warmMode ??
      (switchOn(RESET_ALL) ? 'all' : switchOn(RESET_WEEK) ? 'week' : 'off');
    const daily = own?.warmDaily ?? options.warmDaily ?? switchOn(DAILY);
    const given = options.warmGap;
    const gap = Number.isInteger(given) && given >= 0 && given < 1440 ? given : 120;
    const delay = (gap * rank) % 1440;
    const ats = staggerTimes(own?.warmAts ?? options.warmAts ?? ['06:00'], delay);
    return { mode, daily, ats };
  }

  async function warm(account, windows, card, { mode, daily, ats } = scheduleOf(account, 0)) {
    if (mode === 'off' && !daily) return [];
    const t = now();
    const p = plan({ windows, mode, ats, daily, state: account.state, now: t });
    if (!p.due.length) {
      account.state = afterSend({ state: account.state, plan: p, now: t, ok: true, windows });
      return [];
    }
    const ok = await sendWarmup(account, card);
    account.state = afterSend({ state: account.state, plan: p, now: t, ok, windows });
    return ok ? p.due : [];
  }

  let ticking = false;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      if (listAccounts) {
        const current = await listAccounts();
        if (!current) return;
        const ids = new Set(current.map(([id]) => id));
        for (const id of accounts.keys()) if (!ids.has(id)) accounts.delete(id);
        await Promise.all(
          current.map(async ([id, auth], rank) => {
            try {
              const account = remember(auth, id);
              if (account) await tickAccount(account, rank);
            } catch {}
          }),
        );
      } else {
        await Promise.all([...accounts.values()].map((account) => tickAccount(account, 0)));
      }
    } finally {
      ticking = false;
    }
  }

  async function tickAccount(account, rank) {
    const schedule = scheduleOf(account, rank);
    const { mode, daily, ats } = schedule;
    if (mode === 'off' && (!daily || !ats.length)) return;
    try {
      const card = await readCard(account);
      const usage = usageOf(card);
      if (!usage.error && usage.windows.length) await warm(account, usage.windows, card, schedule);
    } catch {}
  }

  function start() {
    if (timer || typeof setInterval !== 'function') return;
    timer = setInterval(tick, TICK);
    timer.unref?.();
  }

  if (listAccounts) start();

  return {
    config: async (cfg) => {
      cfg.provider ??= {};
      cfg.provider[ID] ??= {
        name: NAME,
        npm: NPM,
        api: 'https://remote-magpie.invalid/v1',
        models: Object.fromEntries(MODEL_BOOT.map((id) => [id, row(id, id)])),
      };
    },

    auth: {
      provider: ID,
      methods: [
        {
          type: 'api',
          label: 'Remote Magpie URL and API key',
          prompts: [
            {
              type: 'text',
              key: 'url',
              message: 'Remote Magpie URL',
              placeholder: 'http://host:3425',
              validate: (v) => {
                try {
                  return rootOf(v) ? undefined : 'Required';
                } catch (e) {
                  return e.message;
                }
              },
            },
            {
              type: 'password',
              key: 'token',
              message: 'Gateway API key',
              placeholder: 'sk-magpie-…',
              validate: (v) => (v?.trim() ? undefined : 'Required'),
            },
          ],
          async authorize(inputs = {}) {
            const key = String(inputs.token ?? inputs.key ?? '').trim();
            let root;
            try {
              root = rootOf(inputs.url);
            } catch (e) {
              return { type: 'failed', error: e.message };
            }
            if (!root || !key) return { type: 'failed', error: 'URL and API key are required' };
            try {
              const res = await remoteRequest(fetchImpl, root, key, '/v1/models');
              if (res.status === 401) return { type: 'failed', error: failureOf(res).error };
            } catch (e) {
              return { type: 'failed', error: networkError(e) };
            }
            return { type: 'success', key, metadata: { url: root } };
          },
        },
      ],

      async loader(getAuth) {
        const auth = await getAuth();
        const account = remember(auth);
        if (!account) return {};
        start();
        return {
          baseURL: `${account.root}/v1`,
          apiKey: auth.key,
          fetch: (input, init) => forward(account, input, init),
        };
      },

      options: SWITCHES,

      async warmup(getAuth) {
        const account = remember(await getAuth());
        if (!account) throw new Error('Remote Magpie is not signed in');
        const card = await readCard(account);
        const usage = usageOf(card);
        if (usage.error) throw new Error(usage.error);
        const window = usage.windows.find((w) => w.name === '5 hours');
        if (!window || window.used == null) throw new Error('No 5-hour quota reading');
        if (!isIdle(window, now())) return { skip: 'running' };
        if (!(await sendWarmup(account, card))) throw new Error('Remote Magpie warm-up failed');
        return { ok: true };
      },

      async usage(getAuth) {
        const auth = await getAuth();
        const account = remember(auth);
        if (!account)
          return { error: 'Remote Magpie is not signed in', signIn: 'kept', windows: [] };
        start();
        try {
          const card = await readCard(account);
          const usage = usageOf(card);
          if (!listAccounts && !usage.error && usage.windows.length) {
            warm(account, usage.windows, card).catch(() => {});
          }
          return { ...usage, signIn: usage.error ? 'kept' : 'renewed' };
        } catch (e) {
          if (e.failure) return { ...e.failure, windows: [], signIn: e.failure.signIn ?? 'kept' };
          return { error: networkError(e), windows: [], signIn: 'kept' };
        }
      },
    },

    provider: {
      id: ID,
      async models(provider, { auth, signal } = {}) {
        const account = remember(auth);
        if (!account) return provider.models;
        return (await loadCatalog(account, signal)).rows;
      },
    },

    _tick: tick,
  };
}

export const MagpieRemoteClaudeCodePlugin = async ({ magpie, directory } = {}, options = {}) => {
  const { _tick, ...hooks } = createPlugin({ magpie, directory, options });
  return hooks;
};

export const _internal = { createPlugin, modelCatalog, ID, SWITCHES };
