/**
 * One line of this panel is a truth claim rather than a label: which model this
 * session is ACTUALLY answering with.
 *
 * A runtime switch is a request, and a harness may decline it, ignore it, or
 * apply it on the next turn. If the panel reads the configured value first, a
 * declined switch looks like a successful one and the reader has no other place
 * to find out. So observed wins, exactly as the CLI reads it.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { ReactTestRenderer } from 'react-test-renderer';
import { SessionDetails } from '../../src/components/session-details.tsx';
import { render, run } from '../support/react.ts';
import { sessionView } from '../support/sessions.ts';

/**
 * Every mount is unmounted, INCLUDING the ones a failing assertion skipped past.
 *
 * There is no teardown in the renderer itself, so a throw between `render` and
 * an `unmount` leaks the mount — and this repository's known failure mode is
 * that the leak fails an unrelated later test instead of this one, which sends
 * the next reader hunting in the wrong file.
 */
const renderers: ReactTestRenderer[] = [];

afterEach(() => {
  run(() => {
    for (const renderer of renderers.splice(0)) renderer.unmount();
  });
});

const mounted = (element: Parameters<typeof render>[0]): ReactTestRenderer => {
  const renderer = render(element);
  renderers.push(renderer);
  return renderer;
};

const detail = (view: ReturnType<typeof render>, label: string): string => {
  const term = view.root.findAll(node => node.type === 'dt' && node.children.includes(label))[0];
  if (term === undefined) throw new Error(`no detail labelled ${label}`);
  const values = view.root.findAll(node => node.type === 'dd');
  const terms = view.root.findAll(node => node.type === 'dt');
  return String(values[terms.indexOf(term)]?.children.join(''));
};

describe('SessionDetails model line', () => {
  test('shows what the harness reported, not what was requested', () => {
    const view = mounted(
      <SessionDetails
        daemonId="daemon-a"
        session={sessionView('session-a', {
          config: { model: 'gpt-5.6-terra', modelHint: 'gpt-5.6' },
          state: { observedModel: 'gpt-5.6-sol' },
        })}
      />,
    );

    // Configured intent never masks observed truth: this is the failed-switch case.
    expect(detail(view, 'Model')).toBe('gpt-5.6-sol');
  });

  test('falls back to the configured model, then to the hint, then says nothing', () => {
    const configured = mounted(
      <SessionDetails
        daemonId="daemon-a"
        session={sessionView('session-a', { config: { model: 'gpt-5.6-terra', modelHint: 'gpt-5.6' } })}
      />,
    );
    expect(detail(configured, 'Model')).toBe('gpt-5.6-terra');

    const hinted = mounted(
      <SessionDetails daemonId="daemon-a" session={sessionView('session-a', { config: { modelHint: 'gpt-5.6' } })} />,
    );
    expect(detail(hinted, 'Model')).toBe('gpt-5.6');

    const unknown = mounted(
      <SessionDetails daemonId="daemon-a" session={sessionView('session-a', { config: { modelHint: '' } })} />,
    );
    expect(detail(unknown, 'Model')).toBe('—');
  });
});
