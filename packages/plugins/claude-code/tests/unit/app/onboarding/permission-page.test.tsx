/** The permission page: it names the real flag, shows the current mode, and writes only `permissionMode`. */
import { interact, type Mounted, mount, must } from '@ferretry/app/testing';
import { readConfigText } from '@ferretry/std/yaml';
import { afterEach, describe, expect, it } from 'bun:test';
import {
  PermissionPage,
  permissionRead,
  withPermissionMode,
} from '../../../../app/features/onboarding/permission-page.tsx';
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

const WITHHELD_TEXT =
  '# ‹hidden›: the text of this file is not shown because it holds a raw secret, which the owner must move into the secret store; edit it at the machine\n';
const FILE =
  'binary: /fake/bin/claude # my own\nsearchPaths:\n  - /fake/bin\npermissionMode: skip\ndangerousRmWaiver: false\n';

const open = async (table: Record<string, unknown>, calls: Call[]) => {
  const run = stepHarness();
  const view = await mount(<PermissionPage client={scripted(table, calls)} step={run.step} />);
  mounted.push(view);
  await settle();
  return { view, run };
};

const select = (view: Mounted, value: string) =>
  interact(() => must(view.container.querySelector<HTMLInputElement>(`input[value="${value}"]`), value).click());
const confirm = async (view: Mounted): Promise<void> => {
  const button = must(
    view.container.querySelector<HTMLButtonElement>('[data-permission-confirm] button'),
    'the confirm button',
  );
  await interact(() => button.click());
};

describe('the permission text', () => {
  it('reads the mode, defaulting to skip (owner !A525)', () => {
    const mode = (text: string) => permissionRead(text);
    expect(mode(FILE)).toEqual({ kind: 'mode', mode: 'skip' });
    expect(mode('permissionMode: auto\n')).toEqual({ kind: 'mode', mode: 'auto' });
    expect(mode("permissionMode: 'auto' # asks\n")).toEqual({ kind: 'mode', mode: 'auto' });
    expect(mode('')).toEqual({ kind: 'mode', mode: 'skip' });
    expect(mode('# only a comment\n')).toEqual({ kind: 'mode', mode: 'skip' });
    expect(mode('binary: /x\n')).toEqual({ kind: 'mode', mode: 'skip' });
  });

  it('reads every YAML form of the key the same way (flow map, folded scalar, quoted, document marker)', () => {
    const auto = { kind: 'mode', mode: 'auto' } as const;
    expect(permissionRead('{permissionMode: auto, dangerousRmWaiver: false}\n')).toEqual(auto);
    expect(permissionRead('permissionMode: >-\n  auto\ndangerousRmWaiver: false\n')).toEqual(auto);
    expect(permissionRead('permissionMode: "auto"\n')).toEqual(auto);
    expect(permissionRead('---\npermissionMode: auto\n...\n')).toEqual(auto);
    expect(permissionRead('binary: x\n# permissionMode: skip\npermissionMode: auto\n')).toEqual(auto);
  });

  it('says unknown, never skip, for what it cannot read: a bad value, a non-map, broken YAML, a withheld text', () => {
    const unknown = { kind: 'unknown' } as const;
    expect(permissionRead('permissionMode: nonsense\n')).toEqual(unknown);
    expect(permissionRead('- a\n- b\n')).toEqual(unknown);
    expect(permissionRead('permissionMode: [auto\n')).toEqual(unknown);
    expect(permissionRead(WITHHELD_TEXT)).toEqual(unknown);
    expect(permissionRead('permissionMode: auto\n', 'invalid')).toEqual(unknown);
  });

  it('sets only the permissionMode key, in every form, keeping the other keys and the comments', () => {
    const parsedValue = (text: string) =>
      (readConfigText(text) as { read: { value: Record<string, unknown> } }).read.value;
    expect(withPermissionMode(FILE, 'auto')).toBe(FILE.replace('permissionMode: skip', 'permissionMode: auto'));
    expect(withPermissionMode('', 'auto')).toBe('permissionMode: auto\n');
    expect(withPermissionMode('binary: /x\n', 'skip')).toBe('binary: /x\npermissionMode: skip\n');
    const flow = withPermissionMode('{permissionMode: skip, dangerousRmWaiver: false}\n', 'auto');
    expect(parsedValue(flow)).toEqual({ permissionMode: 'auto', dangerousRmWaiver: false });
    const folded = withPermissionMode('# mine\npermissionMode: >-\n  skip\ndangerousRmWaiver: true\n', 'auto');
    expect(parsedValue(folded)).toEqual({ permissionMode: 'auto', dangerousRmWaiver: true });
    expect(folded).toContain('# mine');
    expect(permissionRead(folded)).toEqual({ kind: 'mode', mode: 'auto' });
  });
});

describe('the permission page', () => {
  it('selects the current value, says what skip allows and names the real flag', async () => {
    const calls: Call[] = [];
    const { view, run } = await open(
      { 'GET /v1/config/file': { path: 'harness-claude-code.yaml', text: FILE, etag: 'e1', exists: true } },
      calls,
    );
    expect((view.container.querySelector('input[value="skip"]') as HTMLInputElement).checked).toBe(true);
    const text = view.container.textContent ?? '';
    expect(text).toContain('--dangerously-skip-permissions');
    expect(text).toContain('without asking you, including deleting files');
    expect(text).not.toContain('dangerousRmWaiver');
    expect(run.events).toEqual(['ready']);
    expect(calls.map(call => call.route)).toEqual(['GET /v1/config/file']);
  });

  it('saves a pick through the config route against the etag it read, touching only permissionMode', async () => {
    const calls: Call[] = [];
    const { view, run } = await open(
      {
        'GET /v1/config/file': { path: 'harness-claude-code.yaml', text: FILE, etag: 'e1', exists: true },
        'PUT /v1/config/file': { path: 'harness-claude-code.yaml', etag: 'e2', outcome: 'applied' },
      },
      calls,
    );
    await select(view, 'auto');
    await confirm(view);
    await settle();
    const put = calls.find(call => call.route === 'PUT /v1/config/file');
    expect(put?.init?.body).toEqual({
      path: 'harness-claude-code.yaml',
      text: FILE.replace('permissionMode: skip', 'permissionMode: auto'),
      etag: 'e1',
    });
    expect(run.events).toEqual(['ready', 'busy:Saving…', 'done', 'busy:null']);
  });

  it('writes nothing on a pick: it shows the full consequence of Skip, and only the explicit confirm writes', async () => {
    const calls: Call[] = [];
    const AUTO_FILE = FILE.replace('permissionMode: skip', 'permissionMode: auto');
    const { view, run } = await open(
      {
        'GET /v1/config/file': { path: 'harness-claude-code.yaml', text: AUTO_FILE, etag: 'e1', exists: true },
        'PUT /v1/config/file': { path: 'harness-claude-code.yaml', etag: 'e2', outcome: 'applied' },
      },
      calls,
    );
    expect(view.container.querySelector('[data-permission-confirm]')).toBeNull();
    await select(view, 'skip');
    await settle();
    const warning = view.container.querySelector('[data-permission-consequence="skip"]')?.textContent ?? '';
    expect(warning).toContain('run every command without asking you, including deleting files');
    expect(warning).toContain('--dangerously-skip-permissions');
    expect(calls.some(call => call.route === 'PUT /v1/config/file')).toBe(false);
    expect(run.events).toEqual(['ready']);
    await confirm(view);
    await settle();
    expect(calls.filter(call => call.route === 'PUT /v1/config/file')).toHaveLength(1);
    expect(run.events).toEqual(['ready', 'busy:Saving…', 'done', 'busy:null']);
    // Written: nothing left to confirm.
    expect(view.container.querySelector('[data-permission-confirm]')).toBeNull();
  });

  it('writes nothing when the arrow keys move over the cards, and moving back withdraws the pick', async () => {
    const calls: Call[] = [];
    const { view } = await open(
      {
        'GET /v1/config/file': { path: 'harness-claude-code.yaml', text: FILE, etag: 'e1', exists: true },
        'PUT /v1/config/file': { path: 'harness-claude-code.yaml', etag: 'e2', outcome: 'applied' },
      },
      calls,
    );
    const group = must(view.container.querySelector('[role="radiogroup"]'), 'the cards');
    const key = (name: string) =>
      interact(() => {
        must(view.container.querySelector<HTMLInputElement>('input:checked'), 'checked').dispatchEvent(
          new KeyboardEvent('keydown', { key: name, bubbles: true }),
        );
      });
    expect(group).toBeDefined();
    await key('ArrowLeft'); // skip -> auto
    await settle();
    expect(view.container.querySelector('[data-permission-consequence="auto"]')).not.toBeNull();
    await key('ArrowRight'); // auto -> skip: back to the saved one
    await settle();
    expect(view.container.querySelector('[data-permission-confirm]')).toBeNull();
    expect(calls.some(call => call.route === 'PUT /v1/config/file')).toBe(false);
  });

  it('says so, and is not done, when the daemon refuses the write', async () => {
    const calls: Call[] = [];
    const { view, run } = await open(
      {
        'GET /v1/config/file': { path: 'harness-claude-code.yaml', text: FILE, etag: 'e1', exists: true },
        'PUT /v1/config/file': new Error('That file changed since you read it.'),
      },
      calls,
    );
    await select(view, 'auto');
    await confirm(view);
    await settle();
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
      'That file changed since you read it.',
    );
    expect(run.events).not.toContain('done');
  });
});

describe('the permission page on other YAML forms', () => {
  const FLOW = '{permissionMode: auto, dangerousRmWaiver: false}\n';
  const FOLDED = 'permissionMode: >-\n  auto\ndangerousRmWaiver: false\n';

  for (const [name, text] of [
    ['a flow map', FLOW],
    ['a folded scalar', FOLDED],
  ] as const) {
    it(`shows Auto as chosen, not Skip, when the file is ${name}`, async () => {
      const { view } = await open(
        { 'GET /v1/config/file': { path: 'harness-claude-code.yaml', text, etag: 'e1', exists: true } },
        [],
      );
      expect((view.container.querySelector('input[value="auto"]') as HTMLInputElement).checked).toBe(true);
      expect((view.container.querySelector('input[value="skip"]') as HTMLInputElement).checked).toBe(false);
    });

    it(`writes a pick over ${name} as YAML that still reads, with the other keys kept`, async () => {
      const calls: Call[] = [];
      const { view } = await open(
        {
          'GET /v1/config/file': { path: 'harness-claude-code.yaml', text, etag: 'e1', exists: true },
          'PUT /v1/config/file': { path: 'harness-claude-code.yaml', etag: 'e2', outcome: 'applied' },
        },
        calls,
      );
      await select(view, 'skip');
      await confirm(view);
      await settle();
      const body = calls.find(call => call.route === 'PUT /v1/config/file')?.init?.body as { text: string };
      const read = readConfigText(body.text);
      expect(read.ok && read.read.value).toEqual({ permissionMode: 'skip', dangerousRmWaiver: false });
    });
  }

  it('shows the mode as unknown and writes nothing when the route withheld the text', async () => {
    const calls: Call[] = [];
    const { view, run } = await open(
      {
        'GET /v1/config/file': {
          path: 'harness-claude-code.yaml',
          absolutePath: '/fake/home/config/harness-claude-code.yaml',
          text: WITHHELD_TEXT,
          etag: 'e1',
          exists: true,
          state: 'ok',
        },
      },
      calls,
    );
    expect(view.container.querySelector('input[type="radio"]')).toBeNull();
    const unknown = view.container.querySelector('[data-mode-unknown]')?.textContent ?? '';
    expect(unknown).toContain('unknown');
    expect(unknown).toContain('Change this at the machine: /fake/home/config/harness-claude-code.yaml');
    expect(calls.map(call => call.route)).toEqual(['GET /v1/config/file']);
    expect(run.events).toEqual(['ready']);
  });
});
