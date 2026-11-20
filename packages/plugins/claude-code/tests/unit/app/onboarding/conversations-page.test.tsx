/** The conversations page: the owner's one-way words, one key written, and nothing written on a pick. */
import { interact, type Mounted, mount, must } from '@ferretry/app/testing';
import { afterEach, describe, expect, it } from 'bun:test';
import { ConversationsPage, ONE_WAY } from '../../../../app/features/onboarding/import/conversations-page.tsx';
import { historyRead, withHostHistory } from '../../../../app/features/onboarding/import/history-config.ts';
import { type Call, scripted, stepHarness } from '../../../fixtures/onboarding/harness.ts';

const mounted: Mounted[] = [];
afterEach(async () => {
  for (const view of mounted.splice(0)) await view.unmount();
});
const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 20; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
};

const FILE = 'binary: /fake/bin/claude # mine\npermissionMode: skip\n';
const file = (text: string) => ({ path: 'harness-claude-code.yaml', text, etag: 'e1', exists: true });
const WROTE = { path: 'harness-claude-code.yaml', etag: 'e2', outcome: 'applied' };

const open = async (text: string, calls: Call[] = []) => {
  const run = stepHarness();
  const view = await mount(
    <ConversationsPage
      client={scripted({ 'GET /v1/config/file': file(text), 'PUT /v1/config/file': WROTE }, calls)}
      step={run.step}
    />,
  );
  mounted.push(view);
  await settle();
  return { view, run };
};
const click = (view: Mounted, selector: string) =>
  interact(() => must(view.container.querySelector<HTMLElement>(selector), selector).click());

describe('the config text', () => {
  it('reads on by default, and every YAML form of the key', () => {
    expect(historyRead('')).toEqual({ kind: 'on' });
    expect(historyRead(FILE)).toEqual({ kind: 'on' });
    expect(historyRead('hostHistory: false\n')).toEqual({ kind: 'off' });
    expect(historyRead('{hostHistory: true}\n')).toEqual({ kind: 'on' });
    expect(historyRead('hostHistory: "no"\n')).toEqual({ kind: 'unknown' });
    expect(historyRead('- a\n')).toEqual({ kind: 'unknown' });
    expect(historyRead('# ‹hidden›: the text of this file is not shown because it holds a raw secret\n')).toEqual({
      kind: 'unknown',
    });
  });
  it('sets only hostHistory and keeps the other keys and comments', () => {
    expect(withHostHistory(FILE, false)).toBe(`${FILE}hostHistory: false\n`);
    expect(withHostHistory('hostHistory: false # why\npermissionMode: auto\n', true)).toBe(
      'hostHistory: true # why\npermissionMode: auto\n',
    );
  });
});

describe('the conversations page', () => {
  it('says the owner’s words exactly and shows the saved value', async () => {
    const { view, run } = await open(FILE);
    expect(view.container.querySelector('[data-conversations-one-way]')?.textContent).toBe(ONE_WAY);
    expect(ONE_WAY).toBe(
      'One way: Ferretry reads them and never changes them. A conversation is copied only when you continue it here.',
    );
    expect((view.container.querySelector('input[value="on"]') as HTMLInputElement).checked).toBe(true);
    expect(run.events).toEqual(['ready']);
  });

  it('a pick writes nothing and holds nothing (Back and Later stay free); only "Use …" writes, one key, against the etag it read', async () => {
    const calls: Call[] = [];
    const { view, run } = await open(FILE, calls);
    await click(view, 'input[value="off"]');
    expect(calls.map(call => call.route)).toEqual(['GET /v1/config/file']);
    expect(run.events).toEqual(['ready']);
    expect(view.container.querySelector('[data-conversations-confirm]')?.textContent).toContain('Next keeps');
    await click(view, '[data-conversations-confirm] button');
    await settle();
    expect(calls.find(call => call.route === 'PUT /v1/config/file')?.init?.body).toEqual({
      path: 'harness-claude-code.yaml',
      text: `${FILE}hostHistory: false\n`,
      etag: 'e1',
    });
    expect(run.events.slice(-3)).toEqual(['busy:Saving…', 'done', 'busy:null']);
  });

  it('"Keep …" drops the pick, writes nothing and records done', async () => {
    const calls: Call[] = [];
    const { view, run } = await open('hostHistory: false\n', calls);
    await click(view, 'input[value="on"]');
    const buttons = view.container.querySelectorAll<HTMLButtonElement>('[data-conversations-confirm] button');
    await interact(() => must(buttons[1], 'keep').click());
    expect(calls.map(call => call.route)).toEqual(['GET /v1/config/file']);
    expect(run.events.slice(-2)).toEqual(['ready', 'done']);
  });

  it('an unreadable file says so and writes nothing', async () => {
    const { view } = await open('hostHistory: [broken\n');
    expect(view.container.querySelector('[data-mode-unknown]')).not.toBeNull();
    expect(view.container.querySelector('input[type="radio"]')).toBeNull();
  });
});
