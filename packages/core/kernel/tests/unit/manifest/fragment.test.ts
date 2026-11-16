/**
 * `manifestFragment` is the plugin kit's fragment builder: a fragment names the sections it contributes and every other
 * section is an empty list, so a merged list is always whole.
 */
import { describe, expect, test } from 'bun:test';
import { manifestFragment, panel, route, screen } from '../../../manifest/index.ts';

const descriptor = {
  minimum: 'operator',
  caller: 'any',
  audit: { skip: 'a fixture records nothing' },
  guard: { none: 'a fixture guards nothing' },
} as const;

describe('manifestFragment', () => {
  test('a section a fragment does not name is an empty list, in every group', () => {
    const empty = manifestFragment({});
    expect(empty).toEqual({
      routes: [],
      sockets: [],
      memberRoutes: [],
      agentTools: [],
      cli: [],
      app: [],
      ui: { screens: [], panels: [], settings: [], renderers: [], layouts: [], themes: [] },
      hooks: { takes: [], offers: [] },
      data: { publishes: [], subscribes: [] },
    });
  });

  test('the sections a fragment names are kept as given, in order', () => {
    const read = route('GET /v1/alpha', descriptor);
    const write = route('POST /v1/alpha', descriptor);
    const fragment = manifestFragment({
      routes: [read, write],
      ui: { screens: [screen('alpha', { path: 'alpha' })], panels: [panel('ferret.toolbar', { id: 'a', order: 1 })] },
    });
    expect(fragment.routes.map(entry => entry.key)).toEqual(['GET /v1/alpha', 'POST /v1/alpha']);
    expect(fragment.ui.screens.map(entry => entry.id)).toEqual(['alpha']);
    expect(fragment.ui.panels).toHaveLength(1);
    expect(fragment.ui.settings).toEqual([]);
    expect(fragment.cli).toEqual([]);
  });

  test('route keys keep their literal type, so a merged fragment types the halves as one literal did', () => {
    const fragment = manifestFragment({ routes: [route('GET /v1/alpha', descriptor)] });
    const key: 'GET /v1/alpha' = fragment.routes[0].key;
    expect(key).toBe('GET /v1/alpha');
    const noTools: readonly [] = fragment.agentTools;
    expect(noTools).toEqual([]);
  });

  test('a section name that is not one of the manifest sections is a type error, at every level', () => {
    // A misspelt section would otherwise compile and be dropped, type and runtime: the fragment would contribute nothing.
    const get = route('GET /a', descriptor);
    // @ts-expect-error `agentTool` is not a section (`agentTools` is), even though `routes` matches
    manifestFragment({ routes: [get], agentTool: [] });
    // @ts-expect-error `setting` is not a `ui` section (`settings` is), even though `panels` matches
    manifestFragment({ ui: { panels: [], setting: [] } });
    // @ts-expect-error `take` is not a `hooks` section (`takes` is), even though `offers` matches
    manifestFragment({ hooks: { offers: [], take: [] } });
    // @ts-expect-error `publish` is not a `data` section (`publishes` is), even though `subscribes` matches
    manifestFragment({ data: { subscribes: [], publish: [] } });
  });

  test('a fragment with every name right still compiles and keeps the literal of what it named', () => {
    const fragment = manifestFragment({
      routes: [route('GET /a', descriptor)],
      ui: { panels: [panel('ferret.toolbar', { id: 'a', order: 1 })] },
    });
    const key: 'GET /a' = fragment.routes[0].key;
    expect(key).toBe('GET /a');
    expect(fragment.ui.panels).toHaveLength(1);
  });
});
