import { afterEach, describe, expect, test } from 'bun:test';
import type { HarnessDialog, HarnessDialogAnswerRequest } from '@ferretry/protocol';
import { DialogCard, type HarnessDialogAnswerApi } from '../../src/features/harness-dialog/dialog-card.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import { HarnessDialogGone } from '../../src/lib/harness-dialogs.ts';
import { DaemonResponseError } from '../../src/lib/runtime-models.ts';
import '../support/dom.ts';
import { interact, type Mounted, mount, must } from '../support/dom.ts';

const daemon = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceId: 'token-a' });
const scope = daemonSessionScope(daemon, 's1');
const ID = '0123456789abcdef';

const hooksReview: HarnessDialog = {
  id: ID,
  harness: 'codex',
  kind: 'hooks-review',
  title: 'Hooks need review',
  body: '1 hook is new or changed.\nHooks can run outside the sandbox after you trust them.',
  options: [
    { number: 1, label: 'Review hooks', grantsTrust: false },
    { number: 2, label: 'Trust all and continue', grantsTrust: true },
    { number: 3, label: 'Continue without trusting', detail: "hooks won't run", grantsTrust: false },
  ],
  selected: 1,
  escape: 'skip',
};

interface Recorded {
  readonly answers: HarnessDialogAnswerRequest[];
  api: HarnessDialogAnswerApi;
}

const recordingApi = (
  answer: (request: HarnessDialogAnswerRequest) => Promise<{ dialogId: string; cleared: boolean }> = async request => ({
    dialogId: request.dialogId,
    cleared: true,
  }),
): Recorded => {
  const recorded: Recorded = {
    answers: [],
    api: {
      answer: async (at, where, request) => {
        expect(at).toBe(daemon);
        expect(where).toBe(scope);
        recorded.answers.push(request);
        return await answer(request);
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

const card = (): HTMLElement => must(view?.container.querySelector<HTMLElement>('.fy-dialog-card'), 'the card');
const option = (number: number): HTMLButtonElement =>
  must(view?.container.querySelector<HTMLButtonElement>(`[data-dialog-option="${number}"]`), `option ${number}`);
const escapeButton = (): HTMLButtonElement =>
  must(view?.container.querySelector<HTMLButtonElement>('[data-dialog-escape]'), 'the Esc button');
const statusText = (): string | null => view?.container.querySelector('.fy-dialog-card__status')?.textContent ?? null;
const click = async (element: HTMLElement): Promise<void> => {
  await interact(async () => {
    element.click();
    await Promise.resolve();
  });
};
const show = async (dialog: HarnessDialog, api: HarnessDialogAnswerApi, onSettled?: () => void): Promise<void> => {
  view = await mount(
    <DialogCard
      agentName="Hadi"
      api={api}
      daemon={daemon}
      dialog={dialog}
      {...(onSettled === undefined ? {} : { onSettled })}
      scope={scope}
    />,
  );
};

describe('DialogCard', () => {
  test('says the dialog in the harness’s words, one button per row in its order, the default marked', async () => {
    await show(hooksReview, recordingApi().api);
    const section = card();
    const heading = must(document.getElementById(must(section.getAttribute('aria-labelledby'), 'label id')), 'heading');
    expect(heading.textContent).toBe('Hadi’s Codex is waiting: Hooks need review');
    expect(section.querySelector('.fy-dialog-card__body')?.textContent).toBe(
      '1 hook is new or changed.\nHooks can run outside the sandbox after you trust them.',
    );
    expect(section.getAttribute('data-harness-dialog')).toBe(ID);
    expect(section.getAttribute('data-dialog-kind')).toBe('hooks-review');
    expect(section.getAttribute('data-daemon-id')).toBe('daemon-a');
    expect(section.querySelector('fieldset > legend')?.textContent).toBe('Hooks need review');
    expect(section.querySelector('.fy-dialog-card__hint')).toBeNull();

    const buttons = [...section.querySelectorAll<HTMLButtonElement>('[data-dialog-option]')];
    expect(buttons.map(button => button.title)).toEqual([
      'Review hooks',
      'Trust all and continue',
      'Continue without trusting',
    ]);
    expect(buttons.map(button => button.querySelector('.fy-dialog-card__label')?.firstChild?.textContent)).toEqual([
      'Review hooks',
      'Trust all and continue',
      'Continue without trusting',
    ]);
    expect(buttons[0]?.querySelector('.fy-dialog-card__default')?.textContent).toBe(' · default');
    expect(buttons[1]?.querySelector('.fy-dialog-card__default')).toBeNull();
    expect(buttons[0]?.hasAttribute('data-default')).toBe(true);
    expect(buttons[0]?.getAttribute('data-variant')).toBe('primary');
    expect(buttons[2]?.querySelector('.fy-dialog-card__secondary')?.textContent).toBe("hooks won't run");
    expect(buttons[0]?.querySelector('.fy-dialog-card__secondary')).toBeNull();
    expect(statusText()).toBeNull();
  });

  test('draws a trust-granting choice in its own tone with what it grants, and never as the primary action', async () => {
    const onTrust: HarnessDialog = { ...hooksReview, selected: 2 };
    await show(onTrust, recordingApi().api);
    expect(option(2).hasAttribute('data-grants-trust')).toBe(true);
    expect(option(2).hasAttribute('data-default')).toBe(true);
    expect(option(2).hasAttribute('data-variant')).toBe(false);
    expect(option(2).querySelector('[data-dialog-trust]')?.textContent).toBe('Trusts these to run outside the sandbox');
    expect(option(1).hasAttribute('data-grants-trust')).toBe(false);
    expect(option(1).querySelector('[data-dialog-trust]')).toBeNull();
    await view?.unmount();

    await show(
      { ...hooksReview, kind: 'mcp-servers', harness: 'claude', title: 'New MCP server found' },
      recordingApi().api,
    );
    expect(option(2).querySelector('[data-dialog-trust]')?.textContent).toBe('Lets this MCP server run');
  });

  test('a choice is sent by its number and says it is waiting for the agent', async () => {
    const recorded = recordingApi();
    let settled = 0;
    await show(hooksReview, recorded.api, () => (settled += 1));
    await click(option(3));
    expect(recorded.answers).toEqual([{ kind: 'choice', dialogId: ID, number: 3 }]);
    expect(settled).toBe(1);
    expect(statusText()).toBe('Answered — waiting for Hadi to continue.');
    expect(option(1).disabled).toBe(true);
    expect(escapeButton().disabled).toBe(true);
  });

  test('Esc is a button in the footer’s word and sends the harness’s Esc', async () => {
    const recorded = recordingApi();
    await show(hooksReview, recorded.api);
    expect(escapeButton().textContent).toBe('Skip');
    expect(escapeButton().getAttribute('aria-label')).toBe('Skip (Esc)');
    expect(escapeButton().title).toBe('Esc');
    await click(escapeButton());
    expect(recorded.answers).toEqual([{ kind: 'escape', dialogId: ID }]);
    expect(card().getAttribute('data-dialog-phase')).toBe('answered');
  });

  test('offers no Esc button when the footer offers no Esc', async () => {
    const { escape: _escape, ...withoutEsc } = hooksReview;
    await show(withoutEsc, recordingApi().api);
    expect(view?.container.querySelector('[data-dialog-escape]')).toBeNull();
    expect(view?.container.querySelectorAll('[data-dialog-option]')).toHaveLength(3);
  });

  test('the hook list offers only the way out', async () => {
    const recorded = recordingApi();
    await show(
      {
        ...hooksReview,
        kind: 'hooks-list',
        title: 'Hooks',
        body: 'pre-commit  ·  not trusted',
        escape: 'close',
      },
      recorded.api,
    );
    expect(view?.container.querySelectorAll('[data-dialog-option]')).toHaveLength(0);
    expect(escapeButton().textContent).toBe('Close');
    await click(escapeButton());
    expect(recorded.answers).toEqual([{ kind: 'escape', dialogId: ID }]);
  });

  test('a hook list with no Esc still shows its rows rather than nothing', async () => {
    const { escape: _escape, ...withoutEsc } = hooksReview;
    await show({ ...withoutEsc, kind: 'hooks-list' }, recordingApi().api);
    expect(view?.container.querySelectorAll('[data-dialog-option]')).toHaveLength(3);
  });

  test('says the sign-in finishes in the Console', async () => {
    await show(
      {
        id: ID,
        harness: 'codex',
        kind: 'sign-in',
        title: 'Sign in with ChatGPT',
        options: [{ number: 1, label: 'Sign in with ChatGPT', grantsTrust: false }],
        selected: 1,
      },
      recordingApi().api,
    );
    expect(card().querySelector('.fy-dialog-card__hint')?.textContent).toBe('Signing in finishes in the Console.');
    expect(card().querySelector('.fy-dialog-card__body')).toBeNull();
  });

  test('is busy while the answer is in flight, and ignores a second press', async () => {
    let release: (value: { dialogId: string; cleared: boolean }) => void = () => undefined;
    const recorded = recordingApi(
      () =>
        new Promise(resolve => {
          release = resolve;
        }),
    );
    await show(hooksReview, recorded.api);
    await click(option(1));
    expect(card().getAttribute('data-dialog-phase')).toBe('sending');
    expect(statusText()).toBe('Sending…');
    expect(option(3).disabled).toBe(true);
    await interact(async () => {
      option(3).disabled = false;
      option(3).click();
      await Promise.resolve();
    });
    expect(recorded.answers).toHaveLength(1);
    await interact(async () => {
      release({ dialogId: ID, cleared: true });
      await Promise.resolve();
    });
    expect(card().getAttribute('data-dialog-phase')).toBe('answered');
  });

  test('says when the same dialog is still on screen, and lets the person answer again by hand', async () => {
    let settled = 0;
    const recorded = recordingApi(async request => ({ dialogId: request.dialogId, cleared: false }));
    await show(hooksReview, recorded.api, () => (settled += 1));
    await click(option(1));
    expect(card().querySelector('[data-dialog-stuck]')?.textContent).toContain('still on the agent’s screen');
    expect(settled).toBe(0);
    expect(option(1).disabled).toBe(false);
    expect(recorded.answers).toHaveLength(1);
  });

  test('a dialog that is gone says so and asks the page to re-read the session', async () => {
    let settled = 0;
    const recorded = recordingApi(async () => {
      throw new HarnessDialogGone('this dialog is gone');
    });
    await show(hooksReview, recorded.api, () => (settled += 1));
    await click(option(1));
    expect(card().querySelector('[data-dialog-gone]')?.textContent).toBe(
      'This dialog is gone — it changed on the agent’s screen. Nothing was sent.',
    );
    expect(settled).toBe(1);
    expect(option(1).disabled).toBe(true);
  });

  test('shows a grant refusal in the grant’s words, and any other failure as the daemon said it', async () => {
    const refusals: unknown[] = [
      new DaemonResponseError(403, 'this device lacks the terminal grant', 'grant_not_granted'),
      new DaemonResponseError(403, '', 'grant_not_granted'),
      new DaemonResponseError(400, 'no such choice', 'invalid_dialog_choice'),
      'not an error',
    ];
    const texts: string[] = [];
    for (const refusal of refusals) {
      const recorded = recordingApi(async () => {
        throw refusal;
      });
      await show(hooksReview, recorded.api);
      await click(option(1));
      texts.push(must(card().querySelector('[data-dialog-refused]')?.textContent, 'the refusal'));
      expect(option(1).disabled).toBe(false);
      await view?.unmount();
      view = null;
    }
    expect(texts[0]).toContain('this device lacks the terminal grant');
    expect(texts[0]?.length).toBeGreaterThan('this device lacks the terminal grant'.length);
    expect(texts[1]?.length).toBeGreaterThan(0);
    expect(texts[1]).not.toContain('  ');
    expect(texts[2]).toBe('no such choice');
    expect(texts[3]).toBe('The answer could not be sent.');
  });
});
