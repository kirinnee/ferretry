/**
 * CFG-LEAK-R / CFG-LEAK-W at the agent's door: `config_read` shows a ferret the MASKED text of a file that passes its
 * check (the case the old withhold never covered: `args: [--token, <v>]` is a valid file), and `config_write` of a text
 * that writes the mask back is refused in today's "Nothing was written" words. The mask itself is `shown-text.test.ts`.
 *
 * Fake only: every value is shaped like a credential and is none.
 */
import { describe, expect, test } from 'bun:test';
import { AgentConfigCallSchema, type AgentConfigCall } from '../../../contract/agent-config.ts';
import { agentConfig } from '../../../host/config/agent.ts';
import { createConfigFiles } from '../../../host/config/service.ts';
import { createMemoryHostFs } from '../../../host/state/memory-fs.ts';
import { captureLog, HOME, manualClock } from './support.ts';
import { HIDDEN, mcpDef, OTHER_VALUE, VALUE } from './masked-support.ts';

const FILE = `${HOME}/config/mcp/srv.yaml`;
const PATH = 'mcp/srv.yaml';
const ferretStanding = { credential: { kind: 'authenticated', tokenClass: 'ferret', ferret: 'wren' } };
/** Fake only: shaped like a provider key, never one. */
const FAKE_KEY = `sk-ant-api03-${'A'.repeat(90)}`;

function world() {
  const fs = createMemoryHostFs();
  const files = createConfigFiles({
    home: HOME,
    fs,
    clock: manualClock(),
    log: captureLog(),
    binary: 'fy',
    defs: [{ plugin: 'mcp', def: mcpDef }],
  });
  const agent = agentConfig({
    writer: () => files.writer(),
    control: () => ({ allows: async () => true }),
    status: () => files.status(),
    home: HOME,
    binary: 'fy',
    now: () => '2026-01-01T00:00:00.000Z',
  });
  const run = (body: Record<string, unknown>) =>
    agent.run(AgentConfigCallSchema.parse(body) as AgentConfigCall, ferretStanding);
  return { fs, files, run, disk: () => fs.snapshot().get(FILE) };
}

const SECRET_FILE = `command: srv\nargs:\n  - --token\n  - ${VALUE}\n`;

describe('config_read', () => {
  test('S6 CFG-LEAK-R config_read hides --token <v> in a file that PASSES its check', async () => {
    const w = world();
    w.fs.seed(FILE, SECRET_FILE);
    await w.files.reload();
    const answer = await w.run({ tool: 'config.read', path: PATH });
    expect(answer.text).toBe(`command: srv\nargs:\n  - --token\n  - ${HIDDEN}\n`);
    expect(JSON.stringify(answer)).not.toContain(VALUE);
    expect(answer.summary).toBe(
      `${PATH} (ok); 1 value in it is hidden (${HIDDEN}) and stays as it is unless your edit changes it.`,
    );
    // The file is valid: this is the case the withhold of a failing file never reached.
    expect(answer.issues).toEqual([]);
  });

  test('CFG-LEAK-R config_read counts the hidden values in the summary', async () => {
    const w = world();
    w.fs.seed(FILE, `args:\n  - --token\n  - ${VALUE}\n  - --api-key=${OTHER_VALUE}\n`);
    await w.files.reload();
    const answer = await w.run({ tool: 'config.read', path: PATH });
    expect(answer.summary).toBe(
      `${PATH} (ok); 2 values in it are hidden (${HIDDEN}) and stay as they are unless your edit changes them.`,
    );
  });

  test('R-0072 config_read of a file with nothing to hide is byte-identical, with today’s summary', async () => {
    const w = world();
    const text = '# mine\nargs: [ --verbose,   --port ]\n';
    w.fs.seed(FILE, text);
    await w.files.reload();
    const answer = await w.run({ tool: 'config.read', path: PATH });
    expect(answer.text).toBe(text);
    expect(answer.summary).toBe(`${PATH} (ok).`);
  });

  test('S6 config_read of a file that holds a raw secret withholds the text, in today’s words', async () => {
    const w = world();
    w.fs.seed(FILE, `note: ${FAKE_KEY}\n`);
    await w.files.reload();
    const answer = await w.run({ tool: 'config.read', path: PATH });
    expect(answer.text).toBe('');
    expect(answer.summary).toBe(
      `${PATH} (invalid); its text is not shown because it holds a raw secret, which the owner must move into the secret store.`,
    );
  });

  test('CFG-LEAK-R config_read of a value the mask cannot hide safely withholds the text and says so', async () => {
    const w = world();
    w.fs.seed(FILE, `note: &n ${VALUE}\nargs:\n  - --token\n  - *n\n`);
    await w.files.reload();
    const answer = await w.run({ tool: 'config.read', path: PATH });
    expect(answer.text).toBe('');
    expect(JSON.stringify(answer)).not.toContain(VALUE);
    expect(answer.summary).toBe(
      `${PATH} (ok); its text is not shown because a value in it could not be hidden safely.`,
    );
  });

  test('R-0072 config_read of a file that is not there yet gives the starter and no hidden count', async () => {
    const w = world();
    await w.files.reload();
    const answer = await w.run({ tool: 'config.read', path: PATH });
    expect(answer.summary).toBe(`${PATH} does not exist yet; this is the starter a new one begins with.`);
    expect(answer.text).toStartWith('# yaml-language-server: $schema=');
  });
});

describe('config_write', () => {
  test('S6 CFG-LEAK-W config_write of a masked text is refused with today’s "Nothing was written" summary', async () => {
    const w = world();
    w.fs.seed(FILE, SECRET_FILE);
    await w.files.reload();
    const read = await w.run({ tool: 'config.read', path: PATH });
    const answer = await w.run({ tool: 'config.write', path: PATH, text: String(read.text), etag: String(read.etag) });
    expect(answer.summary).toBe(`Nothing was written: ${PATH} does not check. Fix each issue and try again.`);
    expect(answer.issues).toEqual([
      {
        path: PATH,
        line: 4,
        column: 1,
        severity: 'error',
        message: `a value hidden from the device or agent that read this file is still ${HIDDEN} here; nothing was written`,
        fix: `type the real value at the machine, or replace ${HIDDEN} with \${secret:NAME}`,
      },
    ]);
    expect(JSON.stringify(answer)).not.toContain(VALUE);
    expect(w.disk()).toBe(SECRET_FILE);
  });

  test('S6 CFG-LEAK-W config_write of a new --token <v> is refused raw_secret and never repeats the value', async () => {
    const w = world();
    await w.files.reload();
    const answer = await w.run({ tool: 'config.write', path: PATH, text: `args:\n  - --token\n  - ${VALUE}\n` });
    expect(answer.summary).toBe(`Nothing was written: ${PATH} does not check. Fix each issue and try again.`);
    expect(answer.issues?.[0]?.message).toEndWith(
      'this looks like a raw secret given to a flag (an API key, token or password)',
    );
    expect(JSON.stringify(answer)).not.toContain(VALUE);
    expect(w.disk()).toBeUndefined();
  });

  test('CFG-LEAK-W config_write keeps a pair the file already holds: an edit of another line is written', async () => {
    const w = world();
    w.fs.seed(FILE, SECRET_FILE);
    await w.files.reload();
    const answer = await w.run({ tool: 'config.write', path: PATH, text: `${SECRET_FILE}limit: 3\n` });
    expect(answer.summary).toBe(`Wrote ${PATH}; it is in effect.`);
    expect(w.disk()).toContain(VALUE);
  });

  test('CFG-LEAK-W config_validate stays the plain check: a file that holds a pair checks, as it loads', async () => {
    const w = world();
    const answer = await w.run({ tool: 'config.validate', path: PATH, text: SECRET_FILE });
    expect(answer).toEqual({ summary: `${PATH} checks.`, issues: [] });
  });
});
