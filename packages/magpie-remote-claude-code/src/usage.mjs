const HOUR = 3600;

const NAME_SPANS = [
  [/5\s*-?\s*h/i, 5 * HOUR],
  [/7\s*-?\s*d|week/i, 7 * 24 * HOUR],
];

export function spanSeconds(window, routing) {
  for (const [pattern, seconds] of NAME_SPANS) {
    if (pattern.test(window.name ?? '')) return seconds;
  }
  const span = Number(routing?.span);
  if (!span) return 0;
  return span > 1e9 ? Math.round(span / 1e9) : span;
}

export function claudeCards(cards) {
  return (Array.isArray(cards) ? cards : []).filter(
    (card) =>
      (card?.kind ?? 'subscription') === 'subscription' &&
      typeof card?.provider === 'string' &&
      card.provider &&
      (card.icon === 'claude' || /(^|\/)claude(?:-[-a-z0-9]+)?$/i.test(card.provider)),
  );
}

export function pickCard(cards, user = '') {
  const wanted = String(user).trim().toLowerCase();
  const claude = claudeCards(cards);
  if (wanted) return claude.find((card) => (card.user ?? '').toLowerCase() === wanted);
  return claude.find((card) => !card.error) ?? claude[0];
}

export function usageWithAccounts(primary, others) {
  if (!others.length) return usageOf(primary);
  const { error, windows, ...usage } = usageOf(primary);
  const label = (card) => card.user || card.name || card.provider;
  const rows = (card, { windows, error }, aside) => {
    if (error || !windows.length) {
      return [{ name: label(card), used: null, aside: true, display: error || 'No quota reading' }];
    }
    return windows.map((window) => ({
      ...window,
      name: `${label(card)} · ${window.name}`,
      aside: aside || window.aside,
    }));
  };
  return {
    ...usage,
    windows: [
      ...rows(primary, { windows, error }, false),
      ...others.flatMap((card) => rows(card, usageOf(card), true)),
    ],
  };
}

export function usageOf(card) {
  if (!card)
    return {
      error: 'The Remote Magpie has no Claude Code card yet; refresh it there',
      windows: [],
    };
  const windows = (card.windows ?? []).map((window, i) => {
    const routing = card.routing?.[i];
    const text = window.text === true;
    return {
      name: window.name,
      used: text ? null : window.used,
      resetsAt: window.resetsAt,
      resetSecs: window.resetSecs,
      display: window.display,
      amount: window.amount,
      limit: window.limit,
      unit: window.unit,
      span: spanSeconds(window, routing),
      model: routing?.model ?? '',
      aside: routing?.aside === true || text,
    };
  });
  return {
    plan: card.plan ?? '',
    user: card.user ?? '',
    ...(card.error ? { error: card.error } : {}),
    windows,
  };
}
