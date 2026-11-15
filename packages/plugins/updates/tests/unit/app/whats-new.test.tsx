import { afterEach, describe, expect, it } from 'bun:test';
import { interact, type Mounted, mount, must, pressKey } from '@ferretry/app/testing';
import type { PluginCommandContext } from '@ferretry/app';
import type { CommandBarEntry } from '@ferretry/app/ui';
import { whatsNewCommands } from '../../../app/commands.ts';
import { type ChangelogRelease, type ChangelogStorage, readLastViewed } from '../../../app/lib/changelog.ts';
import { whatsNewRequests } from '../../../app/lib/whats-new-requests.ts';
import app from '../../../app/index.ts';
import { useWhatsNewHost, WhatsNewPanel } from '../../../app/views/whats-new-panel.tsx';
import { WHATS_NEW_FIRST_PAGE, WhatsNewSheet, type WhatsNewPresentation } from '../../../app/views/whats-new-sheet.tsx';
import manifest from '../../../manifest.ts';

const release = (version: string, withChanges = true): ChangelogRelease => ({
  version,
  date: '2026-10-28',
  releaseUrl: `https://github.com/o/r/releases/tag/v${version}`,
  groups: withChanges
    ? [
        {
          kind: 'features',
          title: 'New',
          changes: [
            {
              scope: 'chat',
              text: 'show a `reply` as it is written',
              pr: { number: 815, url: 'https://github.com/o/r/pull/815' },
            },
          ],
        },
        { kind: 'fixes', title: 'Fixed', changes: [{ text: 'stop flashing Reconnecting' }] },
      ]
    : [],
});

const many = (count: number): readonly ChangelogRelease[] =>
  Array.from({ length: count }, (_, index) => release(`4.${String(count - index)}.0`));

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const sheet = (
  releases: readonly ChangelogRelease[],
  presentation: WhatsNewPresentation,
  fresh: ReadonlySet<string> = new Set(),
  onClose: () => void = () => {},
) => <WhatsNewSheet fresh={fresh} onClose={onClose} open presentation={presentation} releases={releases} />;

describe('the What’s new sheet', () => {
  for (const presentation of ['dialog', 'sheet'] as const) {
    it(`shows version, date, grouped one-line changes with the scope as a tag (${presentation})`, async () => {
      view = await mount(sheet([release('4.2.0')], presentation));
      const block = must(view.container.ownerDocument.querySelector('[data-whats-new-release="4.2.0"]'), 'release');
      expect(block.querySelector('h3')?.textContent).toBe('4.2.0');
      expect(block.querySelector('time')?.textContent).toBe('28 Oct 2026');
      expect([...block.querySelectorAll('h4')].map(h => h.textContent)).toEqual(['New', 'Fixed']);
      expect(block.querySelector('[data-whats-new-scope]')?.textContent).toBe('chat');
      expect(block.querySelector('code')?.textContent).toBe('reply');
      expect(block.querySelector('a')?.getAttribute('href')).toBe('https://github.com/o/r/pull/815');
      expect(block.textContent).not.toContain('feat(');
    });
  }

  it('marks only the fresh versions with a New chip', async () => {
    view = await mount(sheet([release('4.2.0'), release('4.1.0')], 'dialog', new Set(['4.2.0'])));
    const doc = view.container.ownerDocument;
    expect(doc.querySelector('[data-whats-new-release="4.2.0"] [data-whats-new-new]')).not.toBeNull();
    expect(doc.querySelector('[data-whats-new-release="4.1.0"] [data-whats-new-new]')).toBeNull();
  });

  it('keeps the GitHub release link as a secondary link to the newest release', async () => {
    view = await mount(sheet([release('4.2.0'), release('4.1.0')], 'dialog'));
    const link = must(view.container.ownerDocument.querySelector('[data-whats-new-github]'), 'link');
    expect(link.textContent).toContain('Full release on GitHub');
    expect(link.getAttribute('href')).toBe('https://github.com/o/r/releases/tag/v4.2.0');
  });

  it('opens on a page of releases and reveals older ones on request', async () => {
    view = await mount(sheet(many(WHATS_NEW_FIRST_PAGE + 5), 'dialog'));
    const doc = view.container.ownerDocument;
    expect(doc.querySelectorAll('[data-whats-new-release]').length).toBe(WHATS_NEW_FIRST_PAGE);
    await interact(() => (must(doc.querySelector('[data-whats-new-older]'), 'older') as HTMLElement).click());
    expect(doc.querySelectorAll('[data-whats-new-release]').length).toBe(WHATS_NEW_FIRST_PAGE + 5);
    expect(doc.querySelector('[data-whats-new-older]')).toBeNull();
  });

  it('says so for a release with no user-facing changes, and for a build with no notes', async () => {
    view = await mount(sheet([release('4.2.0', false)], 'dialog'));
    expect(view.container.ownerDocument.body.textContent).toContain('Behind-the-scenes fixes only.');
    await view.unmount();
    view = await mount(sheet([], 'dialog'));
    expect(view.container.ownerDocument.querySelector('[data-whats-new-empty]')).not.toBeNull();
  });

  it('closes on Escape and on the close button', async () => {
    let closed = 0;
    view = await mount(sheet([release('4.2.0')], 'dialog', new Set(), () => (closed += 1)));
    const doc = view.container.ownerDocument;
    await interact(() => pressKey(must(doc.querySelector('[role="dialog"]'), 'dialog'), 'Escape'));
    await interact(() => (must(doc.querySelector('[data-whats-new-close]'), 'close') as HTMLElement).click());
    expect(closed).toBeGreaterThanOrEqual(2);
  });
});

describe('the What’s new dialog backdrop', () => {
  it('ignores the click synthesized from the tap that opened it, and closes on a real backdrop tap', async () => {
    let closed = 0;
    view = await mount(sheet([release('4.2.0')], 'dialog', new Set(), () => (closed += 1)));
    const backdrop = must(view.container.querySelector('[data-whats-new="dialog"] > button'), 'backdrop');
    const pointerClick = () => backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    await interact(pointerClick);
    expect(closed).toBe(0);
    await interact(() => backdrop.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    await interact(pointerClick);
    expect(closed).toBe(1);
  });
});

const memory = (initial?: string): ChangelogStorage & { readonly values: Map<string, string> } => {
  const values = new Map<string, string>(initial === undefined ? [] : [['fy-whats-new-viewed-v1', initial]]);
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value) };
};

function Probe({
  releases,
  storage,
}: {
  readonly releases: readonly ChangelogRelease[];
  readonly storage: ChangelogStorage;
}) {
  const host = useWhatsNewHost(releases, storage);
  return (
    <>
      <button type="button" data-door="" data-unread={String(host.unread)} onClick={host.open}>
        {host.latest}
      </button>
      <p data-open={String(host.shown)} data-fresh={[...host.fresh].join(',')} />
      <button type="button" data-shut="" onClick={host.close} />
    </>
  );
}

describe('the What’s new host', () => {
  const state = () => must(view?.container.ownerDocument.querySelector('[data-open]'), 'state');
  const door = () => must(view?.container.ownerDocument.querySelector('[data-door]'), 'door') as HTMLElement;

  it('treats a first-time device as caught up, so nothing is new until the next release', async () => {
    const storage = memory();
    view = await mount(<Probe releases={[release('4.2.0'), release('4.1.0')]} storage={storage} />);
    expect(door().getAttribute('data-unread')).toBe('false');
    expect(readLastViewed(storage)).toBe('4.2.0');
    await interact(() => door().click());
    expect(state().getAttribute('data-open')).toBe('true');
    expect(state().getAttribute('data-fresh')).toBe('');
  });

  it('flags a release newer than the last viewed one, keeps its chip while open, then records it', async () => {
    const storage = memory('4.1.0');
    view = await mount(<Probe releases={[release('4.2.0'), release('4.1.0')]} storage={storage} />);
    expect(door().getAttribute('data-unread')).toBe('true');
    await interact(() => door().click());
    expect(state().getAttribute('data-fresh')).toBe('4.2.0');
    expect(readLastViewed(storage)).toBe('4.2.0');
    expect(door().getAttribute('data-unread')).toBe('false');
    await interact(() =>
      (must(view?.container.ownerDocument.querySelector('[data-shut]'), 'shut') as HTMLElement).click(),
    );
    expect(state().getAttribute('data-open')).toBe('false');
  });

  it('opens without recording anything for a build that carries no notes', async () => {
    const storage = memory();
    view = await mount(<Probe releases={[]} storage={storage} />);
    await interact(() => door().click());
    expect(state().getAttribute('data-open')).toBe('true');
    expect(storage.values.size).toBe(0);
  });
});

describe('the What’s new panel on This device', () => {
  const host = globalThis as { __FY_CHANGELOG__?: unknown };
  const NOTES = [
    '## [4.2.0](https://github.com/o/r/compare/v4.1.0...v4.2.0) (2026-10-28)',
    '',
    '### Features',
    '',
    '* **chat:** show a reply as it is written',
    '',
    '## [4.1.0](https://github.com/o/r/compare/v4.0.0...v4.1.0) (2026-10-20)',
    '',
    '### Fixes',
    '',
    '* stop flashing Reconnecting',
    '',
  ].join('\n');
  afterEach(() => {
    delete host.__FY_CHANGELOG__;
    whatsNewRequests.take();
    globalThis.localStorage.clear();
  });

  const entry = () => must(view?.container.querySelector('[data-whats-new-open]'), 'entry') as HTMLElement;

  it('is declared in device.settings and drawn from the shell’s device-settings section', () => {
    expect(manifest.ui?.panels?.some(panel => panel.slot === 'device.settings' && panel.id === 'whats-new')).toBe(true);
    const shell = (app as { shell?: { deviceSettings?: Record<string, unknown>; commands?: unknown } }).shell;
    expect(typeof shell?.deviceSettings?.['whats-new']).toBe('function');
    expect(shell?.commands).toBe(whatsNewCommands);
  });

  it('opens the sheet from its button and names the newest version', async () => {
    host.__FY_CHANGELOG__ = NOTES;
    view = await mount(<WhatsNewPanel />);
    expect(entry().textContent).toBe('What’s new in 4.2.0');
    expect(view.container.ownerDocument.querySelector('[role="dialog"], [data-whats-new]')).toBeNull();
    await interact(() => entry().click());
    expect(view.container.ownerDocument.querySelector('[data-whats-new-release="4.2.0"]')).not.toBeNull();
  });

  it('shows New beside the entry for a release newer than the last one viewed', async () => {
    host.__FY_CHANGELOG__ = NOTES;
    globalThis.localStorage.setItem('fy-whats-new-viewed-v1', '4.1.0');
    view = await mount(<WhatsNewPanel />);
    expect(view.container.querySelector('[data-whats-new-unread]')).not.toBeNull();
    await interact(() => entry().click());
    expect(view.container.querySelector('[data-whats-new-unread]')).toBeNull();
    expect(
      view.container.ownerDocument.querySelector('[data-whats-new-release="4.2.0"] [data-whats-new-new]'),
    ).not.toBeNull();
  });

  it('names no version for a build that stamped no notes', async () => {
    view = await mount(<WhatsNewPanel />);
    expect(entry().textContent).toBe('What’s new');
  });

  it('opens the sheet for a request waiting when it mounts, and takes the request off the line', async () => {
    host.__FY_CHANGELOG__ = NOTES;
    whatsNewRequests.request();
    view = await mount(<WhatsNewPanel />);
    expect(view.container.ownerDocument.querySelector('[data-whats-new-release="4.2.0"]')).not.toBeNull();
    expect(whatsNewRequests.snapshot()).toBe(false);
  });

  it('opens the sheet for a request made while it is already on screen', async () => {
    host.__FY_CHANGELOG__ = NOTES;
    view = await mount(<WhatsNewPanel />);
    await interact(() => whatsNewRequests.request());
    expect(view.container.ownerDocument.querySelector('[data-whats-new-release="4.2.0"]')).not.toBeNull();
  });
});

describe('the command bar entry', () => {
  const context = (navigate: (href: string) => void): PluginCommandContext => ({
    client: {} as PluginCommandContext['client'],
    daemon: 'd1',
    navigate,
    screenHref: (() => '') as unknown as PluginCommandContext['screenHref'],
    changed: () => {},
  });

  it('is findable by the words people use for it, and goes to This device with a request for the sheet', () => {
    const visited: string[] = [];
    const built = whatsNewCommands(context(href => visited.push(href)));
    const source = built as unknown as (query: string) => readonly CommandBarEntry[];
    const [command] = source('');
    expect(command?.label).toBe('What’s new');
    expect(command?.keywords).toContain('changelog');
    expect(command?.keywords).toContain('release notes');
    try {
      command?.run();
      expect(visited).toEqual(['/settings']);
      expect(whatsNewRequests.snapshot()).toBe(true);
    } finally {
      whatsNewRequests.take();
    }
  });
});
