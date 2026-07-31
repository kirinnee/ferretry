import { describe, expect, it } from 'bun:test';
import type { SessionView } from '@ferretry/protocol';
import {
  BulkStopConfirmation,
  type BulkStopConfirmationProps,
  stopTargetName,
} from '../../src/shell/bulk-stop-confirmation.tsx';
import type { BulkStopRequest } from '../../src/shell/agent-sidebar-model.ts';
import { interact, mount, pressKey } from '../support/dom.ts';
import { sessionView } from '../support/sessions.ts';

const lead = sessionView('lead-1', { config: { name: 'Fleet Lead', teammate: 'nero' } });
const child = sessionView('child-1', { config: { name: 'Child One', parent: 'lead-1' } });
const grandchild = sessionView('grand-1', { config: { name: 'Grand One', parent: 'child-1' } });
const fleet = [lead, child, grandchild];

const request = (overrides: Partial<BulkStopRequest> = {}): BulkStopRequest => ({
  token: 1,
  selectedId: 'lead-1',
  scope: 'cascade',
  targets: [lead, child],
  ...overrides,
});

const render = async (overrides: Partial<BulkStopConfirmationProps> = {}) => {
  const confirmed: string[] = [];
  const reviewed: (readonly SessionView[])[] = [];
  let closes = 0;
  const mounted = await mount(
    <BulkStopConfirmation
      request={request()}
      sessions={fleet}
      onClose={() => {
        closes += 1;
      }}
      onConfirm={() => confirmed.push('confirm')}
      onConfirmNew={targets => reviewed.push(targets)}
      {...overrides}
    />,
  );
  return { ...mounted, confirmed, reviewed, closes: () => closes };
};

const text = (container: HTMLElement): string => container.textContent ?? '';

const button = (container: HTMLElement, label: string): HTMLButtonElement => {
  const found = [...container.querySelectorAll('button')].find(element => element.textContent?.trim() === label);
  if (!found)
    throw new Error(
      `no button labelled ${label}: ${[...container.querySelectorAll('button')].map(b => b.textContent).join(' | ')}`,
    );
  return found as HTMLButtonElement;
};

const rows = (container: HTMLElement, label: string): readonly string[] => {
  const list = container.querySelector(`ul[aria-label="${label}"]`);
  if (!list) throw new Error(`no list labelled ${label}`);
  return [...list.querySelectorAll('li')].map(item => item.textContent ?? '');
};

describe('stopTargetName', () => {
  it('names a session by its display callsign, because that is what the fleet is discussed in', () => {
    // The callsign wins over the name, and it arrives Title-cased rather than
    // in the raw lowercase form the app routes and ranks on.
    expect(stopTargetName(lead)).toBe('Nero');
  });

  it('falls back to the name and then the id so a target is never anonymous', () => {
    expect(stopTargetName(sessionView('x-1', { config: { name: 'Named', teammate: undefined } }))).toBe('Named');
    expect(stopTargetName(sessionView('x-2', { config: { name: '', teammate: undefined } }))).toBe('x-2');
  });
});

describe('BulkStopConfirmation', () => {
  it('renders nothing at all when there is no request', async () => {
    const view = await render({ request: null });
    expect(view.container.innerHTML).toBe('');
    await view.unmount();
  });

  it('lists every target by name and id rather than a reassuring count', async () => {
    const view = await render();
    const listed = rows(view.container, 'Sessions to stop');
    expect(listed).toHaveLength(2);
    expect(listed[0]).toContain('lead-1');
    expect(listed[1]).toContain('Child One');
    expect(text(view.container)).toContain('Stop these 2 sessions?');
    await view.unmount();
  });

  it('says "session" in the singular so a one-target sweep does not read like a bug', async () => {
    const view = await render({ request: request({ targets: [child] }) });
    expect(text(view.container)).toContain('Stop these 1 session?');
    expect(button(view.container, 'Stop 1')).toBeTruthy();
    await view.unmount();
  });

  it('warns, in its own block, when the session being viewed is itself in the sweep', async () => {
    const view = await render({ activeId: 'child-1' });
    expect(text(view.container)).toContain('Current session is included and will be stopped.');
    await view.unmount();
  });

  it('flags targets that are ancestors of the viewed session without claiming it is included', async () => {
    const view = await render({ activeId: 'grand-1' });
    const listed = rows(view.container, 'Sessions to stop');
    expect(listed[0]).toContain('Current-session ancestor');
    expect(listed[1]).toContain('Current-session ancestor');
    expect(text(view.container)).not.toContain('Current session is included');
    await view.unmount();
  });

  it('leads an orphan stop with the one session to stop and the descendants left alive', async () => {
    const view = await render({
      request: request({ scope: 'orphan', targets: [lead], orphanedDescendants: [child, grandchild] }),
    });
    expect(text(view.container)).toContain('Session to stop:');
    expect(text(view.container)).toContain('Live descendants left running / parentless (2)');
    expect(view.container.querySelector('ul[aria-label="Sessions to stop"]')).toBeNull();
    await view.unmount();
  });

  it('says so explicitly when an orphan stop leaves nothing behind', async () => {
    const view = await render({ request: request({ scope: 'orphan', targets: [grandchild] }) });
    expect(text(view.container)).toContain('No descendants will be orphaned.');
    await view.unmount();
  });

  it('marks an orphan target that is an ancestor of the viewed session', async () => {
    const view = await render({
      request: request({ scope: 'orphan', targets: [lead], orphanedDescendants: [child] }),
      activeId: 'grand-1',
    });
    expect(text(view.container)).toContain('Current-session ancestor');
    await view.unmount();
  });

  it('confirms and cancels through the two footer buttons', async () => {
    const view = await render();
    await interact(() => button(view.container, 'Stop 2').click());
    expect(view.confirmed).toEqual(['confirm']);
    await interact(() => button(view.container, 'Cancel').click());
    expect(view.closes()).toBe(1);
    await view.unmount();
  });

  it('cannot confirm a sweep with no targets left to hit', async () => {
    const view = await render({ request: request({ targets: [] }) });
    expect(button(view.container, 'Stop 0').disabled).toBe(true);
    await view.unmount();
  });

  it('refuses to be dismissed while the sweep is in flight, because the requests cannot be recalled', async () => {
    const view = await render({ request: request({ running: true }) });
    await interact(() => button(view.container, 'Refreshing…').click());
    expect(view.confirmed).toEqual([]);
    const scrim = view.container.querySelector<HTMLButtonElement>('button[aria-label="Close stop confirmation"]')!;
    expect(scrim.disabled).toBe(true);
    await interact(() => scrim.click());
    expect(view.closes()).toBe(0);
    await view.unmount();
  });

  it('ignores Escape while running and honours it once the report is on screen', async () => {
    let closes = 0;
    const dialog = (running: boolean) => (
      <BulkStopConfirmation
        request={request(running ? { running: true } : { outcomes: [] })}
        sessions={fleet}
        onClose={() => {
          closes += 1;
        }}
        onConfirm={() => {}}
        onConfirmNew={() => {}}
      />
    );
    const view = await mount(dialog(true));
    await interact(() => pressKey(document, 'Escape'));
    expect(closes).toBe(0);
    await view.render(dialog(false));
    await interact(() => pressKey(document, 'Escape'));
    expect(closes).toBe(1);
    await view.unmount();
  });

  it('reports each outcome as stopped or failed with its detail', async () => {
    const view = await render({
      request: request({
        outcomes: [
          { id: 'lead-1', name: 'Fleet Lead', ok: true },
          { id: 'child-1', name: 'Child One', ok: false, detail: 'already exited' },
        ],
      }),
    });
    const listed = rows(view.container, 'Stop outcomes');
    expect(listed[0]).toContain('Stopped');
    expect(listed[1]).toContain('Failed');
    expect(listed[1]).toContain('already exited');
    expect(button(view.container, 'Close')).toBeTruthy();
    expect([...view.container.querySelectorAll('button')].map(b => b.textContent)).not.toContain('Stop 2');
    await view.unmount();
  });

  it('titles itself as a confirmation before the sweep and as results after it', async () => {
    const view = await render();
    const title = () => view.container.querySelector('#bulk-stop-title')?.textContent ?? '';
    expect(title()).toContain('confirm');
    await view.render(
      <BulkStopConfirmation
        request={request({ outcomes: [] })}
        sessions={fleet}
        onClose={() => {}}
        onConfirm={() => {}}
        onConfirmNew={() => {}}
      />,
    );
    expect(title()).toContain('results');
    await view.unmount();
  });

  it('reports sessions that started matching mid-sweep and sends them back for their own confirmation', async () => {
    const view = await render({
      request: request({ outcomes: [{ id: 'lead-1', name: 'Fleet Lead', ok: true }], newTargets: [grandchild] }),
    });
    expect(text(view.container)).toContain('1 newly appeared matching session was not stopped.');
    await interact(() => button(view.container, 'Review newly appeared sessions').click());
    expect(view.reviewed).toEqual([[grandchild]]);
    await view.unmount();
  });

  it('reports descendants that appeared mid-sweep and were left running', async () => {
    const view = await render({
      request: request({
        scope: 'orphan',
        targets: [lead],
        outcomes: [{ id: 'lead-1', name: 'Fleet Lead', ok: true }],
        newOrphanedDescendants: [child, grandchild],
      }),
    });
    expect(text(view.container)).toContain('2 newly appeared live descendants were left running.');
    expect(rows(view.container, 'Newly left running descendants')).toHaveLength(2);
    await view.unmount();
  });

  it('claims a modal contract and points its label at the title it renders', async () => {
    const view = await render();
    const dialog = view.container.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe('bulk-stop-title');
    expect(view.container.querySelector('#bulk-stop-title')).toBeTruthy();
    await view.unmount();
  });
});
