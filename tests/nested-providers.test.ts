import { describe, expect, it } from 'vitest';
import { buildInventory, type MagpieModel } from '../src/catalog.js';

const rows: MagpieModel[] = [
  ['astra', 'Astra'],
  ['cursor', 'Cursor'],
  ['workbuddy', 'WorkBuddy'],
  ['auto', 'routing group'],
].map(([source, label]) => ({
  id: `remote-magpie/${source}/gpt-6-astra`,
  owned_by: 'remote-magpie',
  display_name: 'GPT-6-Astra',
  magpie_label: `GPT-6-Astra · ${label} · Remote magpie`,
}));

describe('nested gateway providers', () => {
  it.each([
    false,
    true,
  ])('separates upstream sources regardless of row order (reverse=%s)', (reverse) => {
    const inventory = buildInventory(
      reverse ? [...rows].reverse() : rows,
      'http://localhost:3425/v1',
    );
    expect(inventory).toHaveLength(4);
    for (const row of rows) {
      const source = row.id.split('/')[1];
      const entry = inventory.find((item) => item.info.id === `magpie-remote-magpie%2F${source}`);
      expect(entry?.info.name).toBe(row.magpie_label?.split(' · ').slice(1).join(' · '));
      expect(entry?.models[0]).toMatchObject({
        id: `${source}/gpt-6-astra`,
        name: 'GPT-6-Astra',
        modelID: row.id,
      });
    }
  });

  it('retains context SKU and Fast wire IDs with older gateway labels', () => {
    const row: MagpieModel = {
      id: 'remote-magpie/cursor/gpt-5.6-terra@272k',
      owned_by: 'remote-magpie',
      magpie_label: 'cursor/gpt-5.6-terra@272k · Remote magpie',
      service_tiers: ['priority'],
    };
    const [entry] = buildInventory([row], 'http://localhost:3425/v1');
    expect(entry.info.name).toBe('Cursor · Remote magpie');
    expect(entry.models.map((model) => model.modelID)).toEqual([row.id, row.id]);
    expect(entry.models[0].id).toBe('cursor/gpt-5.6-terra@272k');
  });
});
