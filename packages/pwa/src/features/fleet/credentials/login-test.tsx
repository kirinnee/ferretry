/**
 * The **Test** of an environment login (docs/provider-presets.md): one request, the cheapest its
 * provider allows, and the daemon's one-sentence answer. A provider with no free check is tested with
 * one token, so the button asks first — inline, never a dialog — and only then sends `allowInference`.
 *
 * A Test is the owner's act: it never runs on load or on a timer.
 */

import type { FleetCredentialTestAct, FleetCredentialTestResult } from '@ferretry/protocol';
import { FlaskConical } from 'lucide-react';
import { useState } from 'react';
import type { DaemonConnection } from '../../../lib/daemon-connection.ts';
import { Badge, Button } from '../../../shell/primitives.tsx';
import { testFleetCredential } from '../credentials-api.ts';
import type { FleetClientFactory } from '../fleet-client.ts';
import { changeRefusalSentence } from '../shell/apply-change.ts';
import { TEST_CONSENT, testNote, testResultLine } from './environment-model.ts';

export interface LoginTestProps {
  readonly credentialId: string;
  readonly act: FleetCredentialTestAct;
  readonly connection: DaemonConnection;
  readonly createClient: FleetClientFactory;
  readonly disabled?: boolean;
}

export function LoginTest({ credentialId, act, connection, createClient, disabled = false }: LoginTestProps) {
  const [asking, setAsking] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<FleetCredentialTestResult | null>(null);
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
      const client = await createClient(connection);
      setResult(await testFleetCredential(client, credentialId, allowInference ? { allowInference: true } : {}));
    } catch (error) {
      setResult(null);
      setFailure(changeRefusalSentence(error));
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
