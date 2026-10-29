import { describe, expect, it } from 'bun:test';
import {
  SPEEDUPS_PATH,
  type SpeedupsView,
  type WardenConfig,
  type WardenConfigPatch,
  type WardenConfigView,
} from '@ferretry/protocol';
import { useState } from 'react';
import type { ReactTestRenderer } from 'react-test-renderer';

import {
  jevKeyStatus,
  type WardenClientFactory,
  WardenConfigCard,
  WardenConfigSurface,
} from '../../../src/features/warden/warden-config-card.tsx';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { render, run, runAsync } from '../../support/react.ts';
import { wardenConfig, wardenFailover, wardenStatus } from '../../support/warden.ts';
import { configChangeHarness } from '../config-change-support.tsx';
import { runtimeCatalog, runtimeView } from '../picker-support.ts';

const connection = (id: string) =>
  daemonConnection({ daemonId: id, baseUrl: `https://${id}.example.test`, deviceId: `token-${id}` });

const view = (config: WardenConfig = wardenConfig(), warnings: string[] = []): WardenConfigView => ({
  config,
  accounts: config.accounts,
  warnings,
});

const speedups = (set: boolean, vault: SpeedupsView['vault'] = 'ok'): SpeedupsView => ({
  vault,
  providers: [
    {
      provider: 'jev',
      label: 'Jev',
      purpose: 'Triage.',
      costNote: 'Cheap.',
      privacyNote: 'A summary.',
      keyUrl: 'https://keys.example.test/',
      testNote: 'One decision.',
      secretName: 'JEV_API_KEY',
      set,
      testStale: false,
    },
  ],
});

const json = (renderer: ReactTestRenderer): string => JSON.stringify(renderer.toJSON());

const button = (renderer: ReactTestRenderer, label: string) => {
  const found = renderer.root.findAll(node => node.type === 'button' && node.children.join('') === label)[0];
  if (found === undefined) throw new Error(`no ${label} button`);
  return found;
};

const settle = async (): Promise<void> => {
  await runAsync(async () => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
  });
};

/** A config whose next state the test can drive by setting one field. */
const turnOff = (renderer: ReactTestRenderer): void => {
  run(() => renderer.root.findByProps({ 'aria-label': 'Warden on' }).props.onClick());
};

describe('jevKeyStatus', () => {
  it('should never call an unread or damaged store "missing"', () => {
    // Arrange + Act + Assert
    expect(jevKeyStatus(null)).toEqual({ state: 'unknown' });
    expect(jevKeyStatus({ vault: 'ok', providers: [] })).toEqual({ state: 'unknown' });
    expect(jevKeyStatus(speedups(false, 'damaged'))).toEqual({
      state: 'unknown',
      keyUrl: 'https://keys.example.test/',
    });
    expect(jevKeyStatus(speedups(true))).toEqual({ state: 'set', keyUrl: 'https://keys.example.test/' });
    expect(jevKeyStatus(speedups(false))).toEqual({ state: 'missing', keyUrl: 'https://keys.example.test/' });
  });
});

describe('WardenConfigCard', () => {
  function Harness({
    base,
    saves,
    saving,
    error,
    saved,
  }: {
    readonly base: WardenConfigView;
    readonly saves: WardenConfigPatch[];
    readonly saving?: boolean;
    readonly error?: string | null;
    readonly saved?: boolean;
  }) {
    const [draft, setDraft] = useState(base.config);
    return (
      <WardenConfigCard
        view={base}
        draft={draft}
        onChange={setDraft}
        jevKey={{ state: 'set' }}
        onSave={patch => saves.push(patch)}
        {...(saving === undefined ? {} : { saving })}
        {...(error === undefined ? {} : { error })}
        {...(saved === undefined ? {} : { saved })}
      />
    );
  }

  it('should save only what changed, and discard back to the daemon’s settings', () => {
    // Arrange
    const saves: WardenConfigPatch[] = [];
    const renderer = render(<Harness base={view()} saves={saves} />);
    expect(button(renderer, 'Save').props.disabled).toBe(true);
    expect(json(renderer)).not.toContain('Discard changes');

    // Act
    turnOff(renderer);
    run(() => button(renderer, 'Save').props.onClick());
    run(() => button(renderer, 'Discard changes').props.onClick());

    // Assert
    expect(saves).toEqual([{ enabled: false }]);
    expect(renderer.root.findByProps({ 'aria-label': 'Warden on' }).props['aria-checked']).toBe(true);
    expect(button(renderer, 'Save').props.disabled).toBe(true);
    run(() => renderer.unmount());
  });

  it('should refuse to save settings with an error in them', () => {
    // Arrange
    const renderer = render(
      <Harness base={view(wardenConfig({ layers: { jev: false, llm: true }, maxAssignedWardens: 9 }))} saves={[]} />,
    );

    // Act
    turnOff(renderer);

    // Assert
    expect(button(renderer, 'Save').props.disabled).toBe(true);
    run(() => renderer.unmount());
  });

  it('should show saving, the saved note, an error and the daemon’s warnings verbatim', () => {
    // Arrange + Act
    const saving = render(<Harness base={view()} saves={[]} saving />);
    turnOff(saving);
    const saved = render(<Harness base={view(wardenConfig(), ['Loosened: confirm on the host.'])} saves={[]} saved />);
    const failed = render(<Harness base={view()} saves={[]} saved error="save refused" />);

    // Assert
    expect(json(saving)).toContain('Saving…');
    expect(json(saving)).not.toContain('Discard changes');
    expect(json(saved)).toContain('Saved — in effect now.');
    expect(json(saved)).toContain('Loosened: confirm on the host.');
    expect(json(failed)).toContain('save refused');
    expect(json(failed)).not.toContain('Saved — in effect now.');
    for (const renderer of [saving, saved, failed]) run(() => renderer.unmount());
  });
});

type Client = Awaited<ReturnType<WardenClientFactory>>;

const client = (overrides: Partial<Client> = {}): Client => ({
  wardenConfig: async () => view(wardenConfig({ layers: { jev: false, llm: true } })),
  wardenStatus: async () =>
    wardenStatus({ failover: wardenFailover({ accounts: [{ agent: 'codex-default', eligible: true }] }) }),
  updateWardenConfig: async patch => view(wardenConfig({ ...patch } as Partial<WardenConfig>)),
  request: (async (path: string) => {
    if (path !== SPEEDUPS_PATH) throw new Error(`unexpected ${path}`);
    return speedups(false);
  }) as Client['request'],
  ...overrides,
});

describe('WardenConfigSurface', () => {
  it("should read the runtimes too, so the model field can list the chosen login's catalog", async () => {
    // Arrange — the daemon answers the runtime list as well as the speed-ups
    const runtimes = {
      format: 'version-2',
      runtimes: [],
    };
    const reading = client({
      request: (async (path: string) => {
        if (path === SPEEDUPS_PATH) return speedups(false);
        if (path === '/v1/fleet/runtimes') return runtimes;
        throw new Error(`unexpected ${path}`);
      }) as Client['request'],
    });

    // Act
    const renderer = render(<WardenConfigSurface connection={connection('a')} createClient={async () => reading} />);
    await settle();

    // Assert — it still renders the settings with an empty runtime list
    expect(json(renderer)).toContain('codex-default');
    run(() => renderer.unmount());
  });

  it('should load the settings, the key status and the logins the daemon knows', async () => {
    // Arrange + Act
    const renderer = render(<WardenConfigSurface connection={connection('a')} createClient={async () => client()} />);
    await settle();

    // Assert
    expect(json(renderer)).toContain('codex-default');
    const link = renderer.root.findAll(node => node.type === 'a' && node.props.href === '/d/a/settings#speedups');
    expect(link).toHaveLength(0);
    run(() => renderer.root.findByProps({ 'aria-label': 'Warden on' }).props.onClick());
    run(() => renderer.unmount());
  });

  it('should link the missing Jev key to Speed-ups through the router', async () => {
    // Arrange
    const navigated: string[] = [];
    const renderer = render(
      <WardenConfigSurface
        connection={connection('a')}
        createClient={async () =>
          client({ wardenConfig: async () => view(wardenConfig({ layers: { jev: true, llm: true } })) })
        }
        onNavigate={to => navigated.push(to)}
      />,
    );
    await settle();

    // Act
    const link = renderer.root.find(node => node.type === 'a' && String(node.props.href).endsWith('#speedups'));
    run(() => link.props.onClick({ button: 0, preventDefault: () => {} }));

    // Assert
    expect(json(renderer)).toContain('needs Jev key');
    expect(navigated).toEqual([link.props.href]);
    run(() => renderer.unmount());
  });

  it('should call the key unknown and offer no logins when those reads fail', async () => {
    // Arrange + Act
    const renderer = render(
      <WardenConfigSurface
        connection={connection('a')}
        createClient={async () =>
          client({
            wardenConfig: async () => view(wardenConfig({ layers: { jev: true, llm: true } })),
            wardenStatus: async () => Promise.reject(new Error('no status')),
            request: (async () => Promise.reject(new Error('no speedups'))) as Client['request'],
          })
        }
      />,
    );
    await settle();

    // Assert
    expect(json(renderer)).toContain('key status unknown');
    expect(json(renderer)).not.toContain('codex-default');
    run(() => renderer.unmount());
  });

  it('should hide an unreadable daemon by default and say so in Settings', async () => {
    // Arrange
    const failing: WardenClientFactory = async () => Promise.reject(new Error('older daemon'));

    // Act
    const hidden = render(<WardenConfigSurface connection={connection('a')} createClient={failing} />);
    const message = render(
      <WardenConfigSurface connection={connection('a')} createClient={failing} unavailable="message" />,
    );
    await settle();

    // Assert
    expect(hidden.toJSON()).toBeNull();
    expect(json(message)).toContain('Warden settings unavailable');
    for (const renderer of [hidden, message]) run(() => renderer.unmount());
  });

  it("should drop a late answer instead of showing another daemon's settings", async () => {
    // Arrange
    let releaseA: ((value: WardenConfigView) => void) | undefined;
    const lateA = new Promise<WardenConfigView>(resolve => {
      releaseA = resolve;
    });
    const createClient: WardenClientFactory = async active =>
      active.daemonId === 'a'
        ? client({ wardenConfig: () => lateA })
        : client({
            wardenConfig: async () =>
              view(wardenConfig({ layers: { jev: false, llm: true }, accounts: [{ agent: 'claude-auto-beta' }] })),
          });
    const renderer = render(<WardenConfigSurface connection={connection('a')} createClient={createClient} />);

    // Act
    run(() => renderer.update(<WardenConfigSurface connection={connection('b')} createClient={createClient} />));
    await settle();
    await runAsync(async () => {
      releaseA?.(view(wardenConfig({ layers: { jev: false, llm: true }, accounts: [{ agent: 'claude-auto-alpha' }] })));
      await Promise.resolve();
    });
    await settle();

    // Assert
    expect(json(renderer)).toContain('claude-auto-beta');
    expect(json(renderer)).not.toContain('claude-auto-alpha');
    run(() => renderer.unmount());
  });

  it('should save the change, then edit from the daemon’s answer', async () => {
    // Arrange
    const patches: WardenConfigPatch[] = [];
    const renderer = render(
      <WardenConfigSurface
        connection={connection('a')}
        createClient={async () =>
          client({
            updateWardenConfig: async patch => {
              patches.push(patch);
              return view(wardenConfig({ enabled: false }), ['Noted.']);
            },
          })
        }
      />,
    );
    await settle();

    // Act
    turnOff(renderer);
    await runAsync(async () => {
      button(renderer, 'Save').props.onClick();
      await Promise.resolve();
    });
    await settle();

    // Assert
    expect(patches).toEqual([{ enabled: false }]);
    expect(json(renderer)).toContain('Saved — in effect now.');
    expect(json(renderer)).toContain('Noted.');
    expect(button(renderer, 'Save').props.disabled).toBe(true);
    run(() => renderer.unmount());
  });

  it('should show a refused save and keep the draft', async () => {
    // Arrange
    const renderer = render(
      <WardenConfigSurface
        connection={connection('a')}
        createClient={async () => client({ updateWardenConfig: async () => Promise.reject('save refused') })}
      />,
    );
    await settle();

    // Act
    turnOff(renderer);
    await runAsync(async () => {
      button(renderer, 'Save').props.onClick();
      await Promise.resolve();
    });
    await settle();

    // Assert
    expect(json(renderer)).toContain('save refused');
    expect(renderer.root.findByProps({ 'aria-label': 'Warden on' }).props['aria-checked']).toBe(false);
    run(() => renderer.unmount());
  });

  it('should keep a save that lands after a daemon switch away from the new daemon', async () => {
    // Arrange
    let finish: ((value: WardenConfigView) => void) | undefined;
    const createClient: WardenClientFactory = async active =>
      active.daemonId === 'a'
        ? client({
            updateWardenConfig: () =>
              new Promise<WardenConfigView>(resolve => {
                finish = resolve;
              }),
          })
        : client({
            wardenConfig: async () =>
              view(wardenConfig({ layers: { jev: false, llm: true }, accounts: [{ agent: 'claude-auto-beta' }] })),
          });
    const renderer = render(<WardenConfigSurface connection={connection('a')} createClient={createClient} />);
    await settle();
    turnOff(renderer);
    run(() => button(renderer, 'Save').props.onClick());

    // Act
    run(() => renderer.update(<WardenConfigSurface connection={connection('b')} createClient={createClient} />));
    await settle();
    await runAsync(async () => {
      finish?.(view(wardenConfig({ layers: { jev: false, llm: true }, accounts: [{ agent: 'claude-auto-alpha' }] })));
      await Promise.resolve();
    });
    await settle();

    // Assert
    expect(json(renderer)).toContain('claude-auto-beta');
    expect(json(renderer)).not.toContain('claude-auto-alpha');
    expect(json(renderer)).not.toContain('Saved — in effect now.');
    run(() => renderer.unmount());
  });

  it('should not show a refusal from the daemon the reader left', async () => {
    // Arrange
    let refuse: ((reason: Error) => void) | undefined;
    const createClient: WardenClientFactory = async active =>
      active.daemonId === 'a'
        ? client({
            updateWardenConfig: () =>
              new Promise<WardenConfigView>((_, reject) => {
                refuse = reject;
              }),
          })
        : client();
    const renderer = render(<WardenConfigSurface connection={connection('a')} createClient={createClient} />);
    await settle();
    turnOff(renderer);
    run(() => button(renderer, 'Save').props.onClick());

    // Act
    run(() => renderer.update(<WardenConfigSurface connection={connection('b')} createClient={createClient} />));
    await settle();
    await runAsync(async () => {
      refuse?.(new Error('daemon a refused'));
      await Promise.resolve();
    });
    await settle();

    // Assert
    expect(json(renderer)).not.toContain('daemon a refused');
    run(() => renderer.unmount());
  });

  describe('when the machine says its configuration moved', () => {
    const switchOf = (renderer: ReactTestRenderer) => renderer.root.findByProps({ 'aria-label': 'Warden on' });

    /** A daemon whose Warden settings and Jev key a test changes between reads, counting the reads. */
    const changing = (first: WardenConfigView) => {
      const state = { view: first, keyed: false, reads: 0, failNext: false };
      const make = (): Client =>
        client({
          wardenConfig: async () => {
            state.reads += 1;
            if (state.reads > 1 && state.failNext) throw new Error('unreachable');
            return state.view;
          },
          request: (async () => speedups(state.keyed)) as Client['request'],
        });
      return { state, make };
    };

    it('should follow another device’s change, and a Jev key added in Speed-ups, when the draft is untouched', async () => {
      // Arrange
      const daemon = changing(view(wardenConfig({ enabled: true, layers: { jev: true, llm: true } })));
      const harness = configChangeHarness(connection('a').daemonId);
      const renderer = render(
        harness.wrap(<WardenConfigSurface connection={connection('a')} createClient={async () => daemon.make()} />),
      );
      await settle();
      expect(switchOf(renderer).props['aria-checked']).toBe(true);
      expect(json(renderer)).toContain('needs Jev key');

      // Act
      daemon.state.view = view(wardenConfig({ enabled: false, layers: { jev: true, llm: true } }), [
        'Edited on the host.',
      ]);
      daemon.state.keyed = true;
      await harness.move(['speedups']);
      await settle();

      // Assert
      expect(daemon.state.reads).toBe(2);
      expect(switchOf(renderer).props['aria-checked']).toBe(false);
      expect(json(renderer)).toContain('Edited on the host.');
      expect(json(renderer)).not.toContain('needs Jev key');
      expect(json(renderer)).not.toContain('Discard changes');
      run(() => renderer.unmount());
    });

    it('should read again for a Warden move too, and keep an edit the reader has not saved', async () => {
      // Arrange
      const daemon = changing(view(wardenConfig({ enabled: true })));
      const harness = configChangeHarness(connection('a').daemonId);
      const renderer = render(
        harness.wrap(<WardenConfigSurface connection={connection('a')} createClient={async () => daemon.make()} />),
      );
      await settle();
      turnOff(renderer);

      // Act
      daemon.state.view = view(wardenConfig({ enabled: true, layers: { jev: false, llm: true } }), [
        'Loosened elsewhere.',
      ]);
      await harness.move(['warden']);
      await settle();

      // Assert
      expect(daemon.state.reads).toBe(2);
      expect(json(renderer)).toContain('Loosened elsewhere.');
      expect(switchOf(renderer).props['aria-checked']).toBe(false);
      expect(button(renderer, 'Save').props.disabled).toBe(false);
      run(() => button(renderer, 'Discard changes').props.onClick());
      expect(switchOf(renderer).props['aria-checked']).toBe(true);
      run(() => renderer.unmount());
    });

    it('should keep what is on screen when the read after a move fails', async () => {
      // Arrange
      const daemon = changing(view(wardenConfig({ enabled: true })));
      const harness = configChangeHarness(connection('a').daemonId);
      const renderer = render(
        harness.wrap(<WardenConfigSurface connection={connection('a')} createClient={async () => daemon.make()} />),
      );
      await settle();
      daemon.state.failNext = true;

      // Act
      await harness.move(['warden']);
      await settle();

      // Assert
      expect(daemon.state.reads).toBe(2);
      expect(switchOf(renderer).props['aria-checked']).toBe(true);
      expect(json(renderer)).not.toContain('Warden settings unavailable');
      run(() => renderer.unmount());
    });

    it('should pick up a runtime made while the page is open: its login, no longer "not set"', async () => {
      // Arrange: a machine with no runtime, so no login is set.
      const notSet: WardenConfigView = {
        config: wardenConfig({ layers: { jev: false, llm: true }, accounts: [] }),
        accounts: [],
        warnings: [],
        login: { source: 'not_set', unknown: [], available: [] },
      };
      const daemon = changing(notSet);
      const harness = configChangeHarness(connection('a').daemonId);
      const renderer = render(
        harness.wrap(<WardenConfigSurface connection={connection('a')} createClient={async () => daemon.make()} />),
      );
      await settle();
      expect(json(renderer)).toContain('Not set — choose a login');

      // Act: a runtime is created elsewhere and becomes the machine default.
      daemon.state.view = {
        ...notSet,
        accounts: [{ agent: 'first' }],
        login: { source: 'machine_default', unknown: [], available: ['first'] },
      };
      await harness.move(['runtimes']);
      await settle();

      // Assert
      expect(json(renderer)).toContain('Machine default — first');
      expect(json(renderer)).not.toContain('Not set — choose a login');
      run(() => renderer.unmount());
    });

    it('should relabel the logins from the runtimes the machine now reports after a runtimes move', async () => {
      // Arrange: the first read sees no runtime, so a login is named by its wrapper alone.
      const state = { runtimes: runtimeCatalog() };
      const make = (): Client =>
        client({
          request: (async (path: string) => {
            if (path === SPEEDUPS_PATH) return speedups(false);
            if (path === '/v1/fleet/runtimes') return state.runtimes;
            throw new Error(`unexpected ${path}`);
          }) as Client['request'],
        });
      const harness = configChangeHarness(connection('a').daemonId);
      const renderer = render(
        harness.wrap(<WardenConfigSurface connection={connection('a')} createClient={async () => make()} />),
      );
      await settle();
      expect(json(renderer)).not.toContain('Claude main');

      // Act: a runtime for that login is added elsewhere.
      state.runtimes = runtimeCatalog(runtimeView({ wrapper: 'claude-default', name: 'Claude main' }));
      await harness.move(['runtimes']);
      await settle();

      // Assert
      expect(json(renderer)).toContain('Claude main');
      run(() => renderer.unmount());
    });

    it('should not read for a kind the card does not show', async () => {
      // Arrange
      const daemon = changing(view());
      const harness = configChangeHarness(connection('a').daemonId);
      const renderer = render(
        harness.wrap(<WardenConfigSurface connection={connection('a')} createClient={async () => daemon.make()} />),
      );
      await settle();

      // Act
      await harness.move(['voice']);
      await settle();

      // Assert
      expect(daemon.state.reads).toBe(1);
      run(() => renderer.unmount());
    });

    it('should read nothing for a move that lands before the first read has answered', async () => {
      // Arrange
      let answer: ((value: WardenConfigView) => void) | undefined;
      let reads = 0;
      const harness = configChangeHarness(connection('a').daemonId);
      const renderer = render(
        harness.wrap(
          <WardenConfigSurface
            connection={connection('a')}
            createClient={async () =>
              client({
                wardenConfig: () => {
                  reads += 1;
                  return new Promise<WardenConfigView>(resolve => {
                    answer = resolve;
                  });
                },
              })
            }
          />,
        ),
      );
      await settle();

      // Act
      await harness.move(['warden']);
      await settle();
      await runAsync(async () => {
        answer?.(view(wardenConfig({ layers: { jev: false, llm: true }, accounts: [{ agent: 'claude-auto-late' }] })));
        await Promise.resolve();
      });
      await settle();

      // Assert
      expect(reads).toBe(1);
      expect(json(renderer)).toContain('claude-auto-late');
      run(() => renderer.unmount());
    });

    it('should not read the daemon the reader left when the new one is already moved', async () => {
      // Arrange
      const a = changing(
        view(wardenConfig({ layers: { jev: false, llm: true }, accounts: [{ agent: 'claude-auto-alpha' }] })),
      );
      const harness = configChangeHarness(connection('a').daemonId);
      harness.configChanges.observe(connection('b').daemonId, {
        kind: 'config',
        epoch: 'boot',
        revision: 0,
        kinds: [],
      });
      harness.configChanges.observe(connection('b').daemonId, {
        kind: 'config',
        epoch: 'boot',
        revision: 1,
        kinds: ['warden'],
      });
      const createClient: WardenClientFactory = async active =>
        active.daemonId === 'a'
          ? a.make()
          : client({
              wardenConfig: async () =>
                view(wardenConfig({ layers: { jev: false, llm: true }, accounts: [{ agent: 'claude-auto-beta' }] })),
            });
      const renderer = render(
        harness.wrap(<WardenConfigSurface connection={connection('a')} createClient={createClient} />),
      );
      await settle();

      // Act
      run(() =>
        renderer.update(harness.wrap(<WardenConfigSurface connection={connection('b')} createClient={createClient} />)),
      );
      await settle();

      // Assert
      expect(a.state.reads).toBe(1);
      expect(json(renderer)).toContain('claude-auto-beta');
      expect(json(renderer)).not.toContain('claude-auto-alpha');
      run(() => renderer.unmount());
    });

    it('should drop a re-read answered after the reader switched daemon, loaded or not', async () => {
      // Arrange
      let late: ((value: WardenConfigView) => void) | undefined;
      let readsOfA = 0;
      let releaseB: ((value: WardenConfigView) => void) | undefined;
      const beta = view(wardenConfig({ layers: { jev: false, llm: true }, accounts: [{ agent: 'claude-auto-beta' }] }));
      const harness = configChangeHarness(connection('a').daemonId);
      const createClient: WardenClientFactory = async active =>
        active.daemonId === 'a'
          ? client({
              wardenConfig: () => {
                readsOfA += 1;
                return readsOfA === 1
                  ? Promise.resolve(
                      view(
                        wardenConfig({ layers: { jev: false, llm: true }, accounts: [{ agent: 'claude-auto-alpha' }] }),
                      ),
                    )
                  : new Promise<WardenConfigView>(resolve => {
                      late = resolve;
                    });
              },
            })
          : client({
              wardenConfig: () =>
                new Promise<WardenConfigView>(resolve => {
                  releaseB = resolve;
                }),
            });
      const renderer = render(
        harness.wrap(<WardenConfigSurface connection={connection('a')} createClient={createClient} />),
      );
      await settle();
      await harness.move(['warden']);
      await settle();
      expect(readsOfA).toBe(2);

      // Act
      run(() =>
        renderer.update(harness.wrap(<WardenConfigSurface connection={connection('b')} createClient={createClient} />)),
      );
      await settle();
      await runAsync(async () => {
        late?.(view(wardenConfig({ layers: { jev: false, llm: true }, accounts: [{ agent: 'claude-auto-stale' }] })));
        await Promise.resolve();
      });
      await settle();
      const whileLoading = json(renderer);
      await runAsync(async () => {
        releaseB?.(beta);
        await Promise.resolve();
      });
      await settle();

      // Assert
      expect(whileLoading).not.toContain('claude-auto-stale');
      expect(json(renderer)).toContain('claude-auto-beta');
      expect(json(renderer)).not.toContain('claude-auto-stale');
      run(() => renderer.unmount());
    });
  });
});

describe('the investigation login the daemon resolved', () => {
  it('should offer every login the machine has, and say the order runs on the machine default', async () => {
    // Arrange
    const resolved: WardenConfigView = {
      config: wardenConfig({ layers: { jev: false, llm: true }, accounts: [] }),
      accounts: [{ agent: 'claude-default' }],
      warnings: [],
      login: { source: 'machine_default', unknown: [], available: ['claude-default', 'claude-spare'] },
    };

    // Act
    const renderer = render(
      <WardenConfigSurface
        connection={connection('a')}
        createClient={async () => client({ wardenConfig: async () => resolved })}
      />,
    );
    await settle();

    // Assert
    expect(json(renderer)).toContain('Machine default — claude-default');
    expect(json(renderer)).toContain('claude-spare');
    expect(json(renderer)).not.toContain('codex-default');
    run(() => renderer.unmount());
  });

  it('should name an unknown login and leave it chosen until the owner picks another', () => {
    // Arrange
    const legacy: WardenConfigView = {
      config: wardenConfig({ layers: { jev: false, llm: true }, accounts: [{ agent: 'legacy-wrapper' }] }),
      accounts: [{ agent: 'legacy-wrapper' }],
      warnings: [],
      login: { source: 'configured', unknown: ['legacy-wrapper'], available: ['claude-default'] },
    };

    // Act
    const renderer = render(
      <WardenConfigCard
        view={legacy}
        draft={legacy.config}
        onChange={() => {}}
        jevKey={{ state: 'set' }}
        onSave={() => {}}
      />,
    );

    // Assert
    expect(json(renderer)).toContain('Unknown login ‘');
    expect(json(renderer)).toContain('legacy-wrapper');
    run(() => renderer.unmount());
  });
});
