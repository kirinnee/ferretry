/**
 * A plugin's schema may mark an issue as a raw secret (`params: { rawSecret: true }`). When ANY issue a file has is so
 * marked the kernel classifies the refusal as `raw_secret`, exactly as for a key its own scan found: `config_read` withholds the
 * text. ONE marked issue is enough, whatever else is wrong with the file; a file with no marked issue stays a `schema` refusal.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { AgentConfigCallSchema } from '../../../contract/agent-config.ts';
import { defineConfig } from '../../../contract/index.ts';
import { agentConfig } from '../../../host/config/agent.ts';
import { checkConfigText } from '../../../host/config/check.ts';
import { createConfigFiles } from '../../../host/config/service.ts';
import { createMemoryHostFs } from '../../../host/state/memory-fs.ts';
import { captureLog, HOME, manualClock } from './support.ts';

/** Not a key shape: the plugin's own rule decides, so the kernel's scan finds nothing in it. */
const HELD = 'plugin rule says this is held';

const markedDef = defineConfig({
  file: 'voice.yaml',
  schema: z.strictObject({ note: z.string().optional(), other: z.string().optional() }).check(ctx => {
    if (ctx.value.note === HELD) {
      ctx.issues.push({
        code: 'custom',
        message: '"note" holds a secret',
        input: 'note',
        path: ['note'],
        params: { rawSecret: true },
      });
    }
    if (ctx.value.other === HELD) {
      ctx.issues.push({ code: 'custom', message: '"other" is not allowed', input: 'other', path: ['other'] });
    }
  }),
  axis: 'configure',
  loosens: () => [],
});

describe('a schema issue marked rawSecret', () => {
  test('is a raw_secret refusal when every issue is marked', () => {
    const checked = checkConfigText(markedDef, 'voice.yaml', `note: ${HELD}\n`, 'fy');
    expect(checked).toMatchObject({ ok: false, reason: 'raw_secret' });
  });

  test('is a raw_secret refusal when ONE issue is marked beside an unmarked one', () => {
    const checked = checkConfigText(markedDef, 'voice.yaml', `note: ${HELD}\nother: ${HELD}\n`, 'fy');
    expect(checked).toMatchObject({ ok: false, reason: 'raw_secret' });
  });

  test('stays a schema refusal for an ordinary schema failure', () => {
    const checked = checkConfigText(markedDef, 'voice.yaml', 'surprise: 1\n', 'fy');
    expect(checked).toMatchObject({ ok: false, reason: 'schema' });
  });

  test('config_read withholds the text of a file whose only fault is a marked issue', async () => {
    const fs = createMemoryHostFs();
    const files = createConfigFiles({
      home: HOME,
      fs,
      clock: manualClock(),
      log: captureLog(),
      binary: 'fy',
      defs: [{ plugin: 'voice', def: markedDef }],
    });
    const agent = agentConfig({
      writer: () => files.writer(),
      control: () => ({ allows: async () => true }),
      status: () => files.status(),
      home: HOME,
      binary: 'fy',
      now: () => '2026-01-01T00:00:00.000Z',
    });
    const path = `${HOME}/config/voice.yaml`;
    fs.seed(path, 'note: fine\n');
    await files.reload();
    fs.seed(path, `note: ${HELD}\n`);
    await files.reload();
    const standing = { credential: { kind: 'authenticated', tokenClass: 'ferret', ferret: 'wren' } };
    const answer = await agent.run(AgentConfigCallSchema.parse({ tool: 'config.read', path: 'voice.yaml' }), standing);
    expect(answer.text).toBe('');
    expect(answer.summary).toContain('its text is not shown because it holds a raw secret');
    expect(JSON.stringify(answer)).not.toContain(HELD);
  });
});
