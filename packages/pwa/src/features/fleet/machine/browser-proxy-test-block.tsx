import { Button } from '../../../shell/primitives.tsx';
import { BrowserProxyTestResultNote, type ProxyTestShown } from './browser-proxy-test-result.tsx';

export interface BrowserProxyTestBlockProps {
  readonly disabled: boolean;
  readonly testing: boolean;
  readonly hint: string;
  readonly shown: ProxyTestShown | null;
  readonly onTest: () => void;
}

/** "Test proxy": the button, what it is doing, what it will try, and what it found. Holds no state. */
export function BrowserProxyTestBlock({ disabled, testing, hint, shown, onTest }: BrowserProxyTestBlockProps) {
  return (
    <div className="flex min-w-0 flex-col gap-2" data-browser-proxy-test-block="">
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" data-browser-proxy-test="" disabled={disabled || testing} onClick={onTest}>
          Test proxy
        </Button>
        {testing ? (
          <p role="status" className="m-0 text-meta leading-base text-muted" data-browser-proxy-testing="">
            Testing the proxy…
          </p>
        ) : null}
      </div>
      <p className="m-0 text-meta leading-base text-muted" data-browser-proxy-test-hint="">
        {hint}
      </p>
      {shown === null ? null : <BrowserProxyTestResultNote shown={shown} />}
    </div>
  );
}
