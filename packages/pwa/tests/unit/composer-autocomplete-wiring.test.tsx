import { afterEach, beforeEach, expect, test } from 'bun:test';
import { type ComposerProps, Composer as ProductionComposer } from '../../src/components/composer.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import type { DaemonFetch } from '../../src/lib/runtime-models.ts';
import { render, run } from '../support/react.ts';
import { writeMdComposePref } from '../../src/lib/md-compose.ts';

// The general composer behaviour is one key arbitration for every editor style; these suites drive it
// through the Plain textarea. The live editor (Markdown and Rich text) has its own suites.
beforeEach(() => writeMdComposePref('off'));
afterEach(() => writeMdComposePref('on'));

/** This wiring assertion never needs a real daemon catalog. */
const autocompleteFetch: DaemonFetch = async () => Response.json({}, { status: 500 });
const Composer = (props: ComposerProps) => <ProductionComposer {...props} autocompleteFetcher={autocompleteFetch} />;

test('Composer forwards textarea selection changes to its autocomplete controller', () => {
  const view = render(
    <Composer
      api={{ send: async () => undefined } as unknown as ComposerProps['api']}
      daemon={daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceId: 'token' })}
      sessionId="session-a"
    />,
  );
  const textarea = view.root.findByType('textarea');
  run(() => textarea.props.onChange({ currentTarget: { value: '/', selectionStart: 1, selectionEnd: 1 } }));
  run(() => textarea.props.onSelect({ currentTarget: { selectionStart: 1, selectionEnd: 1 } }));
  expect(view.root.findByType('textarea').props['aria-expanded']).toBe(true);
  run(() => view.unmount());
});
