/**
 * The three stored switches, from the composer's side of the seam.
 *
 * The settings unit can prove that a switch persists and this file can prove
 * that the engine honours one, and BOTH can pass while nothing connects them —
 * which is exactly the state this repository keeps finding. So these tests
 * render the real `Composer` with the real providers and assert what a reader
 * sees: a menu that opens, a menu that does not, and a draft that survives the
 * change.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ReactTestRenderer } from 'react-test-renderer';
import { Composer } from '../../../../app/composer/composer.tsx';
import type { ComposerSuggestionSwitches } from '../../../../app/composer/composer-autocomplete.ts';
import { daemonConnection } from '../../../../app/composer/seam.ts';
import type { ReferenceCatalogEntry, ReferenceCatalogPrefix } from '../../../../contract/index.ts';
import { fakeClient, withClient } from '../../../support/app/composer-host.tsx';
import { ensureDom, render, run, runAsync } from '@ferretry/app/testing';
import { writeMdComposePref } from '@ferretry/app';

ensureDom();

// The general composer behaviour is one key arbitration for every editor style; these suites drive it
// through the Plain textarea. The live editor (Markdown and Rich text) has its own suites.
beforeEach(() => writeMdComposePref('off'));
afterEach(() => writeMdComposePref('on'));

const renderers: ReactTestRenderer[] = [];

afterEach(() => {
  run(() => {
    for (const renderer of renderers.splice(0)) renderer.unmount();
  });
});

const daemon = daemonConnection('daemon-a');
const api = { send: async () => undefined } as never;
/** These switch assertions exercise menu policy: every read a family makes of its own is refused. */
const SKILLS: readonly ReferenceCatalogEntry[] = [{ token: 'summary', label: '', detail: 'Give a fast recap' }];

/** A host's catalogs, as the chat page's `useComposerReferenceCatalogs` hands them over. */
const catalogsOf = (
  entries: Partial<Record<ReferenceCatalogPrefix, readonly ReferenceCatalogEntry[]>>,
  settled: () => Promise<void> | undefined = () => undefined,
) => ({ entries, provided: {}, failures: {}, settled });

/** A client that refuses every read and remembers which catalogs were asked for. */
const recordingClient = () => {
  const calls: { route: string; prefix?: string }[] = [];
  const client = fakeClient(async (route, init) => {
    calls.push({ route, prefix: init?.query?.prefix });
    throw new Error('not in this suite');
  });
  return { client, calls };
};
const skillReads = (calls: readonly { prefix?: string }[]) =>
  calls.filter(call => call.prefix === '/' || call.prefix === '$');

const ALL_ON: ComposerSuggestionSwitches = {
  mentionSuggestions: true,
  ladderSuggestions: true,
  directReferenceSuggestions: true,
  skillSuggestions: true,
};

const mounted = (element: Parameters<typeof render>[0]): ReactTestRenderer => {
  const renderer = render(element);
  renderers.push(renderer);
  return renderer;
};

const type = (view: ReactTestRenderer, value: string): void => {
  run(() =>
    view.root
      .findByType('textarea')
      .props.onChange({ currentTarget: { value, selectionStart: value.length, selectionEnd: value.length } }),
  );
};

const opened = (view: ReactTestRenderer): boolean => view.root.findByType('textarea').props['aria-expanded'] === true;

describe('composer suggestion switches', () => {
  test('suppresses the WHOLE @ ladder, bare @ included, and nothing else', () => {
    const view = mounted(
      <Composer api={api} daemon={daemon} ferretId="ferret-a" suggestions={{ ...ALL_ON, mentionSuggestions: false }} />,
    );

    for (const draft of ['@', '@src/api', '@@ott', '@@@A3', '@@@@F1']) {
      type(view, draft);
      expect(opened(view)).toBe(false);
    }
    // The families with their own switch are untouched by this one.
    type(view, ':zel');
    expect(opened(view)).toBe(true);
  });

  test('suppresses the three direct sigils together, leaving / and % offered', () => {
    const view = mounted(
      <Composer
        api={api}
        daemon={daemon}
        ferretId="ferret-a"
        suggestions={{ ...ALL_ON, directReferenceSuggestions: false }}
      />,
    );

    for (const draft of [':zel', '!A3', '&F1']) {
      type(view, draft);
      expect(opened(view)).toBe(false);
    }
    type(view, '/sum');
    expect(opened(view)).toBe(true);
    type(view, '%term');
    expect(opened(view)).toBe(true);
  });

  test('suppresses $ while / keeps every skill reachable', () => {
    const view = mounted(
      <Composer api={api} daemon={daemon} ferretId="ferret-a" suggestions={{ ...ALL_ON, skillSuggestions: false }} />,
    );

    type(view, '$sum');
    expect(opened(view)).toBe(false);
    type(view, '/sum');
    expect(opened(view)).toBe(true);
  });

  test('applies a flipped switch immediately, without remounting or clearing the draft', () => {
    const view = mounted(
      <Composer
        api={api}
        daemon={daemon}
        ferretId="ferret-a"
        suggestions={{ ...ALL_ON, directReferenceSuggestions: false }}
      />,
    );

    type(view, 'ask :zel');
    expect(opened(view)).toBe(false);

    run(() => view.update(<Composer api={api} daemon={daemon} ferretId="ferret-a" suggestions={ALL_ON} />));

    // The same draft, the same caret, and the menu the reader just enabled.
    expect(view.root.findByType('textarea').props.value).toBe('ask :zel');
    expect(opened(view)).toBe(true);
  });

  test('offers the @ ladder and skills when the host knows nothing about the switches', () => {
    const view = mounted(<Composer api={api} daemon={daemon} ferretId="ferret-a" />);

    for (const draft of [':zel', '!A3', '&F1']) {
      type(view, draft);
      expect(opened(view)).toBe(false);
    }
    for (const draft of ['@src', '@@ott', '@@@@F1', '$sum']) {
      type(view, draft);
      expect(opened(view)).toBe(true);
    }
  });

  test('reads the host-supplied skills catalog for BOTH sigils, and asks the daemon for none', () => {
    const { client, calls } = recordingClient();
    const view = mounted(
      withClient(
        <Composer
          api={api}
          referenceCatalogs={catalogsOf({ '/': SKILLS, $: SKILLS })}
          daemon={daemon}
          ferretId="ferret-a"
          suggestions={ALL_ON}
        />,
        client,
      ),
    );

    type(view, '/sum');
    expect(view.root.findAllByProps({ 'data-kind': 'skill' }).length).toBeGreaterThan(0);
    type(view, '$sum');
    expect(view.root.findAllByProps({ 'data-kind': 'skill' }).length).toBeGreaterThan(0);

    // The page already read this catalog for the transcript's own `/skill`
    // proof. A second read would be a second answer that can disagree with it.
    expect(skillReads(calls)).toEqual([]);
  });

  test('waits for the host’s in-flight read instead of racing it with a second request', async () => {
    const { client, calls } = recordingClient();
    // The state a reader meets on the first message of every ferret: the page
    // has issued its ONE read and nothing has come back yet.
    let settle: () => void = () => undefined;
    const hostRead = new Promise<void>(resolve => {
      settle = resolve;
    });
    const view = mounted(
      withClient(
        <Composer api={api} referenceCatalogs={catalogsOf({}, () => hostRead)} daemon={daemon} ferretId="ferret-a" />,
        client,
      ),
    );

    type(view, '$sum');
    await runAsync(async () => {
      await Promise.resolve();
    });
    // Still nothing read: the menu is waiting for the read already running.
    expect(skillReads(calls)).toEqual([]);

    await runAsync(async () => {
      settle();
      await hostRead;
      view.update(
        withClient(
          <Composer
            api={api}
            referenceCatalogs={catalogsOf({ '/': SKILLS, $: SKILLS })}
            daemon={daemon}
            ferretId="ferret-a"
          />,
          client,
        ),
      );
      await Promise.resolve();
    });

    // The host's answer is the answer, and the daemon was never asked twice.
    expect(skillReads(calls)).toEqual([]);
    expect(view.root.findAllByProps({ 'data-kind': 'skill' }).length).toBeGreaterThan(0);
  });
});
