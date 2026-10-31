import { beforeAll, describe, expect, it } from 'bun:test';
import { type InstallMachine, SharedItemSheet } from '../../../../src/features/shared/shared-item-sheet.tsx';
import { NOT_PAIRED_NOTE } from '../../../../src/features/shared/shared-screens-model.ts';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { fakeClient } from '../../../support/catalog-client.ts';
import { crypto } from '../../../support/catalog-files.ts';
import { installPreview, installRecord } from '../../../support/catalog-views.ts';
import { click, settle } from '../../../support/dom-form.ts';
import { interact, mount } from '../../../support/dom.ts';
import { type SharedItemFixture, sharedItemFixture } from '../../../support/shared-screens.ts';

const q = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector);
const text = (): string => document.body.textContent ?? '';

const alpha = daemonConnection({ daemonId: 'alpha', baseUrl: 'https://alpha.example.test', deviceId: 'token-a' });
const beta = daemonConnection({ daemonId: 'beta', baseUrl: 'https://beta.example.test', deviceId: 'token-b' });
const machines = (...which: (typeof alpha)[]): InstallMachine[] =>
  which.map(connection => ({ connection, name: connection.daemonId === 'alpha' ? 'Studio laptop' : 'Build box' }));

let shared: SharedItemFixture;
beforeAll(async () => {
  shared = await sharedItemFixture();
});

const shown = (which: 'skill' | 'mcp') => {
  const item = which === 'skill' ? shared.skill : shared.mcp;
  const entry = shared.entries.find(candidate => candidate.itemId === item.itemId);
  if (entry === undefined) throw new Error('no entry');
  return { item, opened: shared.opened, entry };
};

/** The machine's review of the same item the publisher signed, as the daemon would answer it. */
const agreeingPreview = (which: 'skill' | 'mcp' = 'mcp') => {
  const { entry } = shown(which);
  const base = installPreview();
  return installPreview({
    provenance: {
      ...base.provenance,
      publisher: shared.identity.daemonId,
      catalogName: "Kirin's catalog",
      itemId: entry.itemId,
      kind: entry.kind,
      name: entry.name,
      version: entry.version,
      digest: entry.digest,
    },
    publisher: { ...base.publisher, daemonId: shared.identity.daemonId },
  });
};

async function sheet(which: 'skill' | 'mcp', list: InstallMachine[], handlers: Parameters<typeof fakeClient>[0] = {}) {
  const asked: string[] = [];
  const closed: string[] = [];
  const fake = fakeClient({
    'GET /v1/fleet/runtimes': () => ({ runtimes: [{ id: 'box', profile: 'default' }] }),
    'GET /v1/secrets': () => ({ v: 1, health: 'ready', secrets: [{ name: 'ACME_TOKEN' }], references: [] }),
    ...handlers,
  });
  const view = await mount(
    <SharedItemSheet
      shown={shown(which)}
      publisherLabel="Studio"
      machines={list}
      installHost={{
        createClient: async connection => {
          asked.push(connection.daemonId);
          return fake.client as never;
        },
        crypto,
        projects: [],
      }}
      onClose={() => closed.push('closed')}
    />,
  );
  await settle();
  return { view, asked, closed, fake };
}

describe('reading a shared item', () => {
  it('shows the item, who shared it, and every file in full', async () => {
    const { view, closed } = await sheet('skill', machines(alpha));
    expect(q('[data-catalog-sheet="shared-item"] h3')?.textContent).toBe('pdf-tools');
    expect(text()).toContain('Skill · version 1 · from Studio');
    expect(text()).toContain('Split, merge and OCR PDFs');
    expect(q('[data-review-body]')).not.toBeNull();
    expect(q('[data-review-file="SKILL.md"]')?.textContent).toContain('# pdf tools');
    await click(q('button[aria-label="Close pdf-tools"]'));
    expect(closed).toEqual(['closed']);
    await view.unmount();
  });

  it('shows the command an MCP server starts, as the installer sees it', async () => {
    const { view } = await sheet('mcp', machines(alpha));
    expect(q('[data-review-body]')?.textContent).toContain('acme-mcp');
    await view.unmount();
  });

  it('says a machine must be paired first, and offers no install', async () => {
    const { view } = await sheet('skill', []);
    expect(q('[data-shared-not-paired]')?.textContent).toBe(NOT_PAIRED_NOTE);
    expect(q('[data-shared-install-button]')).toBeNull();
    await view.unmount();
  });
});

describe('Install on a machine', () => {
  it('hands the verified item to the one paired machine and goes back when closed', async () => {
    const { view, asked } = await sheet('mcp', machines(alpha), {
      'POST /v1/catalog-installs/runtime/preview': () => agreeingPreview(),
      'POST /v1/catalog-installs/runtime': () => ({ install: installRecord('mcp', 'acme-mcp'), notes: [] }),
    });
    expect(q('[data-shared-machine]')).toBeNull();
    await click(q('[data-shared-install-button]'));
    expect(q('[data-catalog-sheet="install"] h3')?.textContent).toBe('Install on a machine');
    expect(q('[data-catalog-shared-by]')?.textContent).toBe('You call this publisher: Studio');
    expect(q('[data-catalog-file-input]')).toBeNull();
    expect(document.querySelectorAll('[data-catalog-file-item]')).toHaveLength(1);
    expect(
      q('[data-catalog-file-item] input')?.hasAttribute('checked') ||
        (q('[data-catalog-file-item] input') as HTMLInputElement).checked,
    ).toBe(true);

    const choose = async (selector: string, value: string) => {
      const select = q(selector) as HTMLSelectElement;
      await interact(() => {
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await settle();
    };
    await choose('[data-catalog-scope]', 'runtime');
    await choose('[data-catalog-runtime]', 'box');
    await click(q('[data-catalog-preview]'));
    await settle();
    expect(q('[data-catalog-confirm]')).not.toBeNull();
    expect(q('[data-catalog-confirm]')?.textContent).toContain('acme-mcp --stdio');
    expect(asked.every(id => id === 'alpha')).toBe(true);
    await view.unmount();
  });

  it('lets the person pick which machine, and uses that machine’s own client', async () => {
    const { view, asked } = await sheet('skill', machines(alpha, beta));
    const select = q('[data-shared-machine]') as HTMLSelectElement;
    expect([...select.options].map(option => option.textContent)).toEqual(['Studio laptop', 'Build box']);
    await interact(() => {
      select.value = 'beta';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await click(q('[data-shared-install-button]'));
    await settle();
    expect(asked.length).toBeGreaterThan(0);
    expect(new Set(asked)).toEqual(new Set(['beta']));
    await view.unmount();
  });

  it('returns to the review when the install sheet is closed', async () => {
    const { view } = await sheet('skill', machines(alpha));
    await click(q('[data-shared-install-button]'));
    expect(q('[data-catalog-sheet="shared-item"]')).toBeNull();
    await click(q('button[aria-label="Close Install on a machine"]'));
    expect(q('[data-catalog-sheet="shared-item"]')).not.toBeNull();
    await view.unmount();
  });
});
