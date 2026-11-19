/** The permission page: it names the real flag, shows the current mode, and writes only `permissionMode`. */
import { interact, type Mounted, mount, must } from '@ferretry/app/testing';
import { afterEach, describe, expect, it } from 'bun:test';
import {
  PermissionPage,
  permissionModeOf,
  withPermissionMode,
} from '../../../../app/features/onboarding/permission-page.tsx';
import { type Call, scripted, stepHarness } from '../../../fixtures/onboarding/step-harness.ts';

const mounted: Mounted[] = [];
afterEach(async () => {
  for (const view of mounted.splice(0)) await view.unmount();
});
const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 20; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
};

const FILE =
  'binary: /fake/bin/claude # my own\nsearchPaths:\n  - /fake/bin\npermissionMode: skip\ndangerousRmWaiver: false\n';

const open = async (table: Record<string, unknown>, calls: Call[]) => {
  const run = stepHarness();
  const view = await mount(<PermissionPage client={scripted(table, calls)} step={run.step} />);
  mounted.push(view);
  await settle();
  return { view, run };
};

describe('the permission text', () => {
  it('reads the mode, defaulting to skip (owner !A525)', () => {
    expect(permissionModeOf(FILE)).toBe('skip');
    expect(permissionModeOf('permissionMode: auto\n')).toBe('auto');
    expect(permissionModeOf("permissionMode: 'auto' # asks\n")).toBe('auto');
    expect(permissionModeOf('')).toBe('skip');
    expect(permissionModeOf('permissionMode: nonsense\n')).toBe('skip');
  });

  it('changes only the permissionMode line, and appends it to a file that has none', () => {
    expect(withPermissionMode(FILE, 'auto')).toBe(FILE.replace('permissionMode: skip', 'permissionMode: auto'));
    expect(withPermissionMode('', 'auto')).toBe('permissionMode: auto\n');
    expect(withPermissionMode('binary: /x', 'skip')).toBe('binary: /x\npermissionMode: skip\n');
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
    await interact(() => must(view.container.querySelector<HTMLInputElement>('input[value="auto"]'), 'auto').click());
    await settle();
    const put = calls.find(call => call.route === 'PUT /v1/config/file');
    expect(put?.init?.body).toEqual({
      path: 'harness-claude-code.yaml',
      text: FILE.replace('permissionMode: skip', 'permissionMode: auto'),
      etag: 'e1',
    });
    expect(run.events).toEqual(['ready', 'busy:Saving…', 'done', 'busy:null']);
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
    await interact(() => must(view.container.querySelector<HTMLInputElement>('input[value="auto"]'), 'auto').click());
    await settle();
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
      'That file changed since you read it.',
    );
    expect(run.events).not.toContain('done');
  });
});
