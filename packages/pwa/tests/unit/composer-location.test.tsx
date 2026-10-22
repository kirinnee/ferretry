import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Composer } from '../../src/components/composer.tsx';
import { ComposerAddMenu } from '../../src/components/composer-add-menu.tsx';
import { PendingLocationChip } from '../../src/components/location-chip.tsx';
import { LocationShareContext } from '../../src/hooks/use-location-share.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { DaemonDraftStore, type DraftStorage } from '../../src/lib/drafts.ts';
import { LocationError, type LocationFix, type LocationShareHost } from '../../src/lib/location-share.ts';
import { writeMdComposePref } from '../../src/lib/md-compose.ts';
import '../support/dom.ts';
import { render, run, runAsync } from '../support/react.ts';

beforeEach(() => writeMdComposePref('off'));
afterEach(() => writeMdComposePref('on'));

const daemon = daemonConnection({ daemonId: 'loc', baseUrl: 'https://loc.example.test', deviceId: 'device' });

class MemoryStorage implements DraftStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const fix: LocationFix = {
  latitude: 51.50735,
  longitude: -0.12776,
  accuracyMeters: 20,
  capturedAt: Date.parse('2026-10-21T12:00:00.000Z'),
};

interface Pending {
  readonly resolve: (value: LocationFix) => void;
  readonly reject: (reason: unknown) => void;
}

const mountComposer = (host: LocationShareHost | null) => {
  let clicked = 0;
  const sent: { message: string }[] = [];
  const composer = render(
    <LocationShareContext.Provider value={host}>
      <Composer
        api={{
          send: async (_id: string, request: { message: string }) => {
            sent.push(request);
            return {} as never;
          },
        }}
        daemon={daemon}
        draftStore={new DaemonDraftStore(new MemoryStorage())}
        sessionId="s1"
      />
    </LocationShareContext.Provider>,
    {
      createNodeMock: element => {
        const props = element.props as { type?: string; 'data-composer-attach'?: string };
        if (element.type === 'input' && props.type === 'file') {
          return {
            click: () => {
              clicked += 1;
            },
          };
        }
        if (element.type === 'button' && props['data-composer-attach'] !== undefined) {
          return { closest: () => null, getBoundingClientRect: () => ({ left: 12, top: 34 }) };
        }
        return null;
      },
    },
  );
  const menu = () => composer.root.findByType(ComposerAddMenu);
  const chips = () => composer.root.findAllByType(PendingLocationChip);
  const chip = () => {
    const found = chips()[0];
    if (found === undefined) throw new Error('no location chip');
    return found;
  };
  const choose = (key: string) => {
    const item = menu().props.actions.find((entry: { key: string }) => entry.key === key);
    run(() => item.onSelect());
  };
  const openMenu = () => run(() => composer.root.findByProps({ 'data-composer-attach': '' }).props.onClick());
  // The camera row exists only on a touch device, and that is decided once per process by the test order.
  const labels = () =>
    menu()
      .props.actions.map((item: { label: string }) => item.label)
      .filter((label: string) => label !== 'Take photo');
  const submit = () => runAsync(async () => composer.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  return { composer, sent, menu, labels, chips, chip, choose, openMenu, submit, clicks: () => clicked };
};

const hostWith = () => {
  const pending: Pending[] = [];
  let calls = 0;
  const host: LocationShareHost = {
    locate: () => {
      calls += 1;
      return new Promise<LocationFix>((resolve, reject) => pending.push({ resolve, reject }));
    },
  };
  return { host, pending, calls: () => calls };
};

describe('composer share my location', () => {
  test('without a host the ＋ button reaches the file picker and never offers the location', () => {
    const view = mountComposer(null);
    view.openMenu();
    if (view.composer.root.findAllByType(ComposerAddMenu).length > 0) {
      expect(view.labels()).toEqual(['Attach files']);
      view.choose('attach');
    }
    expect(view.clicks()).toBe(1);
    run(() => view.composer.unmount());
  });

  test('with a host the ＋ button opens a menu that offers both a file and the location', () => {
    const { host } = hostWith();
    const view = mountComposer(host);
    expect(view.menu().props.open).toBe(false);
    view.openMenu();
    expect(view.menu().props.open).toBe(true);
    expect(view.menu().props.variant).toBe('popover');
    expect(view.labels()).toEqual(['Attach files', 'Share location']);
    view.choose('attach');
    expect(view.clicks()).toBe(1);
    run(() => view.menu().props.onClose());
    expect(view.menu().props.open).toBe(false);
    run(() => view.composer.unmount());
  });

  test('the location is asked for in the tap, held as a chip, named, and sent once with the message', async () => {
    const { host, pending, calls } = hostWith();
    const view = mountComposer(host);
    view.openMenu();
    view.choose('location');
    expect(calls()).toBe(1);
    expect(view.chip().props.draft).toEqual({ kind: 'locating' });
    // Naming a place before there is a reading changes nothing.
    run(() => view.chip().props.onPlace('Ignored'));
    expect(view.chip().props.draft).toEqual({ kind: 'locating' });

    await runAsync(async () => pending[0]?.resolve(fix));
    expect(view.chip().props.draft).toEqual({ kind: 'ready', fix });
    run(() => view.chip().props.onPlace('Home'));
    expect(view.chip().props.draft).toEqual({ kind: 'ready', fix: { ...fix, place: 'Home' } });

    await view.submit();
    expect(view.sent).toHaveLength(1);
    expect(view.sent[0]?.message).toBe(
      [
        'Here is where I am.',
        '',
        '```fy-location',
        'latitude: 51.50735',
        'longitude: -0.12776',
        'accuracy: 20 m',
        'captured: 2026-10-21T12:00:00.000Z',
        'place: Home',
        '```',
      ].join('\n'),
    );
    expect(view.chips()).toHaveLength(0);
    run(() => view.composer.unmount());
  });

  test('a typed message keeps its words ahead of the block', async () => {
    const { host, pending } = hostWith();
    const view = mountComposer(host);
    run(() =>
      view.composer.root
        .findByType('textarea')
        .props.onChange({ currentTarget: { value: 'Meet me here', selectionStart: 12, selectionEnd: 12 } }),
    );
    view.choose('location');
    await runAsync(async () => pending[0]?.resolve(fix));
    await view.submit();
    expect(view.sent[0]?.message.startsWith('Meet me here\n\n```fy-location\n')).toBe(true);
    run(() => view.composer.unmount());
  });

  test('a refusal is shown with its reason and can be retried; a plain failure reads as unavailable', async () => {
    const { host, pending, calls } = hostWith();
    const view = mountComposer(host);
    view.choose('location');
    await runAsync(async () => pending[0]?.reject(new LocationError('denied', 'Location is off.')));
    expect(view.chip().props.draft.kind).toBe('failed');
    expect(view.chip().props.draft.error.code).toBe('denied');
    run(() => view.chip().props.onRetry());
    expect(calls()).toBe(2);
    await runAsync(async () => pending[1]?.reject(new Error('boom')));
    expect(view.chip().props.draft.kind).toBe('failed');
    expect(view.chip().props.draft.error.code).toBe('unavailable');
    run(() => view.composer.unmount());
  });

  test('removing the chip drops a late answer instead of resurrecting it', async () => {
    const { host, pending } = hostWith();
    const view = mountComposer(host);
    view.choose('location');
    run(() => view.chip().props.onRemove());
    expect(view.chips()).toHaveLength(0);
    await runAsync(async () => pending[0]?.resolve(fix));
    expect(view.chips()).toHaveLength(0);
    view.choose('location');
    run(() => view.chip().props.onRemove());
    await runAsync(async () => pending[1]?.reject(new LocationError('timeout', 'Too slow.')));
    expect(view.chips()).toHaveLength(0);
    run(() => view.composer.unmount());
  });

  test('asking again supersedes the first answer', async () => {
    const { host, pending } = hostWith();
    const view = mountComposer(host);
    view.choose('location');
    view.choose('location');
    await runAsync(async () => pending[0]?.resolve({ ...fix, latitude: 1 }));
    expect(view.chip().props.draft.kind).toBe('locating');
    await runAsync(async () => pending[1]?.resolve(fix));
    expect(view.chip().props.draft).toEqual({ kind: 'ready', fix });
    run(() => view.composer.unmount());
  });

  test('the menu action alone starts a locating chip', () => {
    const { host } = hostWith();
    const view = mountComposer(host);
    view.choose('location');
    expect(view.chips()).toHaveLength(1);
    run(() => view.composer.unmount());
  });
});
