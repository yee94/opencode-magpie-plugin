const originalIdentity = 'You are an AI agent running in OpenCode, a coding agent harness.';
const yuriIdentity = 'You are an AI agent running in Yuri, a coding agent harness.';

export function onProvider(body, ctx) {
  const options = ctx.options ?? {};
  const agents = options.agents ?? ['opencode', 'yuri'];
  const placement = options.placement ?? 'user';
  if (
    options.enabled === false ||
    !Array.isArray(agents) ||
    !agents.includes(ctx.agent) ||
    ctx.provider?.account !== 'claude' ||
    ctx.protocol !== 'anthropic'
  ) {
    return;
  }
  if (placement !== 'user' && placement !== 'system') {
    throw new Error('placement must be user or system');
  }
  const system = body.system;
  const blocks = typeof system === 'string' ? [{ type: 'text', text: system }] : system;
  if (
    !Array.isArray(blocks) ||
    blocks.length === 0 ||
    !blocks.every((block) => block?.type === 'text' && typeof block.text === 'string') ||
    !blocks.some((block) => block.text.trim())
  ) {
    return;
  }
  const renamed = blocks.map((block) => ({
    ...block,
    text:
      options.renameIdentity === false
        ? block.text
        : block.text.replace(originalIdentity, yuriIdentity),
  }));
  if (placement === 'system') {
    return { ...body, system: typeof system === 'string' ? renamed[0].text : renamed };
  }
  if (!Array.isArray(body.messages)) return;
  const index = body.messages.findIndex((message) => message.role === 'user');
  if (index < 0) return;
  const first = body.messages[index];
  const content =
    typeof first.content === 'string' ? [{ type: 'text', text: first.content }] : first.content;
  if (!Array.isArray(content)) return;
  // Preserve tool-result adjacency; compaction can leave a tool result as the first user turn.
  if (content.some((block) => block?.type === 'tool_result')) return;
  const messages = body.messages.slice();
  messages[index] = { ...first, content: [...renamed, ...content] };
  const result = { ...body, messages };
  delete result.system;
  return result;
}
