/** input 197: Add skills knows the ferret's runtime, read from Runtimes' catalog on the machine the page is under. */
import { describe, expect, it } from 'bun:test';
import { ScreenHrefProvider } from '@ferretry/app';
import { interact, mount, noteClientDaemon, RouterProvider, settleUntil } from '@ferretry/app/testing';
import { RuntimeCatalogSchema, type RuntimeView } from '@ferretry/plugin-runtimes/contract';
import { type FunctionComponent } from 'react';
import { accountSentence, PICK_A_PLACE } from '../../../../app/features/add-skills/add-skills-model.ts';
import { readRuntimeChoices, useRuntimeChoices } from '../../../../app/lib/runtime-choices.ts';
import { createAddSkillsScreen } from '../../../../app/views/add-skills-views.tsx';

/** One runtime as `GET /v1/runtimes` publishes it, to the wire schema so a contract change fails here. */
const runtime = (wrapper: string, profile = 'Default'): RuntimeView => ({
  id: `rt-${wrapper}`,
  name: wrapper,
  wrapper,
  harness: 'claude-code',
  credential: { id: `login-${wrapper}`, store: 'host', status: 'ready' },
  profile,
  agent: true,
  stack: {
    harness: 'claude-code',
    available: { available: true },
    applied: [],
    skipped: [],
    conflicts: [],
    partial: [],
  },
  modelSet: { source: 'harness-default' },
  launch: { available: true },
  sameAs: [],
});

const catalog = (...runtimes: RuntimeView[]) => RuntimeCatalogSchema.parse({ format: 'present', runtimes });

const answering = (answer: () => unknown) => ({
  call: (async (route: string) => {
    expect(route).toBe('GET /v1/runtimes');
    return answer();
  }) as never,
});

describe('readRuntimeChoices', () => {
  it('names each runtime by the id and profile an install takes and the wrapper a ferret is known by', async () => {
    expect(await readRuntimeChoices(answering(() => catalog(runtime('box', 'Work'), runtime('desk'))))).toEqual([
      { id: 'rt-box', wrapper: 'box', profile: 'Work' },
      { id: 'rt-desk', wrapper: 'desk', profile: 'Default' },
    ]);
  });

  it('refuses an answer that is not Runtimes’ catalog', async () => {
    await expect(readRuntimeChoices(answering(() => ({})))).rejects.toThrow();
  });
});

function Probe({ client }: { readonly client: ReturnType<typeof answering> }) {
  return (
    <p data-probe="">
      {useRuntimeChoices(client)
        .map(choice => choice.wrapper)
        .join(',') || 'none'}
    </p>
  );
}

describe('useRuntimeChoices', () => {
  it('offers the runtimes once read, and none while Runtimes cannot answer', async () => {
    const read = await mount(<Probe client={answering(() => catalog(runtime('box')))} />);
    await settleUntil(() => document.querySelector('[data-probe]')?.textContent === 'box', 'the runtimes', interact);
    await read.unmount();
    const refused = await mount(
      <Probe
        client={answering(() => {
          throw new Error('Runtimes is off');
        })}
      />,
    );
    await interact(async () => {
      for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    });
    expect(document.querySelector('[data-probe]')?.textContent).toBe('none');
    await refused.unmount();
  });
});

describe('the Add skills screen reads the ferret’s runtime', () => {
  const scopeLine = async (answer: () => unknown): Promise<string | null | undefined> => {
    const client = {
      call: async (route: string) => (route === 'GET /v1/runtimes' ? answer() : {}),
      request: async () => ({ installs: [] }),
    } as never;
    noteClientDaemon(client, 'alpha');
    const Screen = createAddSkillsScreen(
      client,
      // A ferret in no registered folder, on the runtime `box`.
      () => '?folder=%2Fnowhere&runtime=box',
      () => ({ list: async () => [], browse: async () => ({ kind: 'refused' }) }) as never,
    ) as unknown as FunctionComponent<{ params: Record<string, string> }>;
    const view = await mount(
      <RouterProvider>
        <ScreenHrefProvider href={(daemon, plugin, screen) => `/d/${daemon}/${plugin}/${screen}`}>
          <Screen params={{ ferret: 'f1' }} />
        </ScreenHrefProvider>
      </RouterProvider>,
    );
    await settleUntil(() => document.querySelector('[data-add-skills-scope]') !== null, 'the page', interact);
    // Let the runtimes read land before the line is read.
    await interact(async () => {
      for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    });
    const text = document.querySelector('[data-add-skills-scope]')?.textContent;
    await view.unmount();
    return text;
  };

  it('installs into this account when the machine names the ferret’s runtime', async () => {
    expect(await scopeLine(() => catalog(runtime('box')))).toBe(
      `Installs into ${accountSentence('box')}. You can pick another place when you install.`,
    );
  });

  it('asks where in the install sheet when the machine names no such runtime', async () => {
    expect(await scopeLine(() => catalog(runtime('desk')))).toBe(PICK_A_PLACE);
    expect(
      await scopeLine(() => {
        throw new Error('Runtimes is off');
      }),
    ).toBe(PICK_A_PLACE);
  });
});
