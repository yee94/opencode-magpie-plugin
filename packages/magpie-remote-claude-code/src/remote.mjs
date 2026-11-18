const SUFFIXES = [
  '/v1/messages/count_tokens',
  '/v1/messages',
  '/v1/chat/completions',
  '/v1/responses',
  '/v1/models',
  '/v1',
];

export function rootOf(input) {
  let root = String(input ?? '')
    .trim()
    .replace(/\/+$/, '');
  if (!root) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(root)) root = `http://${root}`;
  for (const suffix of SUFFIXES) {
    if (root.endsWith(suffix)) {
      root = root.slice(0, -suffix.length);
      break;
    }
  }
  const url = new URL(root);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Expected a plain http(s) address of the Remote Magpie');
  }
  return url.href.replace(/\/+$/, '');
}

export function remoteRequest(fetchImpl, root, key, path, init = {}) {
  return fetchImpl(`${root}${path}`, {
    ...init,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${key}`,
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      ...(init.headers ?? {}),
    },
    signal: init.signal ?? AbortSignal.timeout(init.timeout ?? 20000),
    redirect: 'error',
  });
}

export function failureOf(res) {
  if (res.status === 401)
    return { error: 'Remote Magpie refused this key; sign in again', signIn: 'expired' };
  return { error: `Remote Magpie answered HTTP ${res.status}` };
}

export async function quotaFailureOf(res) {
  if (res.status === 404 || res.status === 405) {
    return { error: 'Remote Magpie does not share quota cards on this URL; check its version' };
  }
  if (res.status !== 403) return failureOf(res);
  const body = await res.text().catch(() => '');
  let error;
  try {
    error = JSON.parse(body)?.error;
  } catch {}
  if (error?.code === 'gateway_key_held' || error?.code === 'quota_forbidden') {
    return { error: 'This gateway key cannot see Claude quotas; check its Quotas permissions' };
  }
  if (/shared on the local network/i.test(error?.message ?? '')) {
    return { error: 'Turn on Share on local network on the Remote Magpie to read its quotas' };
  }
  if (/^error code:\s*1010\s*$/i.test(body)) {
    return { error: 'The proxy in front of Remote Magpie refused quota access (HTTP 403 / 1010)' };
  }
  return failureOf(res);
}

export function networkError(error) {
  return `Remote Magpie unreachable: ${error?.cause?.code || error?.message || 'network error'}`;
}
