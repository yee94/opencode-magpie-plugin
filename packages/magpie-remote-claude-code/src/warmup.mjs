const MINUTE = 60e3;
const HOUR = 3600e3;
const FIVE_HOURS = 5 * HOUR;
const WEEK = 7 * 24 * HOUR;

export const SLACK = 10 * MINUTE;
export const DAILY_SLACK = HOUR;
export const RETRY = 15 * MINUTE;
export const RETRY_MAX = 4 * HOUR;
export const EXPECTED = [
  { name: '5 hours', span: FIVE_HOURS },
  { name: '7 days', span: WEEK },
];

export function clock(at) {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(at).trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return undefined;
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

export function validTimes(ats) {
  const list = Array.isArray(ats) ? ats : typeof ats === 'string' && ats ? [ats] : [];
  return [
    ...new Set(
      list.flatMap((at) => {
        const c = clock(at);
        return c ? [`${String(c.hour).padStart(2, '0')}:${String(c.minute).padStart(2, '0')}`] : [];
      }),
    ),
  ].sort();
}

export function staggerTimes(ats, delayMinutes) {
  const minutes =
    Number.isInteger(delayMinutes) && delayMinutes >= 0 && delayMinutes < 1440 ? delayMinutes : 0;
  return validTimes(ats)
    .map((at) => {
      const { hour, minute } = clock(at);
      const shifted = (hour * 60 + minute + minutes) % 1440;
      return `${String(Math.floor(shifted / 60)).padStart(2, '0')}:${String(shifted % 60).padStart(2, '0')}`;
    })
    .sort();
}

function at(now, days, c) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, c.hour, c.minute);
}

export function dayStart(ats, now) {
  let latest;
  for (const text of ats) {
    const c = clock(text);
    if (!c) continue;
    let t = at(now, 0, c);
    if (t > now) t = at(now, -1, c);
    if (!latest || t > latest) latest = t;
  }
  return latest;
}

export function nextDayStart(ats, now) {
  let first;
  for (const text of ats) {
    const start = dayStart([text], now);
    if (!start) continue;
    const next = at(start, 1, clock(text));
    if (!first || next < first) first = next;
  }
  return first;
}

export function startKey(t) {
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`;
}

function asOf(window, now) {
  const resets = window.resetsAt ? Date.parse(window.resetsAt) : undefined;
  if (resets !== undefined && Number.isFinite(resets) && resets <= now) {
    return { ...window, used: 0, resetsAt: undefined, resetMs: undefined };
  }
  const ms = Number.isFinite(resets)
    ? resets
    : window.resetSecs > 0
      ? now + window.resetSecs * 1000
      : undefined;
  return { ...window, resetMs: ms };
}

export function isIdle(window, now) {
  const w = asOf(window, now);
  const span = (window.span ?? 0) * 1000;
  return (w.used ?? 0) === 0 && (w.resetMs === undefined || w.resetMs - now >= span - SLACK);
}

function withExpected(windows) {
  const out = [...windows];
  for (const e of EXPECTED) {
    if (!windows.some((w) => w.name === e.name))
      out.push({ name: e.name, span: e.span / 1000, used: 0 });
  }
  return out;
}

function runsShorter(windows, spanMs, now) {
  return windows.some(
    (w) =>
      w.span > 0 &&
      w.span * 1000 < spanMs &&
      !w.aside &&
      !w.model &&
      w.used != null &&
      !isIdle(w, now),
  );
}

export function emptyState() {
  return { windows: {}, daily: '' };
}

export function plan({ windows, mode, ats, daily, state, now }) {
  const due = [];
  const days = {};
  const seen = new Set();
  let waitDay = false;
  const considered = withExpected(windows).filter(
    (w) => w.span > 0 && !w.aside && !w.model && w.used !== null,
  );
  for (const w of considered) {
    const spanMs = w.span * 1000;
    const short = spanMs < 24 * HOUR;
    const absent = !windows.some((x) => x.name === w.name) && runsShorter(windows, spanMs, now);
    if (absent) continue;
    const onReset = mode === 'all' || (mode === 'week' && !short);
    if (!onReset && !(short && daily && ats.length)) continue;
    const idle = isIdle(w, now);
    seen.add(w.name);
    const held = state.windows[w.name];
    let reset = onReset && idle && now >= (held?.retry ?? 0);
    const start = short && daily ? dayStart(ats, new Date(now)) : undefined;
    const next = daily ? nextDayStart(ats, new Date(now)) : undefined;
    const heldForDay = Boolean(next) && next.getTime() - now < spanMs;
    const key = start && now - start.getTime() <= DAILY_SLACK ? startKey(start) : '';
    const dailyDue = Boolean(key) && state.daily !== key && idle;
    if (reset && short && ats.length && heldForDay && !dailyDue) reset = false;
    if (short && idle && !dailyDue && ats.length && heldForDay) waitDay = true;
    if (reset || dailyDue) {
      due.push(w.name);
      if (dailyDue) days[w.name] = key;
    }
  }
  const names = waitDay ? due.filter((n) => !/7|week/i.test(n)) : due;
  return { due: names, day: Object.values(days)[0] ?? '', seen: [...seen] };
}

export function afterSend({ state, plan: p, now, ok, windows }) {
  const next = { windows: { ...state.windows }, daily: state.daily };
  for (const name of p.seen) {
    const window = windows.find((w) => w.name === name);
    if (window && !isIdle(window, now) && !p.due.includes(name)) delete next.windows[name];
  }
  for (const name of p.due) {
    const prev = next.windows[name] ?? { idle: 0 };
    next.windows[name] = {
      idle: prev.idle + 1,
      retry: now + (ok ? Math.min(RETRY * 2 ** prev.idle, RETRY_MAX) : RETRY),
    };
  }
  if (ok && p.day) next.daily = p.day;
  return next;
}
