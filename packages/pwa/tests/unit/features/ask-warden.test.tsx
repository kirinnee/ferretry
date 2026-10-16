import { afterEach, describe, expect, it } from 'bun:test';
import {
  type CapabilityGrantView,
  DAEMON_CAPABILITIES,
  type GrantRefusal,
  type GrantsView,
  type WardenInvestigateRequest,
  type WardenInvestigateView,
  type WardenStatusView,
} from '@ferretry/protocol';
import { ACTION_TOAST_MS, ActionToast } from '../../../src/features/session-actions/action-toast.tsx';
import type { CoreActionContext } from '../../../src/features/session-actions/core-actions.ts';
import type { SessionActionFormHost } from '../../../src/features/session-actions/registry.ts';
import {
  ASK_WARDEN_ACTION_ID,
  AskWardenForm,
  type AskWardenClientFactory,
  type AskWardenPorts,
  askWardenContribution,
  useAskWardenActions,
} from '../../../src/features/warden/ask-warden.tsx';
import { type DaemonConnection, daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { DaemonClientProvider } from '../../../src/lib/store.tsx';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';
import { sessionView } from '../../support/sessions.ts';
import { wardenConfig, wardenStatus } from '../../support/warden.ts';

const ALPHA = `fy_daemon_${'a'.repeat(43)}`;
const BETA = `fy_daemon_${'b'.repeat(43)}`;
const connection = (id: string): DaemonConnection =>
  daemonConnection({ daemonId: id, baseUrl: 'https://workstation.example.test', deviceId: `token-${id}` });

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 6; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
};

const entry = (capability: CapabilityGrantView['capability'], useRefusal: GrantRefusal): CapabilityGrantView => ({
  capability,
  use: useRefusal === 'granted',
  configure: false,
  granted: { use: useRefusal !== 'not-granted', configure: false },
  mayGrant: false,
  useRefusal,
  configureRefusal: 'not-granted',
  origin: 'default',
});
const grants = (warden: GrantRefusal): GrantsView => ({
  capabilities: DAEMON_CAPABILITIES.map(capability => entry(capability, capability === 'warden' ? warden : 'granted')),
  governed: true,
  hostLocal: false,
  steppedUp: false,
});

interface Recorder {
  readonly closes: number[];
  readonly notices: string[];
  readonly requests: WardenInvestigateRequest[];
}

const hostFor = (recorder: Recorder): SessionActionFormHost => ({
  close: () => recorder.closes.push(1),
  open: () => undefined,
  notify: sentence => recorder.notices.push(sentence),
  compact: false,
});

const portsFor = (
  recorder: Recorder,
  status: () => Promise<WardenStatusView>,
  answer: () => Promise<WardenInvestigateView> = async () => ({
    sessionId: 'sess-1',
    state: 'queued',
    position: 1,
    message: 'Queued: 1 ahead.',
  }),
): AskWardenPorts => ({
  status,
  investigate: async request => {
    recorder.requests.push(request);
    return await answer();
  },
});

const recorder = (): Recorder => ({ closes: [], notices: [], requests: [] });

const openForm = async (ports: AskWardenPorts, rec: Recorder): Promise<HTMLElement> => {
  view = await mount(<AskWardenForm host={hostFor(rec)} name="hadi" ports={ports} sessionId="sess-1" />);
  await settle();
  return view.container;
};

const estimate = (root: HTMLElement): string =>
  must(root.querySelector('[data-ask-warden-estimate]'), 'estimate').textContent ?? '';
const submitButton = (root: HTMLElement): HTMLButtonElement =>
  must(root.querySelector<HTMLButtonElement>('[data-action-submit]'), 'submit');
const submit = async (root: HTMLElement): Promise<void> => {
  await interact(() => must(root.querySelector('form'), 'form').requestSubmit());
  await settle();
};
const setValue = async (element: HTMLSelectElement | HTMLTextAreaElement, value: string): Promise<void> => {
  await interact(() => {
    const proto = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
};

describe('AskWardenForm', () => {
  it('says it is reading, then shows who investigates and the cost line from the status', async () => {
    const rec = recorder();
    let release: (status: WardenStatusView) => void = () => undefined;
    const pending = new Promise<WardenStatusView>(resolve => {
      release = resolve;
    });
    view = await mount(
      <AskWardenForm host={hostFor(rec)} name="hadi" ports={portsFor(rec, () => pending)} sessionId="sess-1" />,
    );
    expect(estimate(view.container)).toBe('Reading the Warden’s status…');
    const status = wardenStatus({ config: wardenConfig({ accounts: [{ agent: 'claude-default', model: 'opus' }] }) });
    await interact(() => release({ ...status, savings: { ...status.savings, averageInvestigationUsd: 0.3 } }));
    await settle();
    expect(estimate(view.container)).toContain('A read-only assigned warden on claude-default with opus');
    expect(estimate(view.container)).toContain('About $0.30, counted against today’s $2.00 investigation cap');
    expect(submitButton(view.container).disabled).toBe(false);
  });

  it('sends the chosen focus and notes as the note, closes, and toasts where the report lands', async () => {
    const rec = recorder();
    const root = await openForm(
      portsFor(rec, async () => wardenStatus()),
      rec,
    );
    await setValue(must(root.querySelector('select'), 'focus'), 'failures');
    await setValue(must(root.querySelector('textarea'), 'notes'), 'CI went red');
    await submit(root);
    expect(rec.requests).toEqual([{ sessionId: 'sess-1', note: 'Focus: the recent failures. CI went red' }]);
    expect(rec.closes).toEqual([1]);
    expect(rec.notices).toEqual(['Investigation of hadi queued — the report lands in Info › Signals.']);
  });

  it('says "started" when the daemon runs it at once', async () => {
    const rec = recorder();
    const root = await openForm(
      portsFor(
        rec,
        async () => wardenStatus(),
        async () => ({ sessionId: 'sess-1', state: 'running', wardenSession: 'w-1', message: 'Running.' }),
      ),
      rec,
    );
    await submit(root);
    expect(rec.requests).toEqual([{ sessionId: 'sess-1', note: 'Focus: why it seems stuck.' }]);
    expect(rec.notices).toEqual(['Investigation of hadi started — the report lands in Info › Signals.']);
  });

  it('keeps the form open with the daemon’s refusal in its own words', async () => {
    const rec = recorder();
    const root = await openForm(
      portsFor(
        rec,
        async () => wardenStatus(),
        async () => {
          throw new Error('hadi is already being investigated');
        },
      ),
      rec,
    );
    await submit(root);
    expect(rec.closes).toEqual([]);
    expect(rec.notices).toEqual([]);
    expect(must(root.querySelector('.fy-action-form__failure'), 'failure').textContent).toBe(
      'No investigation: hadi is already being investigated',
    );
  });

  it('sends once however often it is submitted while a request is in flight', async () => {
    const rec = recorder();
    let release: () => void = () => undefined;
    const root = await openForm(
      portsFor(
        rec,
        async () => wardenStatus(),
        () =>
          new Promise<WardenInvestigateView>(resolve => {
            release = () => resolve({ sessionId: 'sess-1', state: 'queued', message: 'Queued.' });
          }),
      ),
      rec,
    );
    await interact(() => {
      const form = must(root.querySelector('form'), 'form');
      form.requestSubmit();
      form.requestSubmit();
    });
    expect(rec.requests.length).toBe(1);
    await interact(() => release());
    await settle();
    expect(rec.notices.length).toBe(1);
  });

  it('refuses up front, with the remedy, when the status says the Warden is off', async () => {
    const rec = recorder();
    const root = await openForm(
      portsFor(rec, async () => wardenStatus({ config: wardenConfig({ enabled: false }) })),
      rec,
    );
    expect(must(root.querySelector('.fy-action-form__failure'), 'blocker').textContent).toBe(
      'The Warden is off. Turn it on in Settings › Warden.',
    );
    expect(submitButton(root).disabled).toBe(true);
    await submit(root);
    expect(rec.requests).toEqual([]);
  });

  it('still lets the owner ask when the status cannot be read, and says the daemon checks the cap', async () => {
    const rec = recorder();
    const root = await openForm(
      portsFor(rec, async () => {
        throw new Error('403 warden.use is not granted');
      }),
      rec,
    );
    expect(estimate(root)).toBe(
      'Couldn’t read the Warden’s status: 403 warden.use is not granted. The daemon still checks the cap when you ask.',
    );
    expect(submitButton(root).disabled).toBe(false);
  });

  it('drops a status that arrives after the form closed', async () => {
    const rec = recorder();
    let release: () => void = () => undefined;
    let fail: () => void = () => undefined;
    const late = new Promise<WardenStatusView>((resolve, reject) => {
      release = () => resolve(wardenStatus());
      fail = () => reject(new Error('late'));
    });
    view = await mount(
      <AskWardenForm host={hostFor(rec)} name="hadi" ports={portsFor(rec, () => late)} sessionId="sess-1" />,
    );
    await view.unmount();
    view = null;
    release();
    fail();
    await settle();
    expect(rec.requests).toEqual([]);
  });

  it('drops a failed status read that arrives after the form closed', async () => {
    const rec = recorder();
    let fail: () => void = () => undefined;
    const late = new Promise<WardenStatusView>((_, reject) => {
      fail = () => reject(new Error('late'));
    });
    view = await mount(
      <AskWardenForm host={hostFor(rec)} name="hadi" ports={portsFor(rec, () => late)} sessionId="sess-1" />,
    );
    await view.unmount();
    view = null;
    fail();
    await settle();
    expect(rec.requests).toEqual([]);
  });
});

const context = (canControl: boolean): CoreActionContext => ({
  view: sessionView('sess-1'),
  name: 'hadi',
  canControl,
  copyId: () => undefined,
  openMigrate: () => undefined,
  restart: async () => undefined,
  stop: async () => undefined,
  resume: async () => undefined,
  renderRename: () => null,
  renderFork: () => null,
});

describe('askWardenContribution', () => {
  it('is a form row in the Warden group for a caller who may control the ferret', async () => {
    const rec = recorder();
    const contribution = askWardenContribution(portsFor(rec, async () => wardenStatus()));
    expect(contribution.group).toBe('warden');
    const entry = must(contribution.build(context(true)), 'entry');
    expect(entry.id).toBe(ASK_WARDEN_ACTION_ID);
    expect(entry.label).toBe('Ask the Warden to investigate now…');
    if (entry.kind !== 'form') throw new Error('expected a form');
    expect(entry.title).toBe('Ask the Warden to investigate hadi');
    view = await mount(<>{entry.render(hostFor(rec))}</>);
    await settle();
    await submit(view.container);
    expect(rec.requests[0]?.sessionId).toBe('sess-1');
  });

  it('is hidden from a read-only connection', () => {
    const contribution = askWardenContribution(portsFor(recorder(), async () => wardenStatus()));
    expect(contribution.build(context(false))).toBeNull();
  });
});

function ActionsProbe({
  target,
  createClient,
}: {
  readonly target: DaemonConnection;
  readonly createClient?: AskWardenClientFactory;
}) {
  const actions = useAskWardenActions(target, createClient);
  const entry = actions[0]?.build(context(true));
  return (
    <div>
      <p data-count="">{String(actions.length)}</p>
      {entry?.kind === 'form' ? entry.render(hostFor(probeRecorder)) : null}
    </div>
  );
}
let probeRecorder = recorder();
const count = (): string | null | undefined => view?.container.querySelector('[data-count]')?.textContent;

describe('useAskWardenActions', () => {
  it('offers the row only where the machine’s grants open the Warden, keyed by machine', async () => {
    probeRecorder = recorder();
    const asked: string[] = [];
    const answers: Record<string, GrantsView> = { [ALPHA]: grants('granted'), [BETA]: grants('not-granted') };
    const calls: string[] = [];
    const factory: AskWardenClientFactory = async target => {
      asked.push(`${target.daemonId}`);
      return {
        request: (async (path: string) => {
          expect(path).toBe('/v1/grants');
          return answers[`${target.daemonId}`];
        }) as never,
        wardenStatus: async () => {
          calls.push(`status:${target.daemonId}`);
          return wardenStatus();
        },
        wardenInvestigate: async request => {
          calls.push(`investigate:${target.daemonId}:${request.sessionId}`);
          return { sessionId: request.sessionId, state: 'queued', message: 'Queued.' };
        },
      };
    };
    view = await mount(<ActionsProbe createClient={factory} target={connection(ALPHA)} />);
    await settle();
    expect(count()).toBe('1');
    await submit(view.container);
    expect(calls).toEqual([`status:${ALPHA}`, `investigate:${ALPHA}:sess-1`]);

    // A re-created connection object for the same machine is not asked again.
    await view.render(<ActionsProbe createClient={factory} target={connection(ALPHA)} />);
    await settle();
    expect(asked.filter(id => id === ALPHA).length).toBeGreaterThan(0);
    const alphaGrantReads = asked.length;

    // Another machine answers for itself: its no is not overridden by the first machine's yes.
    await view.render(<ActionsProbe createClient={factory} target={connection(BETA)} />);
    await settle();
    expect(count()).toBe('0');
    expect(asked.length).toBeGreaterThan(alphaGrantReads);
  });

  it('offers nothing when the grants cannot be read', async () => {
    const factory: AskWardenClientFactory = async () => {
      throw new Error('offline');
    };
    view = await mount(<ActionsProbe createClient={factory} target={connection(ALPHA)} />);
    await settle();
    expect(count()).toBe('0');
  });

  it('drops a grants answer that arrives after unmount', async () => {
    let release: () => void = () => undefined;
    const factory: AskWardenClientFactory = () =>
      new Promise(resolve => {
        release = () =>
          resolve({
            request: (async () => grants('granted')) as never,
            wardenStatus: async () => wardenStatus(),
            wardenInvestigate: async () => ({ sessionId: 'sess-1', state: 'queued', message: 'Queued.' }),
          });
      });
    view = await mount(<ActionsProbe createClient={factory} target={connection(ALPHA)} />);
    await view.unmount();
    view = null;
    release();
    await settle();
  });

  it('reads through the app’s routed client when none is injected', async () => {
    const factory: AskWardenClientFactory = async () => ({
      request: (async () => grants('granted')) as never,
      wardenStatus: async () => wardenStatus(),
      wardenInvestigate: async () => ({ sessionId: 'sess-1', state: 'queued', message: 'Queued.' }),
    });
    view = await mount(
      <DaemonClientProvider client={factory as never}>
        <ActionsProbe target={connection(ALPHA)} />
      </DaemonClientProvider>,
    );
    await settle();
    expect(count()).toBe('1');
  });
});

describe('ActionToast', () => {
  it('keeps an empty live region mounted, shows a notice, and dismisses on ✕', async () => {
    const dismissed: number[] = [];
    view = await mount(<ActionToast notice={null} onDismiss={() => dismissed.push(1)} />);
    const region = must(view.container.querySelector('[role="status"]'), 'region');
    expect(region.textContent).toBe('');
    expect(view.container.querySelector('button')).toBeNull();
    await view.render(<ActionToast notice="Queued." onDismiss={() => dismissed.push(1)} />);
    expect(must(view.container.querySelector('[role="status"]'), 'region').textContent).toBe('Queued.');
    await interact(() => must(view?.container.querySelector<HTMLButtonElement>('button'), 'dismiss').click());
    expect(dismissed).toEqual([1]);
    expect(ACTION_TOAST_MS).toBe(6_000);
  });

  it('dismisses itself after its time', async () => {
    const dismissed: number[] = [];
    view = await mount(<ActionToast dismissMs={5} notice="Queued." onDismiss={() => dismissed.push(1)} />);
    await interact(async () => await new Promise(resolve => setTimeout(resolve, 20)));
    expect(dismissed).toEqual([1]);
  });
});
