import { afterEach, describe, expect, it } from 'bun:test';
import type { WardenInvestigateRequest, WardenInvestigateView, WardenStatusView } from '../../../app/wire.ts';
import type { CoreActionContext, FerretActionFormHost, GrantsView } from '../../../app/shell.ts';
import { fakeWardenClient } from '../../support/app/clients.ts';
import {
  ASK_WARDEN_ACTION_ID,
  AskWardenForm,
  type AskWardenClientFactory,
  type AskWardenPorts,
  askWardenContribution,
  useAskWardenActions,
} from '../../../app/features/warden/ask-warden.tsx';
import { type DaemonConnection, daemonConnection } from '../../../app/shell.ts';
import { interact, type Mounted, mount, must } from '@ferretry/app/testing';
import { ferretView } from '../../support/app/ferrets.ts';
import { wardenConfig, wardenStatus } from '../../support/app/warden.ts';

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

type GrantRefusal = 'granted' | 'not-granted' | 'device-not-granted' | 'step-up-required' | 'undetermined';
const CAPABILITIES = ['fleet', 'terminal', 'browser', 'filesystem', 'warden', 'pairing'] as const;
const grants = (warden: GrantRefusal): GrantsView => ({
  capabilities: CAPABILITIES.map(capability => {
    const useRefusal = capability === 'warden' ? warden : 'granted';
    return { capability, use: useRefusal === 'granted', useRefusal };
  }),
});

interface Recorder {
  readonly closes: number[];
  readonly notices: string[];
  readonly requests: WardenInvestigateRequest[];
}

const hostFor = (recorder: Recorder): FerretActionFormHost => ({
  close: () => recorder.closes.push(1),
  open: () => undefined,
  notify: (sentence: string) => recorder.notices.push(sentence),
  compact: false,
});

const portsFor = (
  recorder: Recorder,
  status: () => Promise<WardenStatusView>,
  answer: () => Promise<WardenInvestigateView> = async () => ({
    ferret: 'sess-1',
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
  view = await mount(<AskWardenForm host={hostFor(rec)} name="hadi" ports={ports} ferret="sess-1" />);
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
      <AskWardenForm host={hostFor(rec)} name="hadi" ports={portsFor(rec, () => pending)} ferret="sess-1" />,
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
    expect(rec.requests).toEqual([{ ferret: 'sess-1', note: 'Focus: the recent failures. CI went red' }]);
    expect(rec.closes).toEqual([1]);
    expect(rec.notices).toEqual(['Investigation of hadi queued — the report lands in Info › Signals.']);
  });

  it('says "started" when the daemon runs it at once', async () => {
    const rec = recorder();
    const root = await openForm(
      portsFor(
        rec,
        async () => wardenStatus(),
        async () => ({ ferret: 'sess-1', state: 'running', warden: 'w-1', message: 'Running.' }),
      ),
      rec,
    );
    await submit(root);
    expect(rec.requests).toEqual([{ ferret: 'sess-1', note: 'Focus: why it seems stuck.' }]);
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
            release = () => resolve({ ferret: 'sess-1', state: 'queued', message: 'Queued.' });
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
      <AskWardenForm host={hostFor(rec)} name="hadi" ports={portsFor(rec, () => late)} ferret="sess-1" />,
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
      <AskWardenForm host={hostFor(rec)} name="hadi" ports={portsFor(rec, () => late)} ferret="sess-1" />,
    );
    await view.unmount();
    view = null;
    fail();
    await settle();
    expect(rec.requests).toEqual([]);
  });
});

const context = (canControl: boolean): CoreActionContext => ({
  view: ferretView('sess-1'),
  name: 'hadi',
  canControl,
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
    // biome-ignore lint/complexity/noUselessFragments: `render` answers a ReactNode and `mount` takes an element
    view = await mount(<>{entry.render(hostFor(rec))}</>);
    await settle();
    await submit(view.container);
    expect(rec.requests[0]?.ferret).toBe('sess-1');
  });

  it('is hidden from a read-only connection', () => {
    const contribution = askWardenContribution(portsFor(recorder(), async () => wardenStatus()));
    expect(contribution.build(context(false))).toBeNull();
  });
});

function ActionsProbe({
  target,
  createClient,
  grantsOf,
}: {
  readonly target: DaemonConnection;
  readonly createClient?: AskWardenClientFactory;
  readonly grantsOf: (connection: DaemonConnection) => Promise<GrantsView>;
}) {
  const actions = useAskWardenActions(target, createClient, grantsOf);
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
    const grantsOf = async (target: DaemonConnection): Promise<GrantsView> => {
      asked.push(`${target.daemonId}`);
      return answers[`${target.daemonId}`] as GrantsView;
    };
    const factory: AskWardenClientFactory = async target =>
      fakeWardenClient({
        status: async () => {
          calls.push(`status:${target.daemonId}`);
          return wardenStatus();
        },
        investigate: async request => {
          calls.push(`investigate:${target.daemonId}:${request.ferret}`);
          return { ferret: request.ferret, state: 'queued', message: 'Queued.' };
        },
      });
    view = await mount(<ActionsProbe createClient={factory} grantsOf={grantsOf} target={connection(ALPHA)} />);
    await settle();
    expect(count()).toBe('1');
    await submit(view.container);
    expect(calls).toEqual([`status:${ALPHA}`, `investigate:${ALPHA}:sess-1`]);

    // A re-created connection object for the same machine is not asked again.
    await view.render(<ActionsProbe createClient={factory} grantsOf={grantsOf} target={connection(ALPHA)} />);
    await settle();
    expect(asked.filter(id => id === ALPHA).length).toBeGreaterThan(0);
    const alphaGrantReads = asked.length;

    // Another machine answers for itself: its no is not overridden by the first machine's yes.
    await view.render(<ActionsProbe createClient={factory} grantsOf={grantsOf} target={connection(BETA)} />);
    await settle();
    expect(count()).toBe('0');
    expect(asked.length).toBeGreaterThan(alphaGrantReads);
  });

  it('offers nothing when the grants cannot be read', async () => {
    const grantsOf = async (): Promise<GrantsView> => {
      throw new Error('offline');
    };
    view = await mount(<ActionsProbe grantsOf={grantsOf} target={connection(ALPHA)} />);
    await settle();
    expect(count()).toBe('0');
  });

  it('drops a grants answer that arrives after unmount', async () => {
    let release: () => void = () => undefined;
    const grantsOf = (): Promise<GrantsView> =>
      new Promise(resolve => {
        release = () => resolve(grants('granted'));
      });
    view = await mount(<ActionsProbe grantsOf={grantsOf} target={connection(ALPHA)} />);
    await view.unmount();
    view = null;
    release();
    await settle();
  });
});
