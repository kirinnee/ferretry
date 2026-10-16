import { describe, expect, it } from 'bun:test';
import { type CapabilityGrantView, DAEMON_CAPABILITIES, type GrantRefusal, type GrantsView } from '@ferretry/protocol';
import {
  ASK_WARDEN_FOCI,
  ASK_WARDEN_NOTES_MAX,
  askWardenBlocker,
  askWardenCostLine,
  askWardenInvestigatorLine,
  askWardenNote,
  askWardenQueuedSentence,
  mayAskWarden,
} from '../../../src/features/warden/ask-warden-model.ts';
import { wardenConfig, wardenStatus } from '../../support/warden.ts';

const entry = (capability: CapabilityGrantView['capability'], useRefusal: GrantRefusal): CapabilityGrantView => ({
  capability,
  use: useRefusal === 'granted',
  configure: false,
  granted: { use: useRefusal !== 'not-granted', configure: false },
  mayGrant: false,
  useRefusal,
  configureRefusal: 'not-granted',
  origin: 'default',
});

const grants = (warden: GrantRefusal | null): GrantsView => ({
  capabilities: DAEMON_CAPABILITIES.filter(capability => warden !== null || capability !== 'warden').map(capability =>
    entry(capability, capability === 'warden' && warden !== null ? warden : 'granted'),
  ),
  governed: true,
  hostLocal: false,
  steppedUp: false,
});

describe('who is offered "Ask the Warden"', () => {
  it('offers it when warden.use is open or waits only on a passkey, and never otherwise', () => {
    expect(mayAskWarden(grants('granted'))).toBe(true);
    expect(mayAskWarden(grants('step-up-required'))).toBe(true);
    expect(mayAskWarden(grants('not-granted'))).toBe(false);
    expect(mayAskWarden(grants('device-not-granted'))).toBe(false);
    expect(mayAskWarden(grants('undetermined'))).toBe(false);
    expect(mayAskWarden(grants(null))).toBe(false);
  });
});

describe('the note the investigator reads', () => {
  it('leads with the focus, then the owner’s notes, trimmed', () => {
    expect(askWardenNote('stuck', '')).toBe('Focus: why it seems stuck.');
    expect(askWardenNote('failures', '   ')).toBe('Focus: the recent failures.');
    expect(askWardenNote('recent', '  CI went red after the last push ')).toBe(
      'Focus: everything recent. CI went red after the last push',
    );
  });

  it('stays inside the route’s 500-character note even at the notes’ limit', () => {
    for (const { value } of ASK_WARDEN_FOCI)
      expect(askWardenNote(value, 'x'.repeat(ASK_WARDEN_NOTES_MAX)).length).toBeLessThanOrEqual(500);
  });

  it('offers the three foci of the approved mock, stuck first', () => {
    expect(ASK_WARDEN_FOCI.map(option => option.label)).toEqual([
      'Why it seems stuck',
      'The recent failures',
      'Everything recent',
    ]);
  });
});

describe('the cost line', () => {
  it('prices a run from the average priced investigation, against today’s cap', () => {
    const status = wardenStatus();
    const line = askWardenCostLine({
      ...status,
      spend: { ...status.spend, investigationCapUsd: 2, investigationUsd: 0.6 },
      savings: { ...status.savings, averageInvestigationUsd: 0.3 },
    });
    expect(line).toBe('About $0.30, counted against today’s $2.00 investigation cap ($0.60 used).');
  });

  it('says the cost is unknown rather than guessing before any run was priced', () => {
    expect(askWardenCostLine(wardenStatus())).toStartWith('Cost unknown until one has been priced, counted against');
  });
});

describe('who would investigate', () => {
  it('names the head of the failover list and its model', () => {
    const line = askWardenInvestigatorLine(
      wardenStatus({ config: wardenConfig({ accounts: [{ agent: 'claude-default', model: 'claude-opus-5' }] }) }),
    );
    expect(line).toStartWith('A read-only assigned warden on claude-default with claude-opus-5 reads');
    expect(line).toContain('Manual requests skip Jev');
  });

  it('leaves the model out when the login names none', () => {
    expect(askWardenInvestigatorLine(wardenStatus())).toStartWith(
      'A read-only assigned warden on claude-auto-loge reads',
    );
  });

  it('says nothing about a login when the status names none', () => {
    const status = wardenStatus();
    expect(askWardenInvestigatorLine({ ...status, config: { ...status.config, accounts: [] } })).toStartWith(
      'A read-only assigned warden reads',
    );
  });
});

describe('what the status already refuses', () => {
  it('takes the request when the Warden is on and under its cap', () => {
    expect(askWardenBlocker(wardenStatus())).toBeNull();
  });

  it('refuses while the Warden is off', () => {
    expect(askWardenBlocker(wardenStatus({ config: wardenConfig({ enabled: false }) }))).toBe(
      'The Warden is off. Turn it on in Settings › Warden.',
    );
  });

  it('refuses once today’s investigation cap is hit, but not for the Jev cap', () => {
    const status = wardenStatus();
    expect(askWardenBlocker({ ...status, spend: { ...status.spend, capHit: 'investigation' } })).toBe(
      'Today’s $2.00 investigation cap is reached. Raise it in Settings › Warden.',
    );
    expect(askWardenBlocker({ ...status, spend: { ...status.spend, capHit: 'jev' } })).toBeNull();
  });
});

describe('the toast', () => {
  it('says queued or started, and where the report lands', () => {
    expect(askWardenQueuedSentence('hadi', 'queued')).toBe(
      'Investigation of hadi queued — the report lands in Info › Signals.',
    );
    expect(askWardenQueuedSentence('hadi', 'running')).toBe(
      'Investigation of hadi started — the report lands in Info › Signals.',
    );
  });
});
