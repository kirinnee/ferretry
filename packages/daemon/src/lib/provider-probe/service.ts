import type { Credential, ProviderPreset } from '@ferretry/fleet';
import type { FleetCredentialTestCode, FleetCredentialTestResult } from '@ferretry/protocol';
import type { AuthorizedOutcome } from '../speedups/ports.ts';
import { planProviderProbe } from './plan.ts';
import type { ProviderProbeClock, ProviderProbePort } from './ports.ts';

/**
 * A person's **Test** of an environment login (docs/provider-presets.md): one request, the cheapest
 * the provider allows, to prove the key works — and a code and a fixed sentence back, never the
 * provider's body.
 *
 * A TEST NEVER SPENDS WITHOUT BEING ASKED. A provider with a free authenticated read (a model list, a
 * balance) is tested with that. A provider with none is tested with one message capped at one output
 * token, and only when the request carries the person's consent (`allowInference`); without it the
 * answer is `consent_required` and nothing is sent.
 */

/** One fixed sentence per code. */
export const PROVIDER_TEST_MESSAGES: Readonly<Record<FleetCredentialTestCode, string>> = {
  ok: 'The provider accepted this login.',
  not_set: 'A secret this login needs is not in the secret store. Paste it and store it first.',
  rejected: 'The provider refused this key. Check it was copied whole, or make a new one.',
  rate_limited: 'The provider is rate limiting or busy right now. Try again in a minute.',
  timeout: 'The provider did not answer in time. Try again.',
  unreachable: 'This machine could not reach the provider. Check the address and the network connection.',
  provider_error: 'The provider answered with an error. Check the address and the model, then try again.',
  malformed: 'The provider answered with something unexpected.',
  vault_damaged: 'This machine’s secret store cannot be read, so the key could not be used.',
  consent_required:
    'This provider has no free check, so the Test sends one message capped at one token. Confirm to send it.',
  not_testable: 'This login cannot be tested here.',
  refused: 'The Test was not sent.',
};

/** What an outcome proved about the login. */
export function probeCode(outcome: AuthorizedOutcome): FleetCredentialTestCode {
  switch (outcome.kind) {
    case 'completion':
    case 'oversized':
      return 'ok';
    case 'unreadable':
      return 'malformed';
    case 'secret_missing':
      return 'not_set';
    case 'vault_damaged':
      return 'vault_damaged';
    case 'timeout':
      return 'timeout';
    case 'unreachable':
      return 'unreachable';
    case 'refused':
      return 'refused';
    default:
      if (outcome.status === 401 || outcome.status === 403) return 'rejected';
      if (outcome.status === 429 || outcome.status === 529) return 'rate_limited';
      return 'provider_error';
  }
}

export interface ProviderProbeServiceParts {
  readonly probe: ProviderProbePort;
  readonly clock: ProviderProbeClock;
}

/** One login to test: its id, what it is, and the preset it was made from. */
export interface ProviderProbeSubject {
  readonly id: string;
  readonly credential: Credential;
  readonly preset: ProviderPreset | undefined;
}

export class ProviderProbeService {
  constructor(private readonly parts: ProviderProbeServiceParts) {}

  async test(
    subject: ProviderProbeSubject,
    consent: { readonly allowInference: boolean },
  ): Promise<FleetCredentialTestResult> {
    const started = this.parts.clock.monotonicMs();
    const result = (
      code: FleetCredentialTestCode,
      spent: FleetCredentialTestResult['spent'],
      message = PROVIDER_TEST_MESSAGES[code],
      sent = false,
    ): FleetCredentialTestResult => ({
      credentialId: subject.id,
      ok: code === 'ok',
      code,
      message,
      spent,
      ...(sent ? { latencyMs: Math.max(0, this.parts.clock.monotonicMs() - started) } : {}),
      at: this.parts.clock.now(),
    });
    if (subject.credential.store !== 'environment') {
      return result(
        'not_testable',
        'nothing',
        'Only a login made from environment variables is tested here; use Check now for a sign-in.',
      );
    }
    if (subject.preset === undefined) {
      return result(
        'not_testable',
        'nothing',
        'This login was not made from a preset this machine has, so Ferretry does not know a safe way to test it.',
      );
    }
    const plan = planProviderProbe(subject.preset, subject.credential);
    if ('reason' in plan) return result(plan.code, 'nothing', plan.reason);
    if (plan.spends === 'one-token' && !consent.allowInference) return result('consent_required', 'nothing');
    const outcome = await this.parts.probe.probe(plan);
    const code = probeCode(outcome);
    // A refusal, a missing secret or a damaged store sent nothing; anything else reached the provider.
    const sent = !['refused', 'not_set', 'vault_damaged'].includes(code);
    return result(code, sent ? plan.spends : 'nothing', PROVIDER_TEST_MESSAGES[code], sent);
  }
}
