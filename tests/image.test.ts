import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { GatewayConnection } from '../src/gateway.js';
import {
  drawImage,
  IMAGE_SKILL_ID,
  listImageModels,
  markdownImage,
  registerImageSkill,
  registerImageTools,
} from '../src/image.js';
import type { SkillEditor, ToolEditor } from '../src/opencode.js';

const servers: ReturnType<typeof createServer>[] = [];
const PNG = Buffer.from('89504e470d0a1a0a0000', 'hex');

const gateway = async (handler: Parameters<typeof createServer>[0]): Promise<GatewayConnection> => {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    token: 'secret',
    remote: false,
    ensure: async () => {},
  };
};

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe('magpie image', () => {
  it('lists only the image rows, asks for them, and drops a remote copy of a local model', async () => {
    let drawers: string | string[] | undefined;
    let auth: string | undefined;
    const connection = await gateway((request, response) => {
      drawers = request.headers['x-magpie-drawers'];
      auth = request.headers.authorization;
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          data: [
            { id: 'codex/gpt-5.5' },
            { id: 'codex/gpt-image-2', kind: 'image', display_name: 'GPT Image' },
            { id: 'remote-magpie/codex/gpt-image-2', kind: 'image', display_name: 'GPT Image' },
            { id: 'remote-magpie/grok/imagine', kind: 'image', display_name: 'Imagine' },
            { id: 'xai/video', kind: 'video' },
          ],
        }),
      );
    });
    expect(await listImageModels(connection)).toEqual([
      { id: 'codex/gpt-image-2', name: 'GPT Image' },
      { id: 'remote-magpie/grok/imagine', name: 'Imagine' },
    ]);
    expect(drawers).toBe('1');
    expect(auth).toBe('Bearer secret');
  });

  it('draws with the named model, saves the bytes under their real type, and returns the path', async () => {
    let received: Record<string, unknown> | undefined;
    const connection = await gateway((request, response) => {
      let text = '';
      request.on('data', (chunk) => {
        text += chunk;
      });
      request.on('end', () => {
        received = JSON.parse(text);
        response.setHeader('Content-Type', 'application/json');
        response.end(
          JSON.stringify({
            model: 'codex/gpt-image-2',
            data: [{ b64_json: PNG.toString('base64') }],
          }),
        );
      });
    });
    const result = await drawImage(connection, { prompt: 'a magpie', model: 'codex/gpt-image-2' });
    expect(received).toMatchObject({ model: 'codex/gpt-image-2', prompt: 'a magpie', n: 1 });
    expect(result.path).toMatch(/magpie-images\/image-\d+\.png$/);
    expect(await readFile(result.path)).toEqual(PNG);
  });

  it('leaves the model out when none is named, so Magpie uses its own default', async () => {
    let received: Record<string, unknown> | undefined;
    const connection = await gateway((request, response) => {
      let text = '';
      request.on('data', (chunk) => {
        text += chunk;
      });
      request.on('end', () => {
        received = JSON.parse(text);
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }));
      });
    });
    await drawImage(connection, { prompt: 'a magpie' });
    expect(received).not.toHaveProperty('model');
  });

  it("passes Magpie's refusal on as written", async () => {
    const connection = await gateway((_request, response) => {
      response.statusCode = 429;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ error: { message: 'usage limit reached until Nov 4' } }));
    });
    await expect(drawImage(connection, { prompt: 'a magpie' })).rejects.toThrow(
      'usage limit reached until Nov 4',
    );
  });

  it('registers two code-mode tools in one namespace and a short skill', () => {
    const tools: Parameters<ToolEditor['add']>[0][] = [];
    registerImageTools(
      { namespace: () => {}, add: (tool) => tools.push(tool) },
      { baseURL: '', token: '', remote: false, ensure: async () => {} },
    );
    expect(tools.map((tool) => tool.name)).toEqual(['image_list', 'image_gen']);
    expect(
      tools.every((tool) => tool.options?.codemode && tool.options.namespace === 'magpie'),
    ).toBe(true);

    const skills: Parameters<SkillEditor['add']>[0][] = [];
    registerImageSkill({ add: (skill) => skills.push(skill) }, '/plugin');
    expect(skills[0]?.id).toBe(IMAGE_SKILL_ID);
    // Its description rides in every session, so it stays one line.
    expect(skills[0]?.description.length).toBeLessThan(120);
    expect(skills[0]?.content).toContain('image_gen');
  });

  it('returns the saved file as a Markdown image, bracketing a path that would not parse', () => {
    expect(markdownImage('/tmp/magpie-images/image-1.png')).toBe(
      '![image](/tmp/magpie-images/image-1.png)',
    );
    expect(markdownImage('/tmp/my images/a (1).png')).toBe('![image](</tmp/my images/a (1).png>)');
  });
});
