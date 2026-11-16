import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { DaemonCallError } from '@ferretry/app';
import type { DaemonIdentity } from '../../../../daemon/lib/relay-wire/kernel-wire/index.ts';
import { openCatalogFile } from '../../../../app/features/catalogs/catalog-install-model.ts';
import { InstallFromFileSheet, type InstallHost } from '../../../../app/features/catalogs/install-from-file-sheet.tsx';
import { daemonConnection } from '../../../../app/lib/machine.ts';
import { fakeClient } from '../support/catalog-client.ts';
import { crypto, mcpItem, newIdentity, signedFile, skillItem } from '../support/catalog-files.ts';
import { INSTALL_ID, installPreview, installRecord } from '../support/catalog-views.ts';
import { click, settle } from '../support/dom-form.ts';
import { interact, mount } from '@ferretry/app/testing';
import { runAsync } from '@ferretry/app/testing';
import { settleUntil } from '@ferretry/app/testing';
import { watchedCrypto } from '../support/watched-crypto.ts';

/** Earlier files in the same run can leave screens behind, and the queries here read the whole document. */
beforeEach(() => {
  document.body.replaceChildren();
});

const connection = daemonConnection({ daemonId: 'alpha' });
/** The sheet reads files through this, so `give` can wait for the reading itself. */
const watched = watchedCrypto(crypto);
const q = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector);
const text = (): string => document.body.textContent ?? '';

let identity: DaemonIdentity;
let fileText: string;
let partialText: string;
let withdrawnText: string;
let entries: ReadonlyMap<string, { itemId: string; kind: string; name: string; version: number; digest: string }>;
beforeAll(async () => {
  identity = await newIdentity();
  const skill = skillItem(identity.daemonId);
  const mcp = mcpItem(identity.daemonId);
  fileText = JSON.stringify(await signedFile(identity, [skill, mcp]));
  partialText = JSON.stringify(await signedFile(identity, [skill, mcp], [skill]));
  withdrawnText = JSON.stringify(await signedFile(identity, [skill, mcp], [skill, mcp], [skill.itemId]));
  const opened = await openCatalogFile(fileText, crypto);
  if (!opened.ok) throw new Error(opened.sentence);
  entries = new Map(opened.opened.manifest.items.map(entry => [entry.itemId, entry]));
});

const MCP_ID = `itm_${'m'.repeat(22)}`;
const SKILL_ID = `itm_${'s'.repeat(22)}`;

/** A machine review that names the same publisher, catalog and item (the MCP one unless told) the signed test file does. */
const agreeingPreview = (change: Record<string, unknown> = {}, itemId: string = MCP_ID) => {
  const base = installPreview();
  const entry = entries.get(itemId);
  if (entry === undefined) throw new Error(`no such item ${itemId}`);
  return installPreview({
    provenance: {
      ...base.provenance,
      publisher: identity.daemonId,
      catalogName: "Kirin's catalog",
      itemId,
      kind: entry.kind,
      name: entry.name,
      version: entry.version,
      digest: entry.digest,
    },
    publisher: { ...base.publisher, daemonId: identity.daemonId },
    ...change,
  });
};

const PROJECTS = [{ name: 'proj', path: '/work/proj' }];
const RUNTIME_PREVIEW = 'POST /v1/catalog-installs/runtime/preview';
const RUNTIME_APPLY = 'POST /v1/catalog-installs/runtime';
const baseHandlers = {
  'GET /v1/secrets': () => ({
    v: 1,
    health: 'ready',
    secrets: [
      { name: 'ZED', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      { name: 'ACME_TOKEN', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      {
        name: 'MCP_ACME_0123456789ABCDEF_ACCESS',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    references: [],
  }),
};

const BOX = [{ runtime: 'box', profiles: ['default'] }];

async function open(handlers: Parameters<typeof fakeClient>[0], host: Partial<InstallHost> = {}) {
  const fake = fakeClient({ ...baseHandlers, ...handlers });
  const closed: string[] = [];
  const view = await mount(
    <InstallFromFileSheet
      connection={connection}
      onClose={() => closed.push('closed')}
      host={{ createClient: fake.factory, crypto: watched.crypto, projects: PROJECTS, runtimes: BOX, ...host }}
    />,
  );
  return { fake, view, closed };
}

/** The sheet holds its file input off while it reads a file (and while it asks the daemon). */
const reading = (): boolean => (q('[data-catalog-file-input]') as HTMLInputElement | null)?.disabled === true;
/**
 * Hands the sheet a file, then waits until it has finished reading it. Opening a file verifies its
 * signature and digests with `crypto.subtle`, which finishes on a work-queue thread, so a fixed count of
 * ticks races it and a loaded runner loses (the next `pickItem` then finds no item to tap). Each turn
 * here first waits for every crypto answer still on the way, so only the steps between them are counted.
 */
const give = async (file: unknown): Promise<void> => {
  const input = q('[data-catalog-file-input]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await interact(() => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settleUntil(
    () => !reading(),
    'the sheet to finish reading the file',
    async turn =>
      await runAsync(async () => {
        await watched.answered();
        await turn();
      }),
  );
};
const giveText = async (content: string) => await give(new File([content], 'team.catalog.json'));

const choose = async (selector: string, value: string): Promise<void> => {
  const select = q(selector) as HTMLSelectElement;
  await interact(() => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
};
const tap = async (selector: string) => {
  await click(q(selector));
  await settle();
};
/** The sheet's own busy labels: while one shows, the daemon's answer has not landed yet. */
const BUSY = new Set(['Reading…', 'Installing…']);
const idle = (): boolean =>
  ![...document.querySelectorAll('button')].some(button => BUSY.has(button.textContent ?? ''));
/** Taps a button that asks the daemon, then waits for the answer itself: one tick is not enough on a loaded runner. */
const answer = async (selector: string) => {
  await tap(selector);
  await settleUntil(idle, `the answer after tapping ${selector}`, runAsync);
};
const pickItem = async (itemId: string) => await tap(`[data-catalog-file-item="${itemId}"] input`);
const pickRuntime = async () => {
  await choose('[data-catalog-scope]', 'runtime');
  await choose('[data-catalog-runtime]', 'box');
};

describe('opening a file', () => {
  it('refuses a file over 32 MB without reading it', async () => {
    const { view } = await open({});
    await give({ size: 33 * 1024 * 1024, text: () => Promise.reject(new Error('must not be read')) });
    expect(text()).toContain('larger than 32 MB');
    expect(q('[data-catalog-file]')).toBeNull();
    await view.unmount();
  });

  it('says why a file that is not a catalog is refused', async () => {
    const { view } = await open({});
    await giveText('{nope');
    expect(q('[data-catalog-failure]')).not.toBeNull();
    expect(q('[data-catalog-file]')).toBeNull();
    await view.unmount();
  });

  it('says a file that cannot be read was not installed', async () => {
    const { view } = await open({});
    await give({ size: 10, text: () => Promise.reject(new Error('disk')) });
    expect(text()).toContain('could not be read');
    await view.unmount();
  });

  it('lists the items, greys out one the file does not carry, and keeps Review off until it is chosen', async () => {
    const { view } = await open({});
    await giveText(partialText);
    expect(q('[data-catalog-file-summary]')?.textContent).toContain('2 items');
    expect(q(`[data-catalog-file-item="${MCP_ID}"]`)?.textContent).toContain('does not carry');
    expect((q(`[data-catalog-file-item="${MCP_ID}"] input`) as HTMLInputElement).disabled).toBe(true);
    expect(q('[data-catalog-preview]')?.hasAttribute('disabled')).toBe(true);
    expect(q('[data-catalog-choice-problem]')?.textContent).toBe('Pick an item.');
    await view.unmount();
  });

  it('says how many items the publisher withdrew', async () => {
    const { view } = await open({});
    await giveText(withdrawnText);
    expect(text()).toContain('1 item withdrawn by the publisher');
    expect(q(`[data-catalog-file-item="${SKILL_ID}"]`)).toBeNull();
    await view.unmount();
  });

  it('opens a file again, starting over, and can pick another', async () => {
    const { view } = await open({});
    await giveText(fileText);
    await pickItem(MCP_ID);
    await giveText(fileText);
    expect(q('[data-catalog-choice-problem]')?.textContent).toBe('Pick an item.');
    expect(q('[data-catalog-pick-file]')?.textContent).toContain('Choose another file');
    const open2 = q('[data-catalog-pick-file]') as HTMLButtonElement;
    await click(open2);
    await view.unmount();
  });
});

describe('choosing where', () => {
  it('asks for a project and an agent, and drops what no longer applies', async () => {
    const { view } = await open({});
    await giveText(fileText);
    await pickItem(SKILL_ID);
    expect(q('[data-catalog-choice-problem]')?.textContent).toBe('Pick where to install it.');
    await choose('[data-catalog-scope]', 'project');
    expect(q('[data-catalog-choice-problem]')?.textContent).toBe('Pick a project.');
    await choose('[data-catalog-harness]', 'codex');
    await choose('[data-catalog-project]', '/work/proj');
    expect(q('[data-catalog-choice-problem]')).toBeNull();
    await choose('[data-catalog-harness]', '');
    expect(q('[data-catalog-choice-problem]')?.textContent).toContain('Claude or Codex');
    await choose('[data-catalog-harness]', 'claude');
    await choose('[data-catalog-project]', '');
    expect(q('[data-catalog-choice-problem]')?.textContent).toBe('Pick a project.');
    await choose('[data-catalog-scope]', '');
    expect(q('[data-catalog-project]')).toBeNull();
    await view.unmount();
  });

  it('offers this machine runtimes with their profile', async () => {
    const { view } = await open({});
    await giveText(fileText);
    await choose('[data-catalog-scope]', 'runtime');
    expect(q('[data-catalog-runtime]')?.textContent).toContain('box · default');
    await choose('[data-catalog-runtime]', 'box');
    expect(q('[data-catalog-choice-problem]')?.textContent).toBe('Pick an item.');
    await choose('[data-catalog-runtime]', '');
    await view.unmount();
  });
});

describe('the review and the install', () => {
  const secretsReady = {
    [RUNTIME_PREVIEW]: () =>
      agreeingPreview({
        warnings: [{ code: 'older-version', text: 'This is older than the one you have.' }],
        replaces: { installId: INSTALL_ID, version: 2 },
      }),
  };

  it('previews, makes every secret an explicit choice, and installs once confirmed', async () => {
    const installed = { install: installRecord('mcp', 'acme-mcp'), notes: ['Added it to the profile.'] };
    const { fake, view, closed } = await open({ ...secretsReady, [RUNTIME_APPLY]: () => installed });
    await giveText(fileText);
    await pickItem(MCP_ID);
    await pickRuntime();
    await answer('[data-catalog-preview]');
    const confirm = q('[data-catalog-confirm]')?.textContent ?? '';
    expect(confirm).toContain("Kirin's catalog · kirin-box");
    expect(confirm).toContain('Into');
    expect(confirm).toContain('replaces version 2');
    expect(confirm).toContain('This is older than the one you have.');
    expect(confirm).toContain('acme-mcp --stdio');
    expect(q('[data-catalog-first-seen]')).not.toBeNull();
    expect(q('[data-catalog-install]')?.hasAttribute('disabled')).toBe(true);
    expect(q('[data-catalog-install-reason]')?.textContent).toContain('ACME_TOKEN, ACME_REGION');
    const options = [...(q('[data-catalog-secret="ACME_TOKEN"] select')?.querySelectorAll('option') ?? [])].map(
      o => o.textContent,
    );
    expect(options).toEqual(['Choose…', 'Leave unbound', 'ACME_TOKEN', 'ZED']);
    expect(q('[data-catalog-secret="ACME_REGION"]')?.textContent).toContain('You have a secret with this name.');

    await choose('[data-catalog-secret="ACME_TOKEN"] select', 'ACME_TOKEN');
    expect(q('[data-catalog-secret-note]')?.textContent).toBe('This program will receive your secret ACME_TOKEN.');
    await choose('[data-catalog-secret="ACME_TOKEN"] select', '');
    expect(q('[data-catalog-secret-note]')).toBeNull();
    await choose('[data-catalog-secret="ACME_TOKEN"] select', 'ACME_TOKEN');
    expect(q('[data-catalog-install]')?.hasAttribute('disabled')).toBe(true);
    await choose('[data-catalog-secret="ACME_REGION"] select', '\u0000unbound');
    expect(q('[data-catalog-install]')?.hasAttribute('disabled')).toBe(false);

    await answer('[data-catalog-install]');
    expect(fake.calls.at(-1)).toMatchObject({
      path: '/v1/catalog-installs/runtime',
      body: { secretBindings: { ACME_TOKEN: 'ACME_TOKEN', ACME_REGION: null } },
    });
    expect(q('[data-catalog-installed]')?.textContent).toContain('acme-mcp · version 1');
    expect(q('[data-catalog-destination]')?.textContent).toBe('Put into runtime box, profile default');
    expect(q('[data-catalog-note]')?.textContent).toBe('Added it to the profile.');
    await tap('[data-catalog-done]');
    expect(closed).toEqual(['closed']);
    await view.unmount();
  });

  it('shows the fingerprint and digest in full when tapped', async () => {
    const { view } = await open({ ...secretsReady });
    await giveText(fileText);
    await pickItem(MCP_ID);
    await pickRuntime();
    await answer('[data-catalog-preview]');
    const buttons = [...document.querySelectorAll<HTMLElement>('[data-catalog-confirm] button[aria-expanded]')];
    expect(buttons.length).toBe(2);
    for (const button of buttons) {
      const before = button.textContent ?? '';
      await click(button);
      expect((button.textContent ?? '').length).toBeGreaterThan(before.length);
      expect(button.getAttribute('aria-expanded')).toBe('true');
    }
    for (const button of buttons) {
      const name = button.getAttribute('aria-label') ?? '';
      expect(name).toContain(button.textContent ?? 'missing');
      const hint = document.getElementById(button.getAttribute('aria-describedby') ?? 'missing');
      expect(hint?.textContent).toBe('Showing in full. Tap to shorten.');
      await click(button);
      expect(document.getElementById(button.getAttribute('aria-describedby') ?? 'missing')?.textContent).toBe(
        'Tap to show in full.',
      );
    }
    await view.unmount();
  });

  it('with nothing to bind, installs straight away and shows no first-install note for a known publisher', async () => {
    const { view } = await open({
      [RUNTIME_PREVIEW]: () =>
        agreeingPreview({ secrets: [], publisher: { ...agreeingPreview().publisher, firstSeen: false } }),
      [RUNTIME_APPLY]: () => ({ install: installRecord('mcp', 'acme-mcp'), notes: [] }),
    });
    await giveText(fileText);
    await pickItem(MCP_ID);
    await pickRuntime();
    await answer('[data-catalog-preview]');
    expect(q('[data-catalog-secrets]')).toBeNull();
    expect(q('[data-catalog-first-seen]')).toBeNull();
    expect(q('[data-catalog-install]')?.hasAttribute('disabled')).toBe(false);
    await answer('[data-catalog-install]');
    expect(q('[data-catalog-installed]')).not.toBeNull();
    expect(q('[data-catalog-note]')).toBeNull();
    await view.unmount();
  });

  it('can only leave secrets unbound when this machine’s secrets cannot be read', async () => {
    const { view } = await open({
      ...secretsReady,
      'GET /v1/secrets': () => {
        throw new DaemonCallError(500, 'x', 'boom');
      },
    });
    await giveText(fileText);
    await pickItem(MCP_ID);
    await pickRuntime();
    await answer('[data-catalog-preview]');
    expect(q('[data-catalog-secrets]')?.textContent).toContain('could not be read');
    expect(q('[data-catalog-secret="ACME_TOKEN"] select')?.querySelectorAll('option').length).toBe(2);
    await view.unmount();
  });

  it('previews into a project and keeps the older-version offer to a refusal', async () => {
    const projectPreview = agreeingPreview(
      {
        target: { scope: 'project', projectRoot: '/work/proj', harness: 'claude' },
        destination: 'project proj, Claude',
        secrets: [],
      },
      SKILL_ID,
    );
    const { fake, view } = await open({ 'POST /v1/catalog-installs/project/preview': () => projectPreview });
    await giveText(fileText);
    await pickItem(SKILL_ID);
    await choose('[data-catalog-scope]', 'project');
    await choose('[data-catalog-project]', '/work/proj');
    await choose('[data-catalog-harness]', 'claude');
    await answer('[data-catalog-preview]');
    expect(fake.calls.at(-1)?.path).toBe('/v1/catalog-installs/project/preview');
    expect(q('[data-catalog-confirm]')?.textContent).toContain('project proj, Claude');
    expect(q('[data-catalog-allow-older]')).toBeNull();
    await view.unmount();
  });
});

describe('refusals', () => {
  const ready = async (handlers: Parameters<typeof fakeClient>[0]) => {
    const made = await open(handlers);
    await giveText(fileText);
    await pickItem(MCP_ID);
    await pickRuntime();
    return made;
  };

  it('refuses a review that names another publisher than the verified file, and shows no review', async () => {
    const { view } = await ready({ [RUNTIME_PREVIEW]: () => installPreview() });
    await answer('[data-catalog-preview]');
    expect(q('[data-catalog-failure]')?.textContent).toContain('somewhere other than the file says');
    expect(q('[data-catalog-confirm]')).toBeNull();
    expect(q('[data-catalog-install]')).toBeNull();
    await view.unmount();
  });

  it('says a first publisher once, in the From row', async () => {
    const { view } = await ready({
      [RUNTIME_PREVIEW]: () =>
        agreeingPreview({ warnings: [{ code: 'first-publisher', text: 'A grey box that says it again.' }] }),
    });
    await answer('[data-catalog-preview]');
    const confirm = q('[data-catalog-confirm]')?.textContent ?? '';
    expect(confirm).not.toContain('A grey box that says it again.');
    expect(confirm).toContain('First install from this publisher');
    expect(confirm).toContain('It will run');
    await view.unmount();
  });

  it('offers an older version only when asked, and previews again with permission', async () => {
    let calls = 0;
    const { fake, view } = await ready({
      [RUNTIME_PREVIEW]: () => {
        calls += 1;
        if (calls === 1) throw new DaemonCallError(409, 'catalog_downgrade', 'older');
        return agreeingPreview();
      },
    });
    await answer('[data-catalog-preview]');
    expect(text()).toContain('older version than the one you have');
    await tap('[data-catalog-allow-older]');
    expect(fake.calls.filter(call => call.path.endsWith('/preview')).at(-1)?.body).toMatchObject({ allowOlder: true });
    expect(q('[data-catalog-confirm]')).not.toBeNull();
    await view.unmount();
  });

  it('offers Preview again when the preview ran out', async () => {
    let calls = 0;
    const { view } = await ready({
      [RUNTIME_PREVIEW]: () => {
        calls += 1;
        if (calls === 1) throw new DaemonCallError(410, 'catalog_preview_expired', 'gone');
        return agreeingPreview();
      },
    });
    await answer('[data-catalog-preview]');
    await answer('[data-catalog-preview-again]');
    expect(calls).toBe(2);
    expect(q('[data-catalog-confirm]')).not.toBeNull();
    expect(q('[data-catalog-failure]')).toBeNull();
    await view.unmount();
  });

  it('says nothing was installed when the passkey was not confirmed, and keeps the review', async () => {
    const { view } = await ready({
      [RUNTIME_PREVIEW]: () => agreeingPreview({ secrets: [] }),
      [RUNTIME_APPLY]: () => {
        throw new DaemonCallError(403, 'grant_step_up_required', 'step up');
      },
    });
    await answer('[data-catalog-preview]');
    await answer('[data-catalog-install]');
    expect(text()).toContain('passkey wasn’t confirmed');
    expect(q('[data-catalog-installed]')).toBeNull();
    expect(q('[data-catalog-confirm]')).not.toBeNull();
    await view.unmount();
  });

  it('forgets the review when the item or place changes', async () => {
    const { view } = await ready({ [RUNTIME_PREVIEW]: () => agreeingPreview() });
    await answer('[data-catalog-preview]');
    expect(q('[data-catalog-confirm]')).not.toBeNull();
    await pickItem(SKILL_ID);
    expect(q('[data-catalog-confirm]')).toBeNull();
    await answer('[data-catalog-preview]');
    await choose('[data-catalog-scope]', 'runtime');
    expect(q('[data-catalog-confirm]')).toBeNull();
    await view.unmount();
  });
});

describe('the projects the host names', () => {
  it('offers them', async () => {
    const fake = fakeClient({ ...baseHandlers });
    const view = await mount(
      <InstallFromFileSheet
        connection={connection}
        onClose={() => undefined}
        host={{ createClient: fake.factory, crypto: watched.crypto, projects: [{ name: 'known', path: '/k' }] }}
      />,
    );
    await giveText(fileText);
    await choose('[data-catalog-scope]', 'project');
    expect(q('[data-catalog-project]')?.textContent).toContain('known');
    await view.unmount();
  });
});

describe('catalogs#5 the projects of the machine being installed onto', () => {
  const ALPHA = [{ name: 'alpha-proj', path: '/a' }];
  const BETA = [{ name: 'beta-proj', path: '/b' }];
  const read = async (target: { readonly daemonId: string }) => (target.daemonId === 'alpha' ? ALPHA : BETA);

  const openOn = async (daemonId: string, host: Partial<InstallHost>) => {
    const fake = fakeClient({ ...baseHandlers });
    const view = await mount(
      <InstallFromFileSheet
        connection={daemonConnection({ daemonId })}
        onClose={() => undefined}
        host={{ createClient: fake.factory, crypto: watched.crypto, ...host }}
      />,
    );
    await giveText(fileText);
    await choose('[data-catalog-scope]', 'project');
    await settle();
    return view;
  };

  it('offers the TARGET machine’s projects, never the screen’s own, when they differ', async () => {
    // The screen is on alpha (its own list rides `projects`); the person picked beta to install onto.
    const view = await openOn('beta', { projects: ALPHA, readProjects: read });
    expect(q('[data-catalog-project]')?.textContent).toContain('beta-proj');
    expect(q('[data-catalog-project]')?.textContent).not.toContain('alpha-proj');
    await view.unmount();
  });

  it('offers the screen’s own machine’s projects when that is the target', async () => {
    const view = await openOn('alpha', { projects: BETA, readProjects: read });
    expect(q('[data-catalog-project]')?.textContent).toContain('alpha-proj');
    expect(q('[data-catalog-project]')?.textContent).not.toContain('beta-proj');
    await view.unmount();
  });

  it('offers none, not another machine’s, when the target’s list cannot be read', async () => {
    const view = await openOn('beta', {
      projects: ALPHA,
      readProjects: async () => {
        throw new Error('This device cannot reach Catalogs on that machine yet.');
      },
    });
    expect(q('[data-catalog-project]')?.textContent).not.toContain('alpha-proj');
    await view.unmount();
  });

  it('drops an answer that lands after the sheet closed', async () => {
    let release: (value: typeof BETA) => void = () => undefined;
    const late = new Promise<typeof BETA>(resolve => {
      release = resolve;
    });
    const fake = fakeClient({ ...baseHandlers });
    const view = await mount(
      <InstallFromFileSheet
        connection={daemonConnection({ daemonId: 'beta' })}
        onClose={() => undefined}
        host={{ createClient: fake.factory, crypto: watched.crypto, readProjects: () => late }}
      />,
    );
    await view.unmount();
    release(BETA);
    await late;
    const failing = Promise.reject(new Error('late'));
    const second = await mount(
      <InstallFromFileSheet
        connection={daemonConnection({ daemonId: 'beta' })}
        onClose={() => undefined}
        host={{ createClient: fake.factory, crypto: watched.crypto, readProjects: () => failing }}
      />,
    );
    await second.unmount();
    await failing.catch(() => undefined);
    expect(document.body.textContent).not.toContain('beta-proj');
  });
});

describe('a preview that is overtaken', () => {
  const held = () => {
    let release: (value: unknown) => void = () => undefined;
    let fail: (reason: unknown) => void = () => undefined;
    const promise = new Promise<unknown>((resolve, reject) => {
      release = resolve;
      fail = reject;
    });
    return { promise, release: (value: unknown) => release(value), fail: (reason: unknown) => fail(reason) };
  };
  const waiting = async (pending: Promise<unknown>) => {
    const made = await open({ [RUNTIME_PREVIEW]: () => pending });
    await giveText(fileText);
    await pickItem(MCP_ID);
    await pickRuntime();
    await tap('[data-catalog-preview]');
    return made;
  };

  it('cannot be steered while it is being read', async () => {
    const hold = held();
    const { view } = await waiting(hold.promise);
    expect(q('[data-catalog-preview]')?.textContent).toBe('Reading…');
    const locked = [
      ...document.querySelectorAll<HTMLInputElement>('[data-catalog-file-item] input'),
      q('[data-catalog-scope]'),
      q('[data-catalog-runtime]'),
      q('[data-catalog-pick-file]'),
      q('[data-catalog-file-input]'),
    ];
    expect(locked.length).toBe(6);
    for (const control of locked) expect((control as HTMLInputElement).disabled).toBe(true);
    hold.release(agreeingPreview());
    await settle();
    expect(q('[data-catalog-confirm]')).not.toBeNull();
    for (const control of locked) expect((control as HTMLInputElement).disabled).toBe(false);
    await view.unmount();
  });

  it('shows no review for an answer that arrives after another file was opened', async () => {
    const hold = held();
    const { view } = await waiting(hold.promise);
    await giveText(fileText);
    hold.release(agreeingPreview());
    await settle();
    await settle();
    expect(q('[data-catalog-confirm]')).toBeNull();
    expect(q('[data-catalog-failure]')).toBeNull();
    expect(q('[data-catalog-install]')).toBeNull();
    await view.unmount();
  });

  it('shows no refusal for an answer that fails after another file was opened', async () => {
    const hold = held();
    const { view } = await waiting(hold.promise);
    await giveText(fileText);
    hold.fail(new DaemonCallError(410, 'catalog_preview_expired', 'gone'));
    await settle();
    await settle();
    expect(q('[data-catalog-failure]')).toBeNull();
    expect(q('[data-catalog-confirm]')).toBeNull();
    await view.unmount();
  });

  it('drops secrets that arrive after another file was opened', async () => {
    const hold = held();
    const slowSecrets = held();
    const { view } = await open({
      [RUNTIME_PREVIEW]: () => hold.promise,
      'GET /v1/secrets': () => slowSecrets.promise,
    });
    await giveText(fileText);
    await pickItem(MCP_ID);
    await pickRuntime();
    await tap('[data-catalog-preview]');
    hold.release(agreeingPreview());
    await settle();
    expect(q('[data-catalog-confirm]')).not.toBeNull();
    await giveText(fileText);
    slowSecrets.release({
      v: 1,
      health: 'ready',
      secrets: [{ name: 'ACME_TOKEN', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
      references: [],
    });
    await settle();
    expect(q('[data-catalog-confirm]')).toBeNull();
    await view.unmount();
  });
});

describe('the item choices', () => {
  it('draw the name in the app font, not a code font', async () => {
    const { view } = await open({});
    await giveText(fileText);
    for (const label of document.querySelectorAll('[data-catalog-file-item] > span > span:first-child'))
      expect(label.className).not.toContain('font-mono');
    await view.unmount();
  });
});

describe('the publisher fingerprint', () => {
  it('shows 20 characters after fy_daemon_ in the From row, and all of it when tapped', async () => {
    const { view } = await open({});
    await giveText(fileText);
    const file = q('[data-catalog-file]')?.textContent ?? '';
    expect(file).toContain('Machine ID:');
    expect(file).not.toMatch(/·\s*Machine ID/u);
    const button = q('[data-catalog-file] button[aria-expanded]') as HTMLElement;
    const shown = button.textContent ?? '';
    expect(shown).toBe(`${identity.daemonId.slice(0, 'fy_daemon_'.length + 20)}…`);
    await click(button);
    expect(button.textContent).toBe(identity.daemonId);
    await view.unmount();
  });
});

describe('what the file supplies', () => {
  it('writes a hidden character in an install note as its marker', async () => {
    const raw = String.fromCodePoint(0x202e);
    const installed = { install: installRecord('mcp', 'acme-mcp'), notes: [`Added ${raw}it.`] };
    const { view } = await open({
      [RUNTIME_PREVIEW]: () => agreeingPreview({ secrets: [] }),
      [RUNTIME_APPLY]: () => installed,
    });
    await giveText(fileText);
    await pickItem(MCP_ID);
    await pickRuntime();
    await answer('[data-catalog-preview]');
    await answer('[data-catalog-install]');
    expect(q('[data-catalog-note]')?.textContent).not.toContain(raw);
    expect(q('[data-catalog-note] mark')).not.toBeNull();
    await view.unmount();
  });

  it('refuses a review that names another item than the one chosen', async () => {
    const { view } = await open({ [RUNTIME_PREVIEW]: () => agreeingPreview({}, SKILL_ID) });
    await giveText(fileText);
    await pickItem(MCP_ID);
    await pickRuntime();
    await answer('[data-catalog-preview]');
    expect(q('[data-catalog-failure]')?.textContent).toContain('somewhere other than the file says');
    expect(q('[data-catalog-confirm]')).toBeNull();
    await view.unmount();
  });
});

describe('an item a member already opened', () => {
  async function openShared(handlers: Parameters<typeof fakeClient>[0]) {
    const fake = fakeClient({ ...baseHandlers, ...handlers });
    const opened = await openCatalogFile(fileText, crypto);
    if (!opened.ok) throw new Error(opened.sentence);
    const view = await mount(
      <InstallFromFileSheet
        connection={connection}
        source={{ opened: opened.opened, itemId: MCP_ID, publisherLabel: 'Studio' }}
        onClose={() => undefined}
        host={{ createClient: fake.factory, crypto, projects: PROJECTS, runtimes: BOX }}
      />,
    );
    await settle();
    return { fake, view };
  }

  it('skips the file chooser, lists only that item and says who shared it', async () => {
    const { view } = await openShared({});
    expect(q('[data-catalog-sheet="install"] h3')?.textContent).toBe('Install on a machine');
    expect(q('[data-catalog-file-input]')).toBeNull();
    expect(q('[data-catalog-pick-file]')).toBeNull();
    expect(q(`[data-catalog-file-item="${MCP_ID}"]`)).not.toBeNull();
    expect(q(`[data-catalog-file-item="${SKILL_ID}"]`)).toBeNull();
    expect(q('[data-catalog-shared-by]')?.textContent).toBe('You call this publisher: Studio');
    expect(text()).not.toContain('withdrawn');
    await view.unmount();
  });

  it('goes through the same review and confirm on the member’s own machine before anything is installed', async () => {
    const { fake, view } = await openShared({
      [RUNTIME_PREVIEW]: () => agreeingPreview({ secrets: [] }),
      [RUNTIME_APPLY]: () => ({ install: installRecord('mcp', 'acme-mcp'), notes: [] }),
    });
    await pickRuntime();
    await answer('[data-catalog-preview]');
    expect(q('[data-catalog-confirm]')).not.toBeNull();
    expect(fake.calls.some(call => `${call.method} ${call.path}` === RUNTIME_APPLY)).toBe(false);
    await answer('[data-catalog-install]');
    expect(fake.calls.some(call => `${call.method} ${call.path}` === RUNTIME_APPLY)).toBe(true);
    await view.unmount();
  });

  it('starts on the place it is asked to prefer, and the person can still change it', async () => {
    const fake = fakeClient({ ...baseHandlers });
    const opened = await openCatalogFile(fileText, crypto);
    if (!opened.ok) throw new Error(opened.sentence);
    const view = await mount(
      <InstallFromFileSheet
        connection={connection}
        source={{ opened: opened.opened, itemId: MCP_ID, publisherLabel: 'Studio' }}
        preferredTarget={{ scope: 'project', projectRoot: '/work/proj', harness: 'claude' }}
        onClose={() => undefined}
        host={{ createClient: fake.factory, crypto, projects: PROJECTS, runtimes: BOX }}
      />,
    );
    await settle();
    expect((q('[data-catalog-scope]') as HTMLSelectElement).value).toBe('project');
    expect((q('[data-catalog-project]') as HTMLSelectElement).value).toBe('/work/proj');
    await choose('[data-catalog-scope]', 'runtime');
    expect((q('[data-catalog-scope]') as HTMLSelectElement).value).toBe('runtime');
    await view.unmount();
  });
});

describe('B16 the runtime and profile an item installs into are the target machine’s own', () => {
  const TARGETS = 'GET /v1/catalog-installs/targets';
  const noHostRuntimes = { runtimes: undefined } as unknown as Partial<InstallHost>;

  it('reads the runtimes of the machine installed onto and offers each with its profile', async () => {
    const { fake, view } = await open(
      { [TARGETS]: () => ({ runtimes: [{ id: 'studio', name: 'Studio', profile: 'lean', harness: 'claude' }] }) },
      noHostRuntimes,
    );
    await giveText(fileText);
    await settle();
    await choose('[data-catalog-scope]', 'runtime');
    expect(q('[data-catalog-runtime]')?.textContent).toContain('studio · lean');
    expect(fake.calls.filter(call => call.path === '/v1/catalog-installs/targets')).toHaveLength(1);
    await view.unmount();
  });

  it('offers no runtime, and says nothing broken, when the machine cannot answer', async () => {
    const { view } = await open(
      {
        [TARGETS]: () => {
          throw new DaemonCallError(503, 'catalog_kind_unavailable', 'No item provider can read runtime targets.');
        },
      },
      noHostRuntimes,
    );
    await giveText(fileText);
    await settle();
    await choose('[data-catalog-scope]', 'runtime');
    expect(q('[data-catalog-runtime]')?.querySelectorAll('option')).toHaveLength(1);
    await view.unmount();
  });

  it('asks nothing when the host names the runtimes itself', async () => {
    const { fake, view } = await open({}, {});
    await giveText(fileText);
    await settle();
    expect(fake.calls.some(call => call.path === '/v1/catalog-installs/targets')).toBe(false);
    await view.unmount();
  });
});
