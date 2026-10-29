import { afterEach, describe, expect, it } from 'bun:test';
import { Sparkles } from 'lucide-react';
import {
  WhatsNewProvider,
  useWhatsNewEntry,
  useWhatsNewHost,
} from '../../../../src/features/whats-new/whats-new-host.tsx';
import {
  WHATS_NEW_FIRST_PAGE,
  WhatsNewSheet,
  type WhatsNewPresentation,
} from '../../../../src/features/whats-new/whats-new-sheet.tsx';
import { type ChangelogRelease, type ChangelogStorage, readLastViewed } from '../../../../src/lib/changelog.ts';
import { whatsNewPaletteCommand } from '../../../../src/shell/palette-destinations.ts';
import { interact, type Mounted, mount, must, pressKey } from '../../../support/dom.ts';

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
    <WhatsNewProvider value={host.entry}>
      <Reader />
      <p data-open={String(host.open)} data-fresh={[...host.fresh].join(',')} />
    </WhatsNewProvider>
  );
}

function Reader() {
  const entry = useWhatsNewEntry();
  return (
    <button type="button" data-door="" data-unread={String(entry?.unread)} onClick={entry?.open}>
      {entry?.latest}
    </button>
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
  });

  it('is absent without a host', async () => {
    view = await mount(<Reader />);
    expect(door().getAttribute('data-unread')).toBe('undefined');
  });
});

describe('the finder command', () => {
  it('is findable by the words people use for it', () => {
    let ran = 0;
    const command = whatsNewPaletteCommand(Sparkles, () => (ran += 1));
    expect(command.label).toBe('What’s new');
    expect(command.searchTerms).toContain('changelog');
    expect(command.searchTerms).toContain('release notes');
    command.run();
    expect(ran).toBe(1);
  });
});
