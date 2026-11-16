import { afterEach, beforeEach, expect, test } from 'bun:test';
import { writeMdComposePref } from '@ferretry/app';
import { ensureDom, render, run } from '@ferretry/app/testing';
import { Composer, type ComposerProps } from '../../../../app/composer/composer.tsx';
import { daemonConnection } from '../../../../app/composer/seam.ts';

ensureDom();

// The general composer behaviour is one key arbitration for every editor style; these suites drive it
// through the Plain textarea. The live editor (Markdown and Rich text) has its own suites.
beforeEach(() => writeMdComposePref('off'));
afterEach(() => writeMdComposePref('on'));

// This wiring assertion never needs a daemon catalog: drawn outside a surface, every read the composer makes is refused.
test('Composer forwards textarea selection changes to its autocomplete controller', () => {
  const view = render(
    <Composer
      api={{ send: async () => undefined } as unknown as ComposerProps['api']}
      daemon={daemonConnection('daemon-a')}
      ferretId="ferret-a"
    />,
  );
  const textarea = view.root.findByType('textarea');
  run(() => textarea.props.onChange({ currentTarget: { value: '/', selectionStart: 1, selectionEnd: 1 } }));
  run(() => textarea.props.onSelect({ currentTarget: { selectionStart: 1, selectionEnd: 1 } }));
  expect(view.root.findByType('textarea').props['aria-expanded']).toBe(true);
  run(() => view.unmount());
});
