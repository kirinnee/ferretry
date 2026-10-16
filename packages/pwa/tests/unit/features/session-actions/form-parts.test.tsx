import { afterEach, describe, expect, it } from 'bun:test';
import {
  failureMessage,
  FormFailure,
  FormField,
  FormFoot,
} from '../../../../src/features/session-actions/form-parts.tsx';
import { mount, must, type Mounted } from '../../../support/dom.ts';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

describe('FormField', () => {
  it('labels the field and renders its children', async () => {
    mounted = await mount(
      <FormField id="name" label="Name">
        <input id="name" />
      </FormField>,
    );
    const label = must(mounted.container.querySelector('label'), 'label');
    expect(label.getAttribute('for')).toBe('name');
    expect(label.textContent).toBe('Name');
    expect(mounted.container.querySelector('input')).not.toBeNull();
  });

  it('shows help only when it is given', async () => {
    mounted = await mount(
      <FormField help="Leave it empty." id="x" label="X">
        <input />
      </FormField>,
    );
    expect(mounted.container.textContent).toContain('Leave it empty.');
    await mounted.unmount();
    mounted = await mount(
      <FormField id="x" label="X">
        <input />
      </FormField>,
    );
    expect(mounted.container.querySelector('.fy-action-form__help')).toBeNull();
  });

  it('shows an error only when it is a non-null string', async () => {
    mounted = await mount(
      <FormField error="Required." id="x" label="X">
        <input />
      </FormField>,
    );
    const error = must(mounted.container.querySelector('[role="alert"]'), 'error');
    expect(error.textContent).toBe('Required.');
    await mounted.unmount();
    mounted = await mount(
      <FormField error={null} id="x" label="X">
        <input />
      </FormField>,
    );
    expect(mounted.container.querySelector('[role="alert"]')).toBeNull();
  });
});

describe('FormFailure', () => {
  it('renders nothing for a null message', async () => {
    mounted = await mount(<FormFailure message={null} />);
    expect(mounted.container.innerHTML).toBe('');
  });

  it('renders the message as an alert', async () => {
    mounted = await mount(<FormFailure message="The daemon refused it." />);
    expect(must(mounted.container.querySelector('[role="alert"]'), 'alert').textContent).toBe('The daemon refused it.');
  });
});

describe('FormFoot', () => {
  it('runs onCancel from the Cancel button, with its default label', async () => {
    let cancelled = 0;
    mounted = await mount(<FormFoot onCancel={() => (cancelled += 1)} submitLabel="Save" submitting={false} />);
    const buttons = [...mounted.container.querySelectorAll('button')];
    const cancel = must(
      buttons.find(button => button.textContent === 'Cancel'),
      'Cancel button',
    );
    cancel.click();
    expect(cancelled).toBe(1);
  });

  it('honours a custom cancel label', async () => {
    mounted = await mount(
      <FormFoot cancelLabel="Not now" onCancel={() => undefined} submitLabel="Save" submitting={false} />,
    );
    expect(mounted.container.textContent).toContain('Not now');
  });

  it('shows the icon and label while idle, and a spinner with no icon while submitting', async () => {
    mounted = await mount(
      <FormFoot
        icon={<span data-testid="icon" />}
        onCancel={() => undefined}
        submitLabel="Add server"
        submitting={false}
      />,
    );
    const submit = must(mounted.container.querySelector('[data-action-submit]'), 'submit');
    expect(submit.querySelector('[data-testid="icon"]')).not.toBeNull();
    expect(submit.textContent).toContain('Add server');
    await mounted.render(
      <FormFoot icon={<span data-testid="icon" />} onCancel={() => undefined} submitLabel="Add server" submitting />,
    );
    expect(submit.querySelector('[data-testid="icon"]')).toBeNull();
    expect(submit.querySelector('.animate-spin')).not.toBeNull();
  });

  it('disables the submit button when submitting, or when the caller says it is incomplete', async () => {
    mounted = await mount(<FormFoot disabled onCancel={() => undefined} submitLabel="Save" submitting={false} />);
    const submit = must(mounted.container.querySelector('[data-action-submit]'), 'submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await mounted.render(<FormFoot onCancel={() => undefined} submitLabel="Save" submitting />);
    expect((mounted.container.querySelector('[data-action-submit]') as HTMLButtonElement).disabled).toBe(true);
    expect((mounted.container.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('failureMessage', () => {
  it('reads an Error’s message', () => {
    expect(failureMessage(new Error('down'))).toBe('down');
  });

  it('stringifies anything else', () => {
    expect(failureMessage('nope')).toBe('nope');
    expect(failureMessage(404)).toBe('404');
  });
});
