import { afterEach, describe, expect, test } from 'bun:test';
import type { ReactTestRenderer } from 'react-test-renderer';
import { Composer, ComposerMarkdownPreview } from '../../src/components/composer.tsx';
import { ReferenceSurfaceProvider } from '../../src/components/reference-surface.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { readMdComposePref, writeMdComposePref } from '../../src/lib/md-compose.ts';
import { render, run, runAsync } from '../support/react.ts';

/** The preview is deferred so a phone does not re-parse Markdown per keystroke.
 *  Waiting for it is what a reader does too; this just does it deliberately. */
const settlePreview = async (): Promise<void> => {
  await runAsync(async () => {
    await new Promise(resolve => setTimeout(resolve, 260));
  });
};

const type = (view: ReactTestRenderer, value: string): void => {
  run(() =>
    view.root
      .findByType('textarea')
      .props.onChange({ currentTarget: { value, selectionStart: value.length, selectionEnd: value.length } }),
  );
};

const originalMarkdownPreference = readMdComposePref();

afterEach(() => writeMdComposePref(originalMarkdownPreference));

const daemon = daemonConnection({
  daemonId: 'daemon-a',
  baseUrl: 'https://daemon-a.example.test',
  deviceToken: 'token-a',
});

describe('ComposerMarkdownPreview', () => {
  test('renders Markdown in a named, bounded reader', () => {
    const view = render(<ComposerMarkdownPreview text={'## Preview title\n\n**bold**'} />);

    const preview = view.root.findByProps({ 'data-composer-markdown-preview': '' });
    expect(preview.props['aria-label']).toBe('Rendered Markdown preview');
    expect(preview.props.className).toContain('max-w-full');
    expect(view.root.findByType('h2').children).toEqual(['Preview title']);
    expect(view.root.findByType('strong').children).toEqual(['bold']);
  });

  test('renders nothing for a blank draft', () => {
    const view = render(
      <div>
        <ComposerMarkdownPreview text={'  \n'} />
      </div>,
    );

    expect(view.root.findAllByProps({ 'data-composer-markdown-preview': '' })).toHaveLength(0);
  });
});

describe('Composer Markdown preview wiring', () => {
  test('uses the session reference surface without replacing the textarea', async () => {
    writeMdComposePref('on');
    const view = render(
      <ReferenceSurfaceProvider
        surface={{
          agentReferenceResolver: lookup =>
            lookup.name?.toLowerCase() === 'valentine'
              ? { daemonId: daemon.daemonId, sessionId: 'session-b', name: 'valentine' }
              : null,
          onNavigate: () => {},
        }}
      >
        <Composer api={{ send: async () => undefined } as never} daemon={daemon} sessionId="session-a" />
      </ReferenceSurfaceProvider>,
    );

    type(view, '**hello** :valentine');
    // Deferred: the reader is still typing, so nothing has been re-rendered yet.
    expect(view.root.findAllByProps({ 'data-composer-markdown-preview': '' })).toHaveLength(0);
    await settlePreview();

    expect(view.root.findAllByType('textarea')).toHaveLength(1);
    expect(view.root.findByProps({ 'data-composer-markdown-preview': '' })).toBeDefined();
    expect(view.root.findAllByProps({ 'data-fy-reference': 'agent:daemon-a:session-b' }).length).toBeGreaterThan(0);
    // The same token proved in the same way, in the compact strip beside it.
    const strip = view.root.findByProps({ 'data-composer-reference-strip': '' });
    expect(strip.props['aria-label']).toBe('References in this message');
    expect(view.root.findAllByProps({ 'data-fy-reference': 'agent:daemon-a:session-b' }).length).toBeGreaterThan(1);
  });

  test('empties the preview immediately when the draft is cleared, without waiting', async () => {
    writeMdComposePref('on');
    const view = render(
      <Composer api={{ send: async () => undefined } as never} daemon={daemon} sessionId="session-a" />,
    );

    type(view, '# leftover from the previous session');
    await settlePreview();
    expect(view.root.findAllByProps({ 'data-composer-markdown-preview': '' })).toHaveLength(1);

    // A reset is not a slow update: showing the previous draft rendered under a
    // new empty one is exactly the stale state the debounce must not create.
    type(view, '');
    expect(view.root.findAllByProps({ 'data-composer-markdown-preview': '' })).toHaveLength(0);
  });

  test('never paints another session’s draft, in the textarea or in the preview', async () => {
    writeMdComposePref('on');
    const view = render(
      <Composer api={{ send: async () => undefined } as never} daemon={daemon} sessionId="session-a" />,
    );

    type(view, 'words that belong to session A @src/api.ts');
    await settlePreview();
    expect(view.root.findAllByProps({ 'data-composer-markdown-preview': '' })).toHaveLength(1);

    // The state reset for a new session happens in an effect, which runs AFTER
    // the commit — so this is the render where a plain `useState` would still
    // be holding session A's words, and paint them under session B's name.
    run(() =>
      view.update(<Composer api={{ send: async () => undefined } as never} daemon={daemon} sessionId="session-b" />),
    );

    expect(view.root.findByType('textarea').props.value).toBe('');
    expect(view.root.findAllByProps({ 'data-composer-markdown-preview': '' })).toHaveLength(0);
    expect(view.root.findAllByProps({ 'data-composer-reference-strip': '' })).toHaveLength(0);
  });

  test('gives the remove control its own 44px box rather than one that overlaps its neighbour', () => {
    const view = render(
      <Composer api={{ send: async () => undefined } as never} daemon={daemon} sessionId="session-a" />,
    );

    type(view, 'see @src/a.ts and @src/b.ts');

    const removes = view.root.findAll(node => String(node.props['aria-label'] ?? '').startsWith('Remove @'));
    expect(removes).toHaveLength(2);
    for (const button of removes) {
      const className = String(button.props.className);
      // A real box, not a pseudo-element reaching into the chip beside it: two
      // adjacent removals must not share pixels.
      expect(className).toContain('h-[44px]');
      expect(className).toContain('w-[44px]');
      expect(className).not.toContain('-inset-');
    }
  });

  test('renders authored HTML as text rather than as markup, in the preview and in the strip', async () => {
    writeMdComposePref('on');
    const view = render(
      <Composer api={{ send: async () => undefined } as never} daemon={daemon} sessionId="session-a" />,
    );

    type(view, '<img src=x onerror="alert(1)"> and @src/api.ts');
    await settlePreview();

    // The shared renderer never executes authored HTML; it is prose here too.
    expect(view.root.findAllByType('img')).toHaveLength(0);
    // And an unproved reference stays plain text rather than becoming a link:
    // the strip shows the same honest state the transcript would.
    expect(view.root.findAllByProps({ 'data-composer-reference': '@src/api.ts' })).toHaveLength(1);
    expect(view.root.findAllByProps({ 'data-fy-reference': 'file:src/api.ts::' })).toHaveLength(0);
  });

  test('removes exactly the token bytes a chip names, leaving the prose around it', () => {
    const view = render(
      <Composer api={{ send: async () => undefined } as never} daemon={daemon} sessionId="session-a" />,
    );

    type(view, 'see @src/api.ts and @src/api.ts again');
    // Duplicates are kept apart on purpose: two tokens are two removals.
    const chips = view.root.findAllByProps({ 'data-composer-reference': '@src/api.ts' });
    expect(chips).toHaveLength(2);

    run(() => view.root.findAllByProps({ 'aria-label': 'Remove @src/api.ts from this message' })[1]?.props.onClick());

    expect(view.root.findByType('textarea').props.value).toBe('see @src/api.ts and  again');
  });

  test('keeps the preview absent when Markdown composition is off', () => {
    writeMdComposePref('off');
    const view = render(
      <Composer api={{ send: async () => undefined } as never} daemon={daemon} sessionId="session-a" />,
    );
    const textarea = view.root.findByType('textarea');

    run(() =>
      textarea.props.onChange({ currentTarget: { value: '# still editable', selectionStart: 16, selectionEnd: 16 } }),
    );

    expect(view.root.findAllByProps({ 'data-composer-markdown-preview': '' })).toHaveLength(0);
    expect(view.root.findByType('textarea').props.value).toBe('# still editable');
  });
});
