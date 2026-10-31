import type { BrowserProxyErrorClass, BrowserProxyTestResult } from '@ferretry/protocol';
import { SetupNote } from '../setup/setup-ui.tsx';

/** What a failed test is called, in plain words. The daemon's own sentence follows it. */
export const PROXY_ERROR_WORDS: Readonly<Record<BrowserProxyErrorClass, string>> = {
  dns: 'Name not found (DNS)',
  connect: 'Connection failed',
  auth: 'Sign-in refused (407)',
  tls: 'Secure connection failed (TLS)',
  timeout: 'Timed out',
  proxy: 'Proxy refused',
  secret: 'Missing secret',
  'no-proxy': 'Nothing to test',
  other: 'Test failed',
};

const testedWords = (tested: BrowserProxyTestResult['tested']): string =>
  tested === 'saved' ? 'Tested the saved proxy.' : 'Tested the proxy you are editing. It is not saved.';

/** What the test found, or why it did not run. Spoken when it appears. */
export type ProxyTestShown =
  | { readonly kind: 'result'; readonly result: BrowserProxyTestResult }
  | { readonly kind: 'refused'; readonly sentence: string };

export function BrowserProxyTestResultNote({ shown }: { readonly shown: ProxyTestShown }) {
  if (shown.kind === 'refused')
    return (
      <SetupNote live tone="warn" name="browser-proxy-test" title="The test didn’t run">
        <span data-browser-proxy-test-refusal="">{shown.sentence}</span>
      </SetupNote>
    );
  const { result } = shown;
  if (result.reachable)
    return (
      <SetupNote live tone="ok" name="browser-proxy-test" title={`Reachable · ${String(result.roundTripMs)} ms`}>
        <span data-browser-proxy-test-egress="">
          Traffic leaves via <code className="break-all font-mono text-fg">{result.egressIp}</code>
        </span>
        <span>{result.message}</span>
        <span data-browser-proxy-test-tested="">{testedWords(result.tested)}</span>
      </SetupNote>
    );
  return (
    <SetupNote live tone="err" name="browser-proxy-test" title={PROXY_ERROR_WORDS[result.errorClass]}>
      <span data-browser-proxy-test-class={result.errorClass}>{result.message}</span>
      {result.roundTripMs === undefined ? null : <span>Failed after {String(result.roundTripMs)} ms.</span>}
      <span data-browser-proxy-test-tested="">{testedWords(result.tested)}</span>
    </SetupNote>
  );
}
