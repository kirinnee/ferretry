import { describe, expect, it } from 'bun:test';
import type { RegisterProjectRequest } from '@ferretry/protocol';

import { AddProjectForm } from '../../../src/features/projects/add-project-form.tsx';
import {
  ABSOLUTE_PATH_REQUIRED,
  CLONE_ADDRESS_UNUSABLE,
  CLONE_PATIENCE,
  emptyProjectRegistrationDraft,
  NEW_FOLDER_ONE_LEVEL,
  type ProjectRegistrationDraft,
  type ProjectRegistrationStatus,
} from '../../../src/features/projects/project-registration-model.ts';
import { interact, mount, must, type Mounted } from '../../support/dom.ts';

const draft = (patch: Partial<ProjectRegistrationDraft> = {}): ProjectRegistrationDraft => ({
  ...emptyProjectRegistrationDraft,
  ...patch,
});

interface Harness {
  readonly mounted: Mounted;
  readonly drafts: ProjectRegistrationDraft[];
  readonly sent: RegisterProjectRequest[];
  readonly cancelled: number[];
  readonly show: (next: ProjectRegistrationDraft, status?: ProjectRegistrationStatus | null) => Promise<void>;
}

const harness = async (
  initial: ProjectRegistrationDraft = emptyProjectRegistrationDraft,
  status: ProjectRegistrationStatus | null = null,
): Promise<Harness> => {
  const drafts: ProjectRegistrationDraft[] = [];
  const sent: RegisterProjectRequest[] = [];
  const cancelled: number[] = [];
  const element = (next: ProjectRegistrationDraft, phase: ProjectRegistrationStatus | null) => (
    <AddProjectForm
      draft={next}
      onDraftChange={value => drafts.push(value)}
      onSubmit={request => sent.push(request)}
      onCancel={() => cancelled.push(1)}
      status={phase}
    />
  );
  const mounted = await mount(element(initial, status));
  return {
    mounted,
    drafts,
    sent,
    cancelled,
    show: async (next, phase = null) => await mounted.render(element(next, phase)),
  };
};

const field = (mounted: Mounted, label: string): HTMLInputElement => {
  const node = [...mounted.container.querySelectorAll('label')].find(candidate =>
    (candidate.textContent ?? '').startsWith(label),
  );
  const id = must(node, `the ${label} label`).getAttribute('for');
  return must(mounted.container.querySelector<HTMLInputElement>(`#${id}`), `the ${label} field`);
};

const submitButton = (mounted: Mounted): HTMLButtonElement =>
  must(mounted.container.querySelector<HTMLButtonElement>('button[type="submit"]'), 'the submit button');

const type = async (input: HTMLInputElement, value: string): Promise<void> => {
  await interact(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const press = async (element: Element): Promise<void> => {
  await interact(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
};

const submit = async (mounted: Mounted): Promise<void> => {
  await interact(() => {
    must(mounted.container.querySelector('form'), 'the form').dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
  });
};

describe('AddProjectForm', () => {
  it('offers the three arms as native radios and lands focus in the path field', async () => {
    const { mounted } = await harness();

    const radios = [...mounted.container.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.map(radio => radio.value)).toEqual(['existing-folder', 'new-folder', 'clone']);
    expect(radios[0]?.checked).toBe(true);
    expect(must(mounted.container.querySelector('legend'), 'the group name').textContent).toBe(
      'How to add the project',
    );
    expect(document.activeElement).toBe(field(mounted, 'Folder'));
    await mounted.unmount();
  });

  it('keeps the sr-only radios inside a positioned group, so focusing one cannot scroll the shell', async () => {
    const { mounted } = await harness();

    // `sr-only` is position:absolute; in a statically positioned ancestor it
    // escapes to the fixed app shell and focusing it scrolls the app away.
    expect(must(mounted.container.querySelector('fieldset'), 'the mode group').className).toContain('relative');
    await mounted.unmount();
  });

  it('reports a mode change without deciding it, so the caller owns the draft', async () => {
    const { mounted, drafts } = await harness();

    await press(must(mounted.container.querySelector('input[value="clone"]'), 'the clone radio'));

    expect(drafts).toEqual([draft({ mode: 'clone' })]);
    await mounted.unmount();
  });

  it('shows the URL field and the clone warning only for a clone', async () => {
    const { mounted, show } = await harness();

    expect(mounted.container.textContent).not.toContain(CLONE_PATIENCE);
    await show(draft({ mode: 'clone' }));

    expect(mounted.container.textContent).toContain(CLONE_PATIENCE);
    expect(field(mounted, 'Repository URL')).not.toBeNull();
    expect(field(mounted, 'Clone into')).not.toBeNull();
    await mounted.unmount();
  });

  it('shows the git init choice and its one-level limit only for a new folder', async () => {
    const { mounted, show } = await harness();

    expect(mounted.container.querySelector('input[type="checkbox"]')).toBeNull();
    await show(draft({ mode: 'new-folder' }));

    expect(mounted.container.textContent).toContain(NEW_FOLDER_ONE_LEVEL);
    expect(
      must(mounted.container.querySelector<HTMLInputElement>('input[type="checkbox"]'), 'the git box').checked,
    ).toBe(false);
    await mounted.unmount();
  });

  it('reports the git init choice as a draft change', async () => {
    const { mounted, drafts } = await harness(draft({ mode: 'new-folder', path: '/work/fresh' }));

    await press(must(mounted.container.querySelector('input[type="checkbox"]'), 'the git box'));

    expect(drafts).toEqual([draft({ mode: 'new-folder', path: '/work/fresh', initializeGit: true })]);
    await mounted.unmount();
  });

  it('reports every typed field as a draft change', async () => {
    const { mounted, drafts, show } = await harness(draft({ mode: 'clone' }));

    await type(field(mounted, 'Clone into'), '/work/p');
    await type(field(mounted, 'Repository URL'), 'https://example.test/p.git');
    await type(field(mounted, 'Display name'), 'Peer');
    await show(draft({ mode: 'existing-folder' }));
    await type(field(mounted, 'Folder'), '/work/here');

    expect(drafts.map(value => [value.path, value.url, value.name])).toEqual([
      ['/work/p', '', ''],
      ['', 'https://example.test/p.git', ''],
      ['', '', 'Peer'],
      ['/work/here', '', ''],
    ]);
    await mounted.unmount();
  });

  it('disables the button and stays silent while a draft is merely unfinished', async () => {
    const { mounted } = await harness();

    expect(submitButton(mounted).disabled).toBe(true);
    expect(mounted.container.querySelector('[data-project-draft-problem]')).toBeNull();
    await mounted.unmount();
  });

  it('says why a relative path cannot be sent, and keeps the button disabled', async () => {
    const { mounted } = await harness(draft({ path: 'work/relative' }));

    expect(submitButton(mounted).disabled).toBe(true);
    expect(must(mounted.container.querySelector('[data-project-draft-problem]'), 'the problem').textContent).toBe(
      ABSOLUTE_PATH_REQUIRED,
    );
    await mounted.unmount();
  });

  it('says why a scp-style clone address cannot be sent', async () => {
    const { mounted } = await harness(draft({ mode: 'clone', path: '/work/p', url: 'git@host:you/p.git' }));

    expect(must(mounted.container.querySelector('[data-project-draft-problem]'), 'the problem').textContent).toBe(
      CLONE_ADDRESS_UNUSABLE,
    );
    await mounted.unmount();
  });

  it('hands the parsed request up on submit rather than a draft the caller must re-parse', async () => {
    const { mounted, sent } = await harness(draft({ mode: 'new-folder', path: ' /work/fresh ', initializeGit: true }));

    await press(submitButton(mounted));

    expect(sent).toEqual([{ kind: 'new-folder', path: '/work/fresh', initializeGit: true }]);
    await mounted.unmount();
  });

  it('sends nothing when the form is submitted with an unsendable draft', async () => {
    const { mounted, sent } = await harness(draft({ path: 'work/relative' }));

    await submit(mounted);

    expect(sent).toEqual([]);
    await mounted.unmount();
  });

  it('sends nothing on a second submit while the first is still in flight', async () => {
    const request = { kind: 'existing-folder', path: '/work/ferretry' } as const;
    const { mounted, sent } = await harness(draft({ path: '/work/ferretry' }), { phase: 'submitting', request });

    await submit(mounted);

    expect(sent).toEqual([]);
    await mounted.unmount();
  });

  it('names the wait, disables every field, and says a clone cannot be cancelled', async () => {
    const request = { kind: 'clone', url: 'https://example.test/p.git', path: '/work/p' } as const;
    const { mounted } = await harness(draft({ mode: 'clone', path: '/work/p', url: 'https://example.test/p.git' }), {
      phase: 'submitting',
      request,
    });

    expect(submitButton(mounted).textContent).toContain('Registering…');
    expect(field(mounted, 'Clone into').disabled).toBe(true);
    expect(must(mounted.container.querySelector('[role="status"]'), 'the wait').textContent).toContain(
      'can take minutes',
    );
    await mounted.unmount();
  });

  it('does not claim a clone is running when the wait belongs to another arm', async () => {
    const { mounted } = await harness(draft({ path: '/work/ferretry' }), {
      phase: 'submitting',
      request: { kind: 'existing-folder', path: '/work/ferretry' },
    });

    expect(mounted.container.querySelector('[role="status"]')).toBeNull();
    await mounted.unmount();
  });

  it('states the daemon’s refusal verbatim and promises the entries are still there', async () => {
    const { mounted } = await harness(draft({ mode: 'new-folder', path: '/work/a/b' }), {
      phase: 'refused',
      request: { kind: 'new-folder', path: '/work/a/b', initializeGit: false },
      message: 'ENOENT: no such file or directory',
    });

    const alert = must(mounted.container.querySelector('[role="alert"]'), 'the refusal');
    expect(alert.textContent).toContain('ENOENT: no such file or directory');
    expect(alert.textContent).toContain('Your entries are still here');
    // The refusal never disables the retry.
    expect(submitButton(mounted).disabled).toBe(false);
    await mounted.unmount();
  });

  it('shows no refusal once the write has settled successfully', async () => {
    const { mounted } = await harness(emptyProjectRegistrationDraft, {
      phase: 'registered',
      request: { kind: 'existing-folder', path: '/work/ferretry' },
      project: {
        id: '11111111-1111-4111-8111-111111111111',
        name: 'ferretry',
        path: '/work/ferretry',
        source: 'existing-folder',
        createdAt: '2026-08-01T10:00:00.000Z',
      },
      alreadyRegistered: false,
    });

    expect(mounted.container.querySelector('[role="alert"]')).toBeNull();
    await mounted.unmount();
  });

  it('cancels without clearing anything, because collapsing is not a decision to discard', async () => {
    const { mounted, cancelled, drafts } = await harness(draft({ path: '/work/ferretry' }));

    await press(must(mounted.container.querySelector('button[type="button"]'), 'the cancel button'));

    expect(cancelled).toEqual([1]);
    expect(drafts).toEqual([]);
    await mounted.unmount();
  });
});
