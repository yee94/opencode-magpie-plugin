import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function readAccounts(directory, provider) {
  try {
    const all = JSON.parse(await readFile(join(directory, 'plugin-auth.json'), 'utf8'));
    return Object.keys(all)
      .filter((id) => id === provider || id.startsWith(`${provider}#`))
      .sort()
      .flatMap((id) => {
        const auth = all[id];
        return auth?.type === 'api' && auth.key && auth.metadata?.url ? [[id, auth]] : [];
      });
  } catch {
    return null;
  }
}
