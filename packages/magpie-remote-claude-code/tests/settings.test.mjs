import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';

const page = (file) => readFileSync(new URL(`../page/${file}`, import.meta.url), 'utf8');

it('saves from a click without submitting a form in Magpie’s sandbox', async () => {
  const form = { reportValidity: vi.fn(() => true) };
  const fields = { disabled: true };
  const options = { warmMode: 'off', warmDaily: true, warmAts: [], refreshEvery: 180 };
  const elements = {
    mode: {},
    daily: {},
    gap: {},
    add: {},
    save: {},
    status: {},
    times: { querySelectorAll: () => [{ value: '08:00' }] },
  };
  const set = vi.fn(async () => {});
  runInNewContext(page('settings.js'), {
    document: {
      getElementById: (id) => elements[id],
      querySelector: (tag) => (tag === 'form' ? form : fields),
      documentElement: { style: {} },
    },
    magpie: {
      ready: Promise.resolve({ lang: 'en' }),
      options: { get: async () => options, set },
      onAction: vi.fn(),
    },
  });
  await vi.waitFor(() => expect(fields.disabled).toBe(false));
  elements.gap.valueAsNumber = 90;
  expect(page('index.html')).toMatch(/<button type="button" id="save">/);
  form.reportValidity.mockReturnValueOnce(false);
  await elements.save.onclick();
  expect(set).not.toHaveBeenCalled();
  await elements.save.onclick();
  expect(set).toHaveBeenCalledWith({ ...options, warmAts: ['08:00'], warmGap: 90 });
  expect(elements.status.textContent).toBe('Settings saved.');
});
