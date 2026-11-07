/**
 * The **Test** of an environment login (docs/provider-presets.md): one request, the cheapest its provider allows, and
 * the daemon's one-sentence answer. A provider with no free check is tested with one token, so the button asks first —
 * inline, never a dialog — and only then sends `allowInference`.
 *
 * A Test is the owner's act: it never runs on load or on a timer.
 */

import { FlaskConical } from 'lucide-react';
import { useState } from 'react';
import type { LoginTestAct, LoginTestResult } from '../../contract/index.ts';
import { refusalSentence, type LoginsClient } from '../lib/client.ts';
import { testLogin } from '../lib/logins-api.ts';
import { TEST_CONSENT, testNote, testResultLine } from '../lib/logins-view.ts';
import { Badge, Button } from '../ui.ts';

export interface LoginTestProps {
  readonly loginId: string;
  readonly act: LoginTestAct;
  readonly client: LoginsClient;
  readonly disabled?: boolean;
}

export function LoginTest({ loginId, act, client, disabled = false }: LoginTestProps) {
  const [asking, setAsking] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<LoginTestResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  if (!act.available)
    return (
      <p className="m-0 text-cell leading-base text-muted" data-login-test="unavailable">
        No Test: {act.reason}
      </p>
    );

  const run = async (allowInference: boolean): Promise<void> => {
    setAsking(false);
    setTesting(true);
    setFailure(null);
    try {
      setResult(await testLogin(client, loginId, allowInference ? { allowInference: true } : {}));
    } catch (error) {
      setResult(null);
      setFailure(refusalSentence(error));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="flex flex-col gap-2" data-login-test="">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          data-login-test-run=""
          disabled={disabled || testing || asking}
          onClick={() => (act.spends === 'one-token' ? setAsking(true) : void run(false))}
        >
          <FlaskConical size={14} aria-hidden="true" />
          {testing ? 'Testing…' : 'Test'}
        </Button>
        {result === null ? (
          <span className="min-w-0 text-meta leading-base text-muted">{testNote(act)}</span>
        ) : result.ok ? (
          <Badge tone="ok" role="status" data-login-test-result="ok">
            {testResultLine(result)}
          </Badge>
        ) : (
          <span role="alert" className="min-w-0 text-meta leading-base text-err" data-login-test-result={result.code}>
            {testResultLine(result)}
          </span>
        )}
      </div>
      {asking ? (
        <div role="alert" className="kt-panel flex flex-col gap-2 p-panel" data-login-test-consent="">
          <p className="m-0 text-cell leading-base text-fg">{TEST_CONSENT}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="primary" data-login-test-send="" onClick={() => void run(true)}>
              Send one token
            </Button>
            <Button type="button" size="sm" data-login-test-cancel="" onClick={() => setAsking(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {failure === null ? null : (
        <p role="alert" className="m-0 text-meta leading-base text-err" data-login-test-failure="">
          {failure}
        </p>
      )}
    </div>
  );
}
