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

import { afterEach, describe, expect, test } from 'bun:test';
import type { ReactTestRenderer } from 'react-test-renderer';
import { Composer as ProductionComposer, type ComposerProps } from '../../src/components/composer.tsx';
import type { ComposerSuggestionSwitches } from '../../src/components/composer-autocomplete.ts';
import type { ComposerSkillsCatalog } from '../../src/components/composer-autocomplete-providers.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import type { DaemonFetch } from '../../src/lib/runtime-models.ts';
import { render, run, runAsync } from '../support/react.ts';

const renderers: ReactTestRenderer[] = [];
const originalFetch = globalThis.fetch;

afterEach(() => {
  run(() => {
    for (const renderer of renderers.splice(0)) renderer.unmount();
  });
  globalThis.fetch = originalFetch;
});

const daemon = daemonConnection({
  daemonId: 'daemon-a',
  baseUrl: 'https://daemon-a.example.test',
  deviceToken: 'token-a',
});
const api = { send: async () => undefined } as never;
/** These switch assertions exercise menu policy; their daemon reads are fixtures. */
const autocompleteFetch: DaemonFetch = async () => Response.json({}, { status: 500 });
const Composer = (props: ComposerProps) => <ProductionComposer {...props} autocompleteFetcher={autocompleteFetch} />;

const ALL_ON: ComposerSuggestionSwitches = {
  mentionSuggestions: true,
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
      <Composer
        api={api}
        daemon={daemon}
        sessionId="session-a"
        suggestions={{ ...ALL_ON, mentionSuggestions: false }}
      />,
    );

    for (const draft of ['@', '@src/api', '@@ott', '@@@F12', '@@@@A3']) {
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
        sessionId="session-a"
        suggestions={{ ...ALL_ON, directReferenceSuggestions: false }}
      />,
    );

    for (const draft of [':zel', '&F12', '!A3']) {
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
      <Composer api={api} daemon={daemon} sessionId="session-a" suggestions={{ ...ALL_ON, skillSuggestions: false }} />,
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
        sessionId="session-a"
        suggestions={{ ...ALL_ON, directReferenceSuggestions: false }}
      />,
    );

    type(view, 'ask :zel');
    expect(opened(view)).toBe(false);

    run(() => view.update(<Composer api={api} daemon={daemon} sessionId="session-a" suggestions={ALL_ON} />));

    // The same draft, the same caret, and the menu the reader just enabled.
    expect(view.root.findByType('textarea').props.value).toBe('ask :zel');
    expect(opened(view)).toBe(true);
  });

  test('offers every family when the host knows nothing about the switches', () => {
    const view = mounted(<Composer api={api} daemon={daemon} sessionId="session-a" />);

    for (const draft of ['@src', ':zel', '&F12', '!A3', '$sum']) {
      type(view, draft);
      expect(opened(view)).toBe(true);
    }
  });

  test('reads the host-supplied skills catalog for BOTH sigils, and asks the daemon for none', () => {
    const requests: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return new Response('{}', { status: 500 });
    }) as typeof fetch;
    const skills: ComposerSkillsCatalog = {
      harness: 'claude',
      skills: [{ name: 'summary', description: 'Give a fast recap' }],
    };
    const view = mounted(
      <Composer api={api} autocompleteSkills={skills} daemon={daemon} sessionId="session-a" suggestions={ALL_ON} />,
    );

    type(view, '/sum');
    expect(view.root.findAllByProps({ 'data-kind': 'skill' }).length).toBeGreaterThan(0);
    type(view, '$sum');
    expect(view.root.findAllByProps({ 'data-kind': 'skill' }).length).toBeGreaterThan(0);

    // The page already read this catalog for the transcript's own `/skill`
    // proof. A second read would be a second answer that can disagree with it.
    expect(requests.filter(url => url.includes('/skills'))).toEqual([]);
  });

  test('waits for the host’s in-flight read instead of racing it with a second request', async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return new Response(JSON.stringify({ harness: 'claude', skills: [] }), { status: 200 });
    }) as typeof fetch;

    // The state a reader meets on the first message of every session: the page
    // has issued its ONE read and nothing has come back yet.
    let settle: () => void = () => undefined;
    const hostRead = new Promise<void>(resolve => {
      settle = resolve;
    });
    let skills: ComposerSkillsCatalog | undefined;
    const view = mounted(
      <Composer
        api={api}
        autocompleteReady={() => hostRead}
        {...(skills === undefined ? {} : { autocompleteSkills: skills })}
        daemon={daemon}
        sessionId="session-a"
      />,
    );

    type(view, '$sum');
    await runAsync(async () => {
      await Promise.resolve();
    });
    // Still nothing fetched: the menu is waiting for the read already running.
    expect(requests.filter(url => url.includes('/skills'))).toEqual([]);

    skills = { harness: 'claude', skills: [{ name: 'summary', description: 'Give a fast recap' }] };
    await runAsync(async () => {
      settle();
      await hostRead;
      view.update(
        <Composer
          api={api}
          autocompleteReady={() => undefined}
          autocompleteSkills={skills}
          daemon={daemon}
          sessionId="session-a"
        />,
      );
      await Promise.resolve();
    });

    // The host's answer is the answer, and the daemon was never asked twice.
    expect(requests.filter(url => url.includes('/skills'))).toEqual([]);
    expect(view.root.findAllByProps({ 'data-kind': 'skill' }).length).toBeGreaterThan(0);
  });
});
