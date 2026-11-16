/**
 * Edit as YAML over the kernel's config routes (D2 #3): a profile's file is read, saved against the etag it was read
 * at, a file that moved since is never overwritten, a loosening waits for the owner's Confirm, and a refusal shows its
 * located issues. NO REAL CREDENTIAL APPEARS HERE.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import type { ReactNode } from 'react';
import {
  CONFLICT_SENTENCE,
  ConfigFileEditor,
} from '../../../../../../app/features/fleet/profiles/config-file-editor.tsx';
import type { RuntimesClient } from '../../../../../../app/lib/client.ts';
import { RuntimesChanged } from '../../../../../../contract/index.ts';
import { createProfilesSettings } from '../../../../../../app/views/profiles-settings.tsx';
import runtimesManifest from '../../../../../../manifest.ts';
import type { Mounted } from '../../../../support/dom.ts';
import type { Call } from '../../../support/client.ts';
import {
  click,
  machineClient,
  mountSettled,
  scriptedMachine,
  settle,
  text,
  type,
} from '../components/view-support.tsx';

const GET = 'GET /v1/config/file';
const PUT = 'PUT /v1/config/file';
const CONFIRM = 'POST /v1/config/confirm';
const PATH = 'profiles/Default.yaml';
const TEXT = '# my profile\nlayers:\n  - mcp/github\n';

const refusal = (status: number, code: string, message: string, body?: unknown): Error =>
  Object.assign(new Error(message), { status, code, body: body ?? { error: message, code } });

interface Script {
  put?: unknown;
  confirm?: unknown;
  read?: unknown;
}

/** The kernel's three config routes, answered from `script`, with every call recorded. */
const configClient = (script: Script, calls: Call[], base?: RuntimesClient): RuntimesClient => ({
  call: async <Answer,>(
    route: string,
    init?: { readonly query?: Readonly<Record<string, string>>; readonly body?: unknown },
  ) => {
    if (route !== GET && route !== PUT && route !== CONFIRM) {
      if (base === undefined) throw new Error(`no route ${route}`);
      return await base.call<Answer>(route, init);
    }
    calls.push({ route, query: init?.query, body: init?.body, params: undefined });
    const answer =
      route === GET
        ? (script.read ?? {
            path: PATH,
            absolutePath: `/home/fy/config/${PATH}`,
            exists: true,
            text: TEXT,
            etag: 'e1',
            issues: [],
          })
        : route === PUT
          ? (script.put ?? { path: PATH, etag: 'e2', outcome: 'applied' })
          : (script.confirm ?? { path: PATH, confirmed: true });
    if (answer instanceof Error) throw answer;
    return answer as Answer;
  },
});

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const editor = async (script: Script = {}) => {
  const calls: Call[] = [];
  const events = { closed: 0, changed: 0 };
  mounted = await mountSettled(
    <ConfigFileEditor
      client={configClient(script, calls)}
      path={PATH}
      onClose={() => (events.closed += 1)}
      onChanged={() => (events.changed += 1)}
    />,
  );
  return { calls, events, root: document as ParentNode };
};

const sent = (calls: readonly Call[], route: string) => calls.filter(call => call.route === route).at(-1)?.body;

describe('Edit as YAML over the kernel’s /v1/config/file', () => {
  it('D2 #3 calls the kernel’s config routes, which Runtimes does not declare', () => {
    const own: readonly string[] = (runtimesManifest.actions?.routes ?? []).map(route => route.key);
    for (const route of [GET, PUT, CONFIRM]) {
      expect(own).not.toContain(route);
    }
  });

  it('reads the file by its path under config/ and shows where it is and the never-paste-a-key note', async () => {
    const { calls, root } = await editor();
    expect(calls[0]).toMatchObject({ route: GET, query: { path: PATH } });
    expect((root.querySelector('[data-config-editor-text]') as HTMLTextAreaElement).value).toBe(TEXT);
    expect(text(root, `[data-config-editor="${PATH}"]`)).toContain(`/home/fy/config/${PATH}`);
    expect(text(root, '[data-config-secret-note]')).toContain('${secret:NAME}');
  });

  it('saves the edited text against the etag it was read at, and says it is in effect', async () => {
    const { calls, events, root } = await editor();
    await type(root, '[data-config-editor-text]', `${TEXT}  - mcp/notes\n`);
    await click(root, '[data-config-submit]');
    expect(sent(calls, PUT)).toEqual({ path: PATH, text: `${TEXT}  - mcp/notes\n`, etag: 'e1' });
    expect(text(root, '[data-config-save="applied"]')).toBe('In effect');
    expect(events.changed).toBe(1);
  });

  it('never overwrites a file that moved since it was read: it says so and reloads on request', async () => {
    const { calls, events, root } = await editor({
      put: refusal(409, 'config_conflict', `${PATH} changed since it was read; read it again and redo the edit`),
    });
    await click(root, '[data-config-submit]');
    expect(text(root, '[data-config-save="conflict"]')).toContain(CONFLICT_SENTENCE);
    expect(events.changed).toBe(0);
    await click(root, '[data-config-reload]');
    expect(calls.filter(call => call.route === GET)).toHaveLength(2);
  });

  it('says a held loosening is saved but waits for the owner, and confirms exactly the reviewed etag', async () => {
    const { calls, events, root } = await editor({
      put: {
        path: PATH,
        etag: 'e2',
        outcome: 'pending',
        pending: { path: PATH, etag: 'e2', changes: ['adds a skill'] },
      },
    });
    await click(root, '[data-config-submit]');
    expect(text(root, '[data-config-save="pending"]')).toContain('waiting for your confirmation: adds a skill');
    await click(root, `[data-config-confirm="${PATH}"]`);
    expect(sent(calls, CONFIRM)).toEqual({ path: PATH, etag: 'e2' });
    expect(text(root, '[data-config-save="applied"]')).toBe('In effect');
    expect(events.changed).toBe(2);
  });

  it('says why a confirm did not take when the held edit is no longer the one waiting', async () => {
    const { root } = await editor({
      put: {
        path: PATH,
        etag: 'e2',
        outcome: 'pending',
        pending: { path: PATH, etag: 'e2', changes: ['adds a skill'] },
      },
      confirm: { path: PATH, confirmed: false },
    });
    await click(root, '[data-config-submit]');
    await click(root, `[data-config-confirm="${PATH}"]`);
    expect(text(root, '[data-config-confirm-failed]')).toContain('no longer the one waiting');
    expect(root.querySelector('[data-config-save="applied"]')).toBeNull();
  });

  it('says why a confirm did not take, in the machine’s words, when the confirm call is refused', async () => {
    const { root } = await editor({
      put: {
        path: PATH,
        etag: 'e2',
        outcome: 'pending',
        pending: { path: PATH, etag: 'e2', changes: ['adds a skill'] },
      },
      confirm: refusal(403, 'forbidden', 'this device may not confirm a held edit'),
    });
    await click(root, '[data-config-submit]');
    await click(root, `[data-config-confirm="${PATH}"]`);
    expect(text(root, '[data-config-confirm-failed]')).toContain('this device may not confirm a held edit');
    expect(root.querySelector('[data-config-save="applied"]')).toBeNull();
  });

  it('shows a refused file’s located issues and its sentence, and nothing is in effect', async () => {
    const { root } = await editor({
      put: refusal(422, 'config_invalid', 'the file does not check (1 problem); nothing was written', {
        error: 'the file does not check (1 problem); nothing was written',
        code: 'config_invalid',
        issues: [
          { path: PATH, line: 2, column: 3, severity: 'error', message: 'layers is not a list', fix: 'write a list' },
        ],
      }),
    });
    await click(root, '[data-config-submit]');
    expect(text(root, '[data-config-save="invalid"]')).toContain('does not check');
    expect(text(root, '[data-config-issue="error"]')).toContain(`${PATH}:2:3`);
    expect(text(root, '[data-config-issue="error"]')).toContain('write a list');
    expect(root.querySelector('[data-config-save="applied"]')).toBeNull();
  });

  it('says the file could not be read, in the machine’s words', async () => {
    const { root } = await editor({
      read: refusal(403, 'forbidden', 'this device may not read profiles/Default.yaml'),
    });
    expect(text(root, '[data-config-editor-failed]')).toContain('this device may not read profiles/Default.yaml');
    expect(root.querySelector('[data-config-submit]')?.hasAttribute('disabled')).toBe(true);
  });

  it('reads the file again when the kernel says THIS file moved (held, broken, discarded), and ignores any other', async () => {
    // Arrange: a client that hears the kernel's config frames.
    const calls: Call[] = [];
    const script: Script = {};
    const listeners = new Set<(payload: unknown) => void>();
    const client = {
      ...configClient(script, calls),
      subscribe: (event: { name: string }, listener: (payload: unknown) => void) => {
        if (event.name === 'kernel.config-changed') listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as unknown as RuntimesClient;
    mounted = await mountSettled(
      <ConfigFileEditor client={client} path={PATH} onClose={() => {}} onChanged={() => {}} />,
    );
    const frame = async (payload: { plugin: string; path: string; state: string }) => {
      for (const listener of listeners) listener({ ...payload, etag: 'e7' });
      await settle();
    };
    const reads = () => calls.filter(call => call.route === GET).length;

    // Act + Assert: another plugin's file of the same path, and another path of ours, wake nothing.
    await frame({ plugin: 'warden', path: PATH, state: 'held' });
    await frame({ plugin: 'runtimes', path: 'profiles/Other.yaml', state: 'held' });
    expect(reads()).toBe(1);

    // Act + Assert: this file, held for the owner, is read again.
    await frame({ plugin: 'runtimes', path: PATH, state: 'held' });
    expect(reads()).toBe(2);
    await frame({ plugin: 'runtimes', path: PATH, state: 'invalid' });
    expect(reads()).toBe(3);
  });

  it('reads the file again in place when the machine says a profile moved, and keeps a draft the person started', async () => {
    // Arrange: a client that hears this machine's runtimes.changed.
    const calls: Call[] = [];
    const script: Script = {};
    const listeners = new Set<(payload: unknown) => void>();
    const client = {
      ...configClient(script, calls),
      subscribe: (event: { name: string }, listener: (payload: unknown) => void) => {
        if (event.name === RuntimesChanged.name) listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as unknown as RuntimesClient;
    mounted = await mountSettled(
      <ConfigFileEditor client={client} path={PATH} onClose={() => {}} onChanged={() => {}} />,
    );
    const root = document as ParentNode;
    const field = () => (root.querySelector('[data-config-editor-text]') as HTMLTextAreaElement).value;
    const moved = async () => {
      for (const listener of listeners) listener({ runtimes: [], profiles: ['Default'], modelSets: [] });
      await settle();
    };

    // Act: another editor changed the file; the untouched draft follows it.
    const edited = '# edited elsewhere\nlayers: []\n';
    script.read = {
      path: PATH,
      absolutePath: `/home/fy/config/${PATH}`,
      exists: true,
      text: edited,
      etag: 'e9',
      issues: [],
    };
    await moved();

    // Assert
    expect(field()).toBe(edited);
    expect(calls.filter(call => call.route === GET)).toHaveLength(2);

    // Act: the person starts editing, then the file moves again; their draft stays.
    await type(root, '[data-config-editor-text]', `${edited}# mine\n`);
    await moved();

    // Assert
    expect(field()).toBe(`${edited}# mine\n`);
    expect(calls.filter(call => call.route === GET)).toHaveLength(2);
  });

  it('Cancel closes it', async () => {
    const { events, root } = await editor();
    await click(root, '[data-config-cancel]');
    expect(events.closed).toBe(1);
  });
});

describe('Settings › Profiles offers Edit as YAML', () => {
  it('opens the profile’s file as YAML over the kernel’s route, and closes it again', async () => {
    const machine = scriptedMachine();
    const calls: Call[] = [];
    const Settings = createProfilesSettings(configClient({}, calls, machineClient(machine))) as () => ReactNode;
    mounted = await mountSettled(<Settings />);
    await settle();
    const root = document as ParentNode;
    await click(root, '[data-profile-row="Default"]');
    expect(text(root, '[data-profile-file]')).toContain(`config/${PATH}`);
    await click(root, '[data-profile-yaml]');
    expect(root.querySelector(`[data-config-editor="${PATH}"]`)).not.toBeNull();
    expect(calls.some(call => call.route === GET && call.query?.path === PATH)).toBe(true);
    await click(root, '[data-config-cancel]');
    expect(root.querySelector('[data-config-editor]')).toBeNull();
  });

  it('reads the profiles again after a save there, so the page shows what the file now says', async () => {
    // Arrange
    const machine = scriptedMachine();
    const calls: Call[] = [];
    const Settings = createProfilesSettings(configClient({}, calls, machineClient(machine))) as () => ReactNode;
    mounted = await mountSettled(<Settings />);
    await settle();
    const root = document as ParentNode;
    await click(root, '[data-profile-row="Default"]');
    await click(root, '[data-profile-yaml]');
    const reads = () => machine.calls.filter(call => call.route === 'GET /v1/runtimes/profiles').length;
    const before = reads();

    // Act
    await type(root, '[data-config-editor-text]', `${TEXT}  - mcp/notes\n`);
    await click(root, '[data-config-submit]');

    // Assert
    expect(sent(calls, PUT)).toEqual({ path: PATH, text: `${TEXT}  - mcp/notes\n`, etag: 'e1' });
    expect(reads()).toBeGreaterThan(before);
  });
});
