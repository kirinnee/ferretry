import type { ReactNode } from 'react';
import { Button } from '../../../shell/primitives.tsx';
import { BrowserProxyTestResultNote, type ProxyTestShown } from './browser-proxy-test-result.tsx';

export interface BrowserProxyTestBlockProps {
  readonly disabled: boolean;
  readonly testing: boolean;
  readonly hint: string;
  readonly shown: ProxyTestShown | null;
  readonly onTest: () => void;
  /** The proxy's credential fields: the Test proxy button sits beside them from the tablet width. */
  readonly fields?: ReactNode;
}

/** "Test proxy": the button, what it is doing, what it will try, and what it found. Holds no state. */
export function BrowserProxyTestBlock({ disabled, testing, hint, shown, onTest, fields }: BrowserProxyTestBlockProps) {
  return (
    <div className="flex min-w-0 flex-col gap-2" data-browser-proxy-test-block="">
      <div className="flex min-w-0 flex-col gap-2 md:flex-row md:items-end md:gap-3">
        {fields === undefined ? null : <div className="min-w-0 md:flex-1">{fields}</div>}
        <Button
          type="button"
          size="sm"
          className="w-fit shrink-0"
          data-browser-proxy-test=""
          disabled={disabled || testing}
          onClick={onTest}
        >
          Test proxy
        </Button>
      </div>
      {testing ? (
        <p role="status" className="m-0 text-meta leading-base text-muted" data-browser-proxy-testing="">
          Testing the proxy…
        </p>
      ) : null}
      <p className="m-0 text-meta leading-base text-muted" data-browser-proxy-test-hint="">
        {hint}
      </p>
      {shown === null ? null : <BrowserProxyTestResultNote shown={shown} />}
    </div>
  );
}
