import { describe, expect, test } from 'bun:test';
import { createRef } from 'react';
import type { ReactTestRenderer } from 'react-test-renderer';
import {
  ComposerHighlight,
  highlightReferenceTokens,
  syncComposerHighlightViewport,
} from '../../src/components/composer-highlight.tsx';
import { Composer } from '../../src/components/composer.tsx';
import { tokenizeMarkdown } from '../../src/lib/composer-markdown.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { DaemonDraftStore, type DraftStorage } from '../../src/lib/drafts.ts';
import { readMdComposePref, writeMdComposePref } from '../../src/lib/md-compose.ts';
import { render, run } from '../support/react.ts';

const daemon = daemonConnection({
  daemonId: 'daemon-a',
  baseUrl: 'https://daemon-a.example.test',
  deviceToken: 'token-a',
});

class MemoryStorage implements DraftStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

/** Every painted span, in order — the overlay's whole observable output. */
const painted = (renderer: ReactTestRenderer): readonly { token: string; text: string }[] =>
  renderer.root
    .findAllByType('span')
    .filter(node => node.props['data-md-token'] !== undefined)
    .map(node => ({
      token: String(node.props['data-md-token']),
      text: node.children.filter((child): child is string => typeof child === 'string').join(''),
    }));

/** Flips the reader preference for one body and puts it back afterwards. */
const withMarkdownComposer = (pref: 'on' | 'off', body: () => void): void => {
  const previous = readMdComposePref();
  writeMdComposePref(pref);
  try {
    body();
  } finally {
    writeMdComposePref(previous);
  }
};

describe('highlightReferenceTokens', () => {
  test('should split a reference out of a paint token without changing the bytes', () => {
    // Arrange
    const text = 'ping :zelda now';

    // Act
    const tokens = highlightReferenceTokens(tokenizeMarkdown(text));

    // Assert
    expect(tokens).toEqual([
      { type: 'text', text: 'ping ' },
      { type: 'reference', text: ':zelda' },
      { type: 'text', text: ' now' },
    ]);
    expect(tokens.map(token => token.text).join('')).toBe(text);
  });

  test('should split a reference that opens the token with no leading fragment', () => {
    // Act
    const tokens = highlightReferenceTokens(tokenizeMarkdown('&F12 first'));

    // Assert
    expect(tokens).toEqual([
      { type: 'reference', text: '&F12' },
      { type: 'text', text: ' first' },
    ]);
  });

  test('should split a reference that closes the token with no trailing fragment', () => {
    // Act
    const tokens = highlightReferenceTokens(tokenizeMarkdown('see !A3'));

    // Assert
    expect(tokens).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'reference', text: '!A3' },
    ]);
  });

  test('should carry the reference colour into emphasis but not into code', () => {
    // Act
    const emphasised = highlightReferenceTokens(tokenizeMarkdown('**ping :zelda**'));
    const code = highlightReferenceTokens(tokenizeMarkdown('`ping :zelda`'));

    // Assert — emphasis is eligible, an inline code span is not.
    expect(emphasised.map(token => token.type)).toEqual(['mark', 'bold', 'reference', 'mark']);
    expect(code.map(token => token.type)).toEqual(['inlineCode']);
  });

  test('should leave a token without references untouched', () => {
    // Act
    const tokens = highlightReferenceTokens(tokenizeMarkdown('nothing to see here'));

    // Assert
    expect(tokens).toEqual([{ type: 'text', text: 'nothing to see here' }]);
  });
});

describe('syncComposerHighlightViewport', () => {
  const port = (overflowX: string, overflowY: string, scrollTop: number, scrollLeft: number) => ({
    scrollTop,
    scrollLeft,
    style: { overflowX, overflowY },
  });

  test('should mirror both axes and the vertical overflow mode', () => {
    // Arrange
    const input = port('scroll', 'scroll', 42, 7);
    const overlay = port('', '', 0, 0);

    // Act
    syncComposerHighlightViewport(input, overlay);

    // Assert
    expect(overlay).toEqual(port('scroll', 'scroll', 42, 7));
  });

  test('should fall back to the composer defaults when the input states no overflow mode', () => {
    // Arrange
    const overlay = port('scroll', 'scroll', 9, 9);

    // Act
    syncComposerHighlightViewport(port('', '', 3, 4), overlay);

    // Assert
    expect(overlay).toEqual(port('auto', 'hidden', 3, 4));
  });

  test('should do nothing when the overlay has not mounted', () => {
    // Act & Assert — the paint layer is optional; the input is never touched.
    expect(() => syncComposerHighlightViewport(port('auto', 'hidden', 1, 1), null)).not.toThrow();
  });
});

describe('ComposerHighlight', () => {
  test('should paint every markdown token with the text the reader typed', () => {
    // Act
    const overlay = render(
      <ComposerHighlight overlayRef={createRef<HTMLDivElement>()} text={'# Title\n- item `code` :zelda'} />,
    );

    // Assert
    expect(painted(overlay)).toEqual([
      { token: 'heading', text: '# Title' },
      { token: 'text', text: '\n' },
      { token: 'listMarker', text: '- ' },
      { token: 'text', text: 'item ' },
      { token: 'inlineCode', text: '`code`' },
      { token: 'text', text: ' ' },
      { token: 'reference', text: ':zelda' },
    ]);
  });

  test('should stay mounted but paint nothing when the preference is off', () => {
    // Act
    const overlay = render(
      <ComposerHighlight enabled={false} overlayRef={createRef<HTMLDivElement>()} text="**bold**" />,
    );

    // Assert — the element must survive so enabling cannot remount the real input.
    expect(overlay.root.findByProps({ className: 'fy-composer-highlight' }).props.hidden).toBe(true);
    expect(painted(overlay)).toEqual([]);
  });

  test('should give a trailing newline its own caret row', () => {
    // Act
    const withBreak = render(<ComposerHighlight overlayRef={createRef<HTMLDivElement>()} text={'line\n'} />);
    const withoutBreak = render(<ComposerHighlight overlayRef={createRef<HTMLDivElement>()} text="line" />);

    // Assert — a zero-width occupant, present only in the aria-hidden mirror.
    expect(withBreak.root.findAllByProps({ 'data-composer-trailing-line': '' })).toHaveLength(1);
    expect(withoutBreak.root.findAllByProps({ 'data-composer-trailing-line': '' })).toHaveLength(0);
  });

  test('should stay out of the accessibility tree and out of pointer reach', () => {
    // Act
    const overlay = render(<ComposerHighlight overlayRef={createRef<HTMLDivElement>()} text="anything" />);

    // Assert
    expect(overlay.root.findByProps({ className: 'fy-composer-highlight' }).props['aria-hidden']).toBe('true');
  });
});

describe('Composer markdown highlighting', () => {
  const composer = () => (
    <Composer
      api={{ send: async () => ({}) as never }}
      daemon={daemon}
      draftStore={new DaemonDraftStore(new MemoryStorage())}
      sessionId="highlight-id"
    />
  );

  test('should paint the draft behind the textarea when the reader turned highlighting on', () => {
    withMarkdownComposer('on', () => {
      // Arrange
      const rendered = render(composer());

      // Act
      run(() => rendered.root.findByType('textarea').props.onChange({ currentTarget: { value: '**hi** :zelda' } }));

      // Assert — the same bytes the textarea holds, painted token by token.
      expect(rendered.root.findByProps({ className: 'fy-composer-input-layer' }).props['data-highlighted']).toBe(
        'true',
      );
      expect(
        painted(rendered)
          .map(token => token.text)
          .join(''),
      ).toBe('**hi** :zelda');
      expect(painted(rendered).map(token => token.token)).toEqual(['mark', 'bold', 'mark', 'text', 'reference']);
    });
  });

  test('should keep the textarea plain when the reader left highlighting off', () => {
    withMarkdownComposer('off', () => {
      // Act
      const rendered = render(composer());

      // Assert
      expect(rendered.root.findByProps({ className: 'fy-composer-input-layer' }).props['data-highlighted']).toBe(
        'false',
      );
      expect(rendered.root.findByProps({ className: 'fy-composer-highlight' }).props.hidden).toBe(true);
    });
  });

  test('should mirror the textarea viewport on scroll without touching its selection', () => {
    withMarkdownComposer('on', () => {
      // Arrange
      const rendered = render(composer());
      const overlay = { scrollTop: 0, scrollLeft: 0, style: { overflowX: '', overflowY: '' } };
      const layerRef = rendered.root.findByProps({ className: 'fy-composer-highlight' });
      // The renderer has no DOM, so stand the paint layer in by hand.
      (layerRef.props.ref as { current: unknown }).current = overlay;

      // Act
      run(() =>
        rendered.root
          .findByType('textarea')
          .props.onScroll({ currentTarget: { scrollTop: 24, scrollLeft: 5, style: { overflowX: '', overflowY: '' } } }),
      );

      // Assert
      expect(overlay).toEqual({ scrollTop: 24, scrollLeft: 5, style: { overflowX: 'auto', overflowY: 'hidden' } });
    });
  });
});
