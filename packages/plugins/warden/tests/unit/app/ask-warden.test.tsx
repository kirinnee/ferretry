import { afterEach, describe, expect, it } from 'bun:test';
import type { WardenInvestigateRequest, WardenInvestigateView, WardenStatusView } from '../../../app/wire.ts';
import type { FerretActionFormHost } from '../../../app/lib/ferret-actions.ts';
import { AskWardenForm, type AskWardenPorts } from '../../../app/features/warden/ask-warden.tsx';
import { interact, type Mounted, mount, must } from '@ferretry/app/testing';
import { wardenConfig, wardenStatus } from '../../support/app/warden.ts';

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
