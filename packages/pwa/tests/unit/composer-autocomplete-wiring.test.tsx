import { expect, test } from 'bun:test';
import { Composer, type ComposerProps } from '../../src/components/composer.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { render, run } from '../support/react.ts';

test('Composer forwards textarea selection changes to its autocomplete controller', () => {
  const view = render(
    <Composer
      api={{ send: async () => undefined } as unknown as ComposerProps['api']}
      daemon={daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceToken: 'token' })}
      sessionId="session-a"
    />,
  );
  const textarea = view.root.findByType('textarea');
  run(() => textarea.props.onChange({ currentTarget: { value: '/', selectionStart: 1, selectionEnd: 1 } }));
  run(() => textarea.props.onSelect({ currentTarget: { selectionStart: 1, selectionEnd: 1 } }));
  expect(view.root.findByType('textarea').props['aria-expanded']).toBe(true);
  run(() => view.unmount());
});
