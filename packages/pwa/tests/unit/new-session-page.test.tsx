import type { StartSessionRequest } from '@ferretry/protocol';
import { describe, expect, it } from 'bun:test';
import type { ReactTestInstance } from 'react-test-renderer';

import { NewSessionPage, type NewSessionPageProps } from '../../src/components/new-session-page.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { render, run, runAsync } from '../support/react.ts';

const connection = daemonConnection({
  daemonId: 'daemon/a',
  baseUrl: 'https://daemon.example.test',
  deviceToken: 'device-token',
});

const page = (overrides: Partial<NewSessionPageProps> = {}) => {
  const navigated: string[] = [];
  const starts: Array<{ connection: typeof connection; request: StartSessionRequest }> = [];
  const props: NewSessionPageProps = {
    connection,
    startSession: async (target, request) => {
      starts.push({ connection: target, request });
      return { config: { id: 'new/session' } };
    },
    onNavigate: path => navigated.push(path),
    ...overrides,
  };
  return { navigated, starts, view: render(<NewSessionPage {...props} />) };
};

const input = (view: ReturnType<typeof render>, id: string): ReactTestInstance => view.root.findByProps({ id });

const change = (view: ReturnType<typeof render>, id: string, value: string): void => {
  run(() => input(view, id).props.onChange({ target: { value } }));
};

const button = (view: ReturnType<typeof render>, label: string): ReactTestInstance => {
  const found = view.root.findAll(node => node.type === 'button' && node.children.join('') === label).at(0);
  if (found === undefined) throw new Error(`missing button ${label}`);
  return found;
};

describe('NewSessionPage', () => {
  it('renders the original free-text fallback and keeps auto creation disabled until agent and prompt are present', () => {
    const { view } = page();

    expect(view.root.findByProps({ id: 'new-session-heading' }).children.join('')).toBe('New session');
    expect(input(view, 'fy-new-session-agent').props.placeholder).toBe('claude-auto-loge');
    expect(input(view, 'fy-new-session-cwd').props.placeholder).toBe('/absolute/path/to/project');
    expect(input(view, 'fy-new-session-prompt').props.placeholder).toBe('Describe the task…');
    expect(button(view, 'Create session').props.disabled).toBeTrue();

    change(view, 'fy-new-session-agent', 'claude-auto-loge');
    change(view, 'fy-new-session-prompt', 'Port the page');

    expect(button(view, 'Create session').props.disabled).toBeFalse();
  });

  it('allows an interactive session without an opening message and changes the prompt copy with the mode', () => {
    const { view } = page();
    change(view, 'fy-new-session-agent', 'codex-auto-loge');

    run(() => button(view, 'interactive').props.onClick());

    expect(input(view, 'fy-new-session-prompt').props.placeholder).toBe('(optional) first message…');
    expect(JSON.stringify(view.toJSON())).toContain('Opening message (optional)');
    expect(button(view, 'Create session').props.disabled).toBeFalse();
  });

  it('starts only through the explicit paired connection and navigates to the daemon-scoped session path', async () => {
    const { navigated, starts, view } = page();
    change(view, 'fy-new-session-agent', ' claude-auto-loge ');
    change(view, 'fy-new-session-cwd', ' /work/ferretry ');
    change(view, 'fy-new-session-prompt', ' Port PWA pages ');

    await runAsync(async () => {
      button(view, 'Create session').props.onClick();
      await Promise.resolve();
    });

    expect(starts).toEqual([
      {
        connection,
        request: {
          agent: 'claude-auto-loge',
          boardAccess: 'none',
          cwd: '/work/ferretry',
          mode: 'auto',
          prompt: 'Port PWA pages',
        },
      },
    ]);
    expect(navigated).toEqual(['/d/daemon%2Fa/session/new%2Fsession']);
  });

  it('shows a daemon failure and makes the form actionable again', async () => {
    const { view } = page({ startSession: async () => Promise.reject(new Error('daemon refused start')) });
    change(view, 'fy-new-session-agent', 'claude-auto-loge');
    change(view, 'fy-new-session-prompt', 'Port PWA pages');

    await runAsync(async () => {
      button(view, 'Create session').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(view.root.findByProps({ role: 'alert' }).children.join('')).toBe('daemon refused start');
    expect(button(view, 'Create session').props.disabled).toBeFalse();
  });

  it('returns to the current daemon sessions list for both back and cancel', () => {
    const { navigated, view } = page();

    run(() => button(view, '← Sessions').props.onClick());
    run(() => button(view, 'Cancel').props.onClick());

    expect(navigated).toEqual(['/d/daemon%2Fa', '/d/daemon%2Fa']);
  });
});
