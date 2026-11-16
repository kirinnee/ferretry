import { describe, it } from 'bun:test';
import should from 'should';
import { renderLoginRow } from '../../../cli/lib/render.ts';
import type { LoginView } from '../../../contract/index.ts';
import { login } from './fakes.ts';

const period = (overrides: Record<string, unknown> = {}) => ({
  spentUsd: 12.4,
  level: 'ok',
  startsAt: '2026-11-01T00:00:00.000Z',
  resetsAt: '2026-11-07T00:00:00.000Z',
  ...overrides,
});

const budget = (overrides: Record<string, unknown> = {}) => ({
  timeZone: 'UTC',
  timeZoneSet: true,
  level: 'ok',
  unpriced: 0,
  measured: true,
  ...overrides,
});

const rowOf = (overrides: Record<string, unknown>): string[] => renderLoginRow(login(overrides) as LoginView, 'fz');

describe('renderLoginRow — a switched-off login', () => {
  it('says why and until a bare date, with the way back', () => {
    const lines = rowOf({
      disabled: { source: 'login', reason: 'spend limit reached', until: '2026-11-05T00:00:00.000Z' },
    });
    should(lines[0]).equal(
      'claude-you  Claude Code  you@example.com  — disabled (spend limit reached) until 2026-11-05',
    );
    should(lines[1]).equal('  Nothing new starts on it. Turn it back on with `login enable claude-you`.');
  });

  it('says a time of day in UTC, writes an unreadable time as it came, and needs no reason', () => {
    should(rowOf({ disabled: { source: 'login', until: '2026-11-05T09:30:00.000Z' } })[0]).endWith(
      '— disabled until 2026-11-05 09:30 UTC',
    );
    should(rowOf({ disabled: { source: 'login', until: 'tomorrow-ish' } })[0]).endWith('— disabled until tomorrow-ish');
  });
});

describe('renderLoginRow — the budget lines', () => {
  it('shows what was spent against each period’s limits, in the budget’s zone', () => {
    const lines = rowOf({
      budget: budget({
        daily: period({ trigger: 20, hard: 40 }),
        weekly: period({ spentUsd: 55, hard: 100 }),
      }),
    });
    should(lines).containEql(
      '  Budget, spent on this machine only (UTC): today $12.40 of $20.00 trigger, $40.00 hard · this week $55.00 of $100.00 hard',
    );
    should(lines.some(line => line.includes('Over its'))).be.false();
  });

  it('says the zone is the host’s when it is not written down, and that the first count is still running', () => {
    const lines = rowOf({ budget: budget({ timeZoneSet: false, measured: false, daily: period({ trigger: 5 }) }) });
    should(lines).containEql(
      '  Budget, spent on this machine only (UTC, the host’s zone): today $12.40 of $5.00 trigger',
    );
    should(lines).containEql('  Not measured yet: the first count since the daemon started is still running.');
  });

  it('says when a transcript was too large to read whole and how many requests had no price', () => {
    const lines = rowOf({ budget: budget({ partial: true, unpriced: 3, weekly: period({ trigger: 9 }) }) });
    should(lines).containEql(
      '  Partial: a transcript is too large to read back to the start of the period, so the amount may be low.',
    );
    should(lines).containEql('  3 request(s) used a model with no price and are not in these amounts.');
  });

  it('says what an over-trigger and an over-hard budget hold, and when it lets go', () => {
    const over = (level: string) =>
      rowOf({ budget: budget({ level, weekly: period({ trigger: 9, hard: 10, spentUsd: 11, level }) }) });
    should(over('over_trigger')).containEql(
      '  Over its trigger: nothing new starts on it until Sat 00:00; ferrets already on it keep running.',
    );
    should(over('over_hard')).containEql(
      '  Over its hard limit: its ferrets were stopped and nothing new starts on it until Sat 00:00. Move one with `fz ferret move <id>`.',
    );
  });
});

describe('renderLoginRow — an environment login', () => {
  it('shows the preset, each variable by kind without ever showing a hidden one, and what is missing', () => {
    const lines = rowOf({
      store: 'environment',
      environment: {
        preset: { id: 'zai-glm', label: 'Z.ai GLM', docs: 'https://docs.example.test' },
        variables: [
          { name: 'ANTHROPIC_BASE_URL', kind: 'plain', value: 'https://api.z.ai' },
          { name: 'HIDDEN_ONE', kind: 'hidden' },
          { name: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', secrets: ['ZAI_KEY', 'ZAI_ORG'], set: true },
          { name: 'OTHER_TOKEN', kind: 'secret', secrets: ['OTHER'], set: false },
        ],
        cloudCredential: {
          reference: 'aws-prod',
          kind: 'aws-profile',
          sentence: 'Your AWS profile prod on this machine',
        },
        quotaSource: 'none',
        missingSecrets: ['OTHER'],
        test: { available: false, reason: 'no' },
      },
    });
    should(lines).containEql('  Login: read from the environment');
    should(lines).containEql('  Preset: Z.ai GLM');
    should(lines).containEql('  ANTHROPIC_BASE_URL=https://api.z.ai');
    should(lines).containEql('  HIDDEN_ONE=(hidden)');
    should(lines).containEql('  ANTHROPIC_AUTH_TOKEN=${secret:ZAI_KEY}, ${secret:ZAI_ORG} (set)');
    should(lines).containEql('  OTHER_TOKEN=${secret:OTHER} (not set)');
    should(lines).containEql('  Your AWS profile prod on this machine');
    should(lines).containEql('  Needs: OTHER');
  });

  it('shows nothing extra for an environment with no preset, no cloud credential and nothing missing', () => {
    const lines = rowOf({
      store: 'environment',
      environment: {
        variables: [],
        quotaSource: 'none',
        missingSecrets: [],
        test: { available: false, reason: 'no' },
      },
    });
    should(lines.some(line => line.includes('Preset') || line.includes('Needs'))).be.false();
  });
});

describe('renderLoginRow — where a login is kept', () => {
  it('says whether it is shared with the terminal, copied from another login, or kept by Ferretry', () => {
    should(rowOf({ sharedWithTerminal: true })).containEql('  Login: shared with claude-code in your terminal');
    should(rowOf({ clonedFrom: 'claude-old' })).containEql('  Login: copied from claude-old: sign in to use it');
    should(rowOf({})).containEql('  Login: kept by Ferretry');
  });

  it('asks for a label when another login has the same email', () => {
    should(rowOf({ needsLabel: true })).containEql(
      '  Another login has the same email: give one a label to tell them apart.',
    );
  });
});
