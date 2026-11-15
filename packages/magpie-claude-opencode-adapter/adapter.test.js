import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { onProvider } from './adapter.middleware.js';

const identity = 'You are an AI agent running in OpenCode, a coding agent harness.';
const context = {
  agent: 'opencode',
  protocol: 'anthropic',
  provider: { id: 'renamed-subscription', account: 'claude' },
};
const request = () => ({
  model: 'claude/example',
  system: `${identity}\nUse /home/opencode and opencode.ai. Call opencode_tool.`,
  tools: [{ name: 'opencode_tool', input_schema: { type: 'object' } }],
  messages: [{ role: 'user', content: 'Read the file.' }],
});

describe('Claude Code / OpenCode adapter', () => {
  it('declares a middleware-only package so Magpie does not initialize onProvider as a plugin', () => {
    const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
    expect(manifest.magpie.middleware).toBe('./adapter.middleware.js');
    expect(manifest).not.toHaveProperty('main');
    expect(manifest).not.toHaveProperty('exports');
  });

  it('moves instructions and renames only the harness identity without mutating input', () => {
    const input = request();
    const snapshot = JSON.stringify(input);
    const output = onProvider(input, context);
    expect(output.system).toBeUndefined();
    expect(output.messages[0].content[0].text).toContain('You are an AI coding agent.');
    expect(output.messages[0].content[0].text).not.toContain(identity);
    expect(output.messages[0].content[0].text).not.toContain('Yuri');
    expect(output.messages[0].content[0].text).toContain(
      'Use /home/opencode and opencode.ai. Call opencode_tool.',
    );
    expect(output.tools).toBe(input.tools);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(onProvider(input, context)).toEqual(output);
    expect(onProvider(output, context)).toBeUndefined();
  });

  it('preserves blocks, cache metadata, images and later tool histories', () => {
    const input = request();
    const cached = { type: 'text', text: identity, cache_control: { type: 'ephemeral' } };
    input.system = [cached, { type: 'text', text: 'Project rules' }];
    const image = { type: 'image', source: { type: 'base64', data: 'fixture' } };
    input.messages[0].content = [image];
    input.messages.push(
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'done' }] },
    );
    const output = onProvider(input, context);
    expect(output.messages[0].content[0].cache_control).toEqual(cached.cache_control);
    expect(output.messages[0].content[2]).toBe(image);
    expect(output.messages.slice(1)).toEqual(input.messages.slice(1));
  });

  it('supports controlled system-placement and identity-only comparisons', () => {
    const input = request();
    const output = onProvider(input, { ...context, options: { placement: 'system' } });
    expect(output.system).toContain('You are an AI coding agent.');
    expect(output.messages).toBe(input.messages);
    expect(
      onProvider(input, { ...context, options: { renameIdentity: false } }).messages[0].content[0]
        .text,
    ).toBe(input.system);
  });

  it('requires explicit opt-in for callers identified as another Magpie gateway', () => {
    const ctx = { ...context, agent: 'magpie' };
    expect(onProvider(request(), ctx)).toBeUndefined();
    const output = onProvider(request(), {
      ...ctx,
      options: { agents: ['opencode', 'magpie'] },
    });
    expect(output.system).toBeUndefined();
    expect(output.messages[0].content[0].text).toContain('You are an AI coding agent.');
  });

  it.each([
    { id: 'anthropic' },
    { id: 'claude', account: undefined },
    { id: 'cursor', account: 'cursor' },
    { id: 'workbuddy', account: 'workbuddy' },
    { id: 'remote-magpie', account: 'remote' },
    { id: 'openai', account: 'codex' },
  ])('never rewrites Claude-model requests through another channel: %j', (provider) => {
    const input = { ...request(), model: 'claude-sonnet-5-5' };
    const before = JSON.stringify(input);
    expect(onProvider(input, { ...context, provider })).toBeUndefined();
    expect(JSON.stringify(input)).toBe(before);
  });

  it('isolates provider retries from the rewritten Claude subscription attempt', () => {
    const input = request();
    const before = JSON.stringify(input);
    expect(onProvider(input, context).system).toBeUndefined();
    expect(
      onProvider(input, { ...context, provider: { id: 'cursor', account: 'cursor' } }),
    ).toBeUndefined();
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each([
    { ...context, agent: 'other' },
    { ...context, agent: 'yuri' },
    { ...context, protocol: 'openai' },
    { ...context, provider: { id: 'claude' } },
    { ...context, provider: { account: 'codex' } },
    { ...context, options: { enabled: false } },
  ])('leaves unrelated requests unchanged: %j', (ctx) => {
    expect(onProvider(request(), ctx)).toBeUndefined();
  });

  it.each([
    { system: [{ type: 'unknown', text: 'keep' }] },
    { system: '' },
    { messages: [] },
    { messages: [{ role: 'user', content: null }] },
    { messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a' }] }] },
  ])('does not lose unsupported content: %j', (override) => {
    const input = { ...request(), ...override };
    const snapshot = JSON.stringify(input);
    expect(onProvider(input, context)).toBeUndefined();
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
