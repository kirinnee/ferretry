import { afterEach, describe, expect, test } from 'bun:test';
import type { PermissionAnswerRequest, PermissionRequest } from '@ferretry/protocol';
import { ApprovalCard, type PermissionAnswerApi } from '../../src/features/permission-request/approval-card.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import { PermissionPromptGone } from '../../src/lib/permission-requests.ts';
import { DaemonResponseError } from '../../src/lib/runtime-models.ts';
import '../support/dom.ts';
import { interact, type Mounted, mount, must } from '../support/dom.ts';

const daemon = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceId: 'token-a' });
const scope = daemonSessionScope(daemon, 's1');
const ID = '0123456789abcdef';

const readHostname: PermissionRequest = {
  id: ID,
  harness: 'claude',
  tool: 'Read',
  action: 'read',
  what: '/etc/hostname',
  question: 'Do you want to proceed?',
  options: [
    { number: 1, label: 'Yes', kind: 'allow' },
    { number: 2, label: 'Yes, allow reading from /etc during this session', kind: 'allow-always' },
    { number: 3, label: 'No', kind: 'deny' },
  ],
  selected: 1,
};

interface Recorded {
  readonly answers: PermissionAnswerRequest[];
  readonly notes: string[];
  api: PermissionAnswerApi;
}

const recordingApi = (
  answer: (request: PermissionAnswerRequest) => Promise<{ requestId: string; cleared: boolean }> = async request => ({
    requestId: request.requestId,
    cleared: true,
  }),
  note: (message: string) => Promise<unknown> = async () => undefined,
): Recorded => {
  const recorded: Recorded = {
    answers: [],
    notes: [],
    api: {
      answer: async (at, where, request) => {
        expect(at).toBe(daemon);
        expect(where).toBe(scope);
        recorded.answers.push(request);
        return await answer(request);
      },
      note: async (at, where, message) => {
        expect(at).toBe(daemon);
        expect(where).toBe(scope);
        recorded.notes.push(message);
        return await note(message);
      },
    },
  };
  return recorded;
};

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const card = (): HTMLElement => must(view?.container.querySelector<HTMLElement>('.fy-approval-card'), 'the card');
const option = (number: number): HTMLButtonElement =>
  must(view?.container.querySelector<HTMLButtonElement>(`[data-permission-option="${number}"]`), `option ${number}`);
const statusText = (): string | null => view?.container.querySelector('.fy-approval-card__status')?.textContent ?? null;
const click = async (element: HTMLElement): Promise<void> => {
  await interact(async () => {
    element.click();
    await Promise.resolve();
  });
};

const typeNote = async (text: string): Promise<void> => {
  await click(must(view?.container.querySelector<HTMLButtonElement>('.fy-approval-card__note-toggle'), 'note toggle'));
  const box = must(view?.container.querySelector<HTMLTextAreaElement>('textarea'), 'the note box');
  await interact(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(box, text);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('ApprovalCard', () => {
  test('says the request in plain words, one button per choice in the harness’s order, default marked', async () => {
    const recorded = recordingApi();
    view = await mount(
      <ApprovalCard
        agentName="Hadi"
        api={recorded.api}
        daemon={daemon}
        request={{ ...readHostname, detail: 'Reads the machine name' }}
        scope={scope}
      />,
    );
    const section = card();
    const heading = must(document.getElementById(must(section.getAttribute('aria-labelledby'), 'label id')), 'heading');
    expect(heading.textContent).toBe('Hadi wants to read /etc/hostname');
    expect(section.querySelector('[data-permission-what]')?.textContent).toBe('/etc/hostname');
    expect(section.querySelector('.fy-approval-card__detail')?.textContent).toBe('Reads the machine name');
    expect(section.getAttribute('data-permission-request')).toBe(ID);
    expect(section.getAttribute('data-daemon-id')).toBe('daemon-a');
    expect(section.querySelector('fieldset > legend')?.textContent).toBe('Do you want to proceed?');

    const buttons = [...section.querySelectorAll<HTMLButtonElement>('[data-permission-option]')];
    expect(buttons.map(button => button.querySelector('.fy-approval-card__label')?.textContent)).toEqual([
      'Allow once',
      'Always allow',
      'Deny',
    ]);
    expect(buttons.map(button => button.title)).toEqual([
      'Yes',
      'Yes, allow reading from /etc during this session',
      'No',
    ]);
    expect(buttons[1]?.querySelector('.fy-approval-card__secondary')?.textContent).toBe(
      'Yes, allow reading from /etc during this session',
    );
    expect(buttons[0]?.querySelector('.fy-approval-card__secondary')).toBeNull();
    expect(buttons[0]?.getAttribute('aria-label')).toBe('Allow once: Yes (default)');
    expect(buttons[0]?.hasAttribute('data-default')).toBe(true);
    expect(buttons[0]?.getAttribute('data-variant')).toBe('primary');
    expect(buttons[2]?.getAttribute('aria-label')).toBe('Deny: No');
    expect(buttons[2]?.hasAttribute('data-default')).toBe(false);
    expect(statusText()).toBeNull();
  });

  test('allowing sends the choice by its number, then says it is waiting for the agent', async () => {
    const recorded = recordingApi();
    let settled = 0;
    view = await mount(
      <ApprovalCard
        agentName="Hadi"
        api={recorded.api}
        daemon={daemon}
        onSettled={() => (settled += 1)}
        request={readHostname}
        scope={scope}
      />,
    );
    await click(option(2));
    expect(recorded.answers).toEqual([{ kind: 'choice', requestId: ID, number: 2 }]);
    expect(recorded.notes).toEqual([]);
    expect(settled).toBe(1);
    expect(statusText()).toBe('Answered — waiting for Hadi to continue.');
    expect(option(1).disabled).toBe(true);
  });

  test('is busy while the answer is in flight, and ignores a second press', async () => {
    let release: (value: { requestId: string; cleared: boolean }) => void = () => undefined;
    const recorded = recordingApi(
      () =>
        new Promise(resolve => {
          release = resolve;
        }),
    );
    view = await mount(
      <ApprovalCard agentName="Hadi" api={recorded.api} daemon={daemon} request={readHostname} scope={scope} />,
    );
    await click(option(1));
    expect(card().getAttribute('data-permission-phase')).toBe('sending');
    expect(statusText()).toBe('Sending…');
    expect(option(3).disabled).toBe(true);
    // A press the disabled attribute did not stop still sends nothing twice.
    await interact(async () => {
      option(3).disabled = false;
      option(3).click();
      await Promise.resolve();
    });
    expect(recorded.answers).toHaveLength(1);
    await interact(async () => {
      release({ requestId: ID, cleared: true });
      await Promise.resolve();
    });
    expect(card().getAttribute('data-permission-phase')).toBe('answered');
  });

  test('deny is the harness’s Esc, and the note follows as an ordinary message once the prompt cleared', async () => {
    const recorded = recordingApi();
    view = await mount(
      <ApprovalCard agentName="Hadi" api={recorded.api} daemon={daemon} request={readHostname} scope={scope} />,
    );
    await typeNote('  use the cached copy instead  ');
    expect(view.container.querySelector('label')?.textContent).toBe('Note for Hadi, sent after Deny');
    await click(option(3));
    expect(recorded.answers).toEqual([{ kind: 'deny', requestId: ID }]);
    expect(recorded.notes).toEqual(['use the cached copy instead']);
    expect(card().getAttribute('data-permission-phase')).toBe('answered');
  });

  test('a note is never sent with an allow, nor when it is blank', async () => {
    const recorded = recordingApi();
    view = await mount(
      <ApprovalCard agentName="Hadi" api={recorded.api} daemon={daemon} request={readHostname} scope={scope} />,
    );
    await typeNote('only if denied');
    await click(option(1));
    expect(recorded.notes).toEqual([]);
    await view.unmount();

    const blank = recordingApi();
    view = await mount(
      <ApprovalCard agentName="Hadi" api={blank.api} daemon={daemon} request={readHostname} scope={scope} />,
    );
    await typeNote('   ');
    await click(option(3));
    expect(blank.answers).toEqual([{ kind: 'deny', requestId: ID }]);
    expect(blank.notes).toEqual([]);
  });

  test('says so when the deny landed but the note could not be sent', async () => {
    let settled = 0;
    const recorded = recordingApi(undefined, async () => {
      throw new Error('the daemon is unreachable');
    });
    view = await mount(
      <ApprovalCard
        agentName="Hadi"
        api={recorded.api}
        daemon={daemon}
        onSettled={() => (settled += 1)}
        request={readHostname}
        scope={scope}
      />,
    );
    await typeNote('try again later');
    await click(option(3));
    expect(statusText()).toBe('Denied, but the note could not be sent: the daemon is unreachable');
    expect(settled).toBe(1);

    await view.unmount();
    const opaque = recordingApi(undefined, async () => {
      throw 'nope';
    });
    view = await mount(
      <ApprovalCard agentName="Hadi" api={opaque.api} daemon={daemon} request={readHostname} scope={scope} />,
    );
    await typeNote('x');
    await click(option(3));
    expect(statusText()).toBe('Denied, but the note could not be sent: unknown error');
  });

  test('a later refusal the harness drew is picked by its number, not by Esc', async () => {
    const recorded = recordingApi();
    const codex: PermissionRequest = {
      ...readHostname,
      harness: 'codex',
      tool: 'Shell',
      action: 'run',
      what: 'curl -s https://example.com | head',
      question: 'Would you like to run the following command?',
      options: [
        { number: 1, label: 'Yes, proceed', kind: 'allow' },
        { number: 2, label: "Yes, and don't ask again for this command", kind: 'allow-always' },
        { number: 3, label: 'No, and tell Codex what to do differently', kind: 'deny' },
        { number: 4, label: 'No, cancel', kind: 'deny' },
      ],
      selected: 4,
    };
    view = await mount(
      <ApprovalCard agentName="Hadi" api={recorded.api} daemon={daemon} request={codex} scope={scope} />,
    );
    expect(card().querySelector('[data-permission-what]')?.textContent).toBe('curl -s https://example.com | head');
    // The harness's cursor is on a refusal: marked as the default, never painted as the primary action.
    expect(option(4).hasAttribute('data-default')).toBe(true);
    expect(option(4).hasAttribute('data-variant')).toBe(false);
    await click(option(4));
    expect(recorded.answers).toEqual([{ kind: 'choice', requestId: ID, number: 4 }]);
  });

  test('offers no note when the harness drew no refusal, and draws no mono line when it names nothing', async () => {
    const recorded = recordingApi();
    const plan: PermissionRequest = {
      id: ID,
      harness: 'claude',
      tool: 'ExitPlanMode',
      action: 'exit-plan',
      question: 'Would you like to proceed?',
      options: [
        { number: 1, label: 'Yes, and auto-accept edits', kind: 'allow-always' },
        { number: 2, label: 'Yes, and manually approve edits', kind: 'allow' },
      ],
      selected: 1,
    };
    view = await mount(
      <ApprovalCard agentName="Hadi" api={recorded.api} daemon={daemon} request={plan} scope={scope} />,
    );
    expect(card().querySelector('.fy-approval-card__ask')?.textContent).toBe('Hadi wants to exit plan mode and start');
    expect(card().querySelector('[data-permission-what]')).toBeNull();
    expect(card().querySelector('.fy-approval-card__detail')).toBeNull();
    expect(card().querySelector('.fy-approval-card__note-toggle')).toBeNull();
  });

  test('says when the same prompt is still on screen, and lets the person answer again by hand', async () => {
    let settled = 0;
    const recorded = recordingApi(async request => ({ requestId: request.requestId, cleared: false }));
    view = await mount(
      <ApprovalCard
        agentName="Hadi"
        api={recorded.api}
        daemon={daemon}
        onSettled={() => (settled += 1)}
        request={readHostname}
        scope={scope}
      />,
    );
    await typeNote('not this');
    await click(option(3));
    expect(card().querySelector('[data-permission-stuck]')?.textContent).toContain('still on the agent’s screen');
    expect(recorded.notes).toEqual([]);
    expect(settled).toBe(0);
    expect(option(1).disabled).toBe(false);
    expect(recorded.answers).toHaveLength(1);
  });

  test('a prompt that is gone says so and asks the page to re-read the session', async () => {
    let settled = 0;
    const recorded = recordingApi(async () => {
      throw new PermissionPromptGone('this prompt is gone');
    });
    view = await mount(
      <ApprovalCard
        agentName="Hadi"
        api={recorded.api}
        daemon={daemon}
        onSettled={() => (settled += 1)}
        request={readHostname}
        scope={scope}
      />,
    );
    await click(option(1));
    expect(card().querySelector('[data-permission-gone]')?.textContent).toBe(
      'This prompt is gone — it changed on the agent’s screen. Nothing was sent.',
    );
    expect(settled).toBe(1);
    expect(option(1).disabled).toBe(true);
  });

  test('shows a grant refusal in the grant’s words, and any other failure as the daemon said it', async () => {
    const refusals: unknown[] = [
      new DaemonResponseError(403, 'this device lacks the terminal grant', 'grant_not_granted'),
      new DaemonResponseError(403, '', 'grant_not_granted'),
      new DaemonResponseError(409, 'could not type into the pane', 'console_input_failed'),
      'not an error',
    ];
    const texts: string[] = [];
    for (const refusal of refusals) {
      const recorded = recordingApi(async () => {
        throw refusal;
      });
      view = await mount(
        <ApprovalCard agentName="Hadi" api={recorded.api} daemon={daemon} request={readHostname} scope={scope} />,
      );
      await click(option(1));
      texts.push(must(card().querySelector('[data-permission-refused]')?.textContent, 'the refusal'));
      expect(option(1).disabled).toBe(false);
      await view.unmount();
      view = null;
    }
    expect(texts[0]).toContain('this device lacks the terminal grant');
    expect(texts[0]?.length).toBeGreaterThan('this device lacks the terminal grant'.length);
    expect(texts[1]?.length).toBeGreaterThan(0);
    expect(texts[1]).not.toContain('  ');
    expect(texts[2]).toBe('could not type into the pane');
    expect(texts[3]).toBe('The answer could not be sent.');
  });
});
