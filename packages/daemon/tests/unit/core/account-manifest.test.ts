import { describe, it } from 'bun:test';
import should from 'should';
import { buildFleetManifest } from '@ferretry/fleet';
import {
  fleetManifestRefusal,
  FleetManifestUnreadableError,
  parseAccountManifest,
} from '../../../src/lib/core/index.ts';

const SOURCE = '/state/fleet/manifest.json';
const ID_ONE = '00000000-0000-4000-8000-000000000001';
const ID_TWO = '00000000-0000-4000-8000-000000000002';

/**
 * The row the PROVISIONER writes, not a row invented for the daemon.
 *
 * It is built through `buildFleetManifest` — the same call `fy fleet apply` publishes with — so a
 * fixture cannot quietly describe a manifest no writer produces. That is exactly how the daemon's
 * reader came to demand an `agent` field: its fixture had one and the fleet's writer never did.
 */
const row = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: ID_ONE,
  kind: 'claude',
  mode: 'auto',
  wrapper: '/state/fleet/bin/claude-auto-one',
  home: '/state/fleet/homes/auto-one',
  displayName: 'Primary',
  defaultModel: 'apex',
  models: [{ id: 'apex', available: true }],
  available: true,
  unavailableReason: null,
  ...overrides,
});

const manifest = (...accounts: readonly Record<string, unknown>[]): unknown =>
  buildFleetManifest({ generatedAt: '2027-01-15T08:00:00.000Z', accounts });

describe('parseAccountManifest', () => {
  it('should read the manifest the fleet provisioner publishes', () => {
    // Arrange / Act
    const accounts = parseAccountManifest(manifest(row()), SOURCE);

    // Assert — this is the regression: the released daemon read this exact payload as an empty fleet
    // while `fy fleet ls` listed the account from the same bytes.
    should(accounts.map(item => item.id)).eql([ID_ONE]);
  });

  it('should name the account by the wrapper it publishes, without a second field to disagree', () => {
    // Arrange / Act
    const accounts = parseAccountManifest(manifest(row()), SOURCE);

    // Assert — `agent` is what an operator types and a usage row is keyed by; `wrapper` is what a
    // start actually runs, and it is absolute because a service-managed daemon has no fleet PATH.
    should(accounts[0]?.agent).equal('claude-auto-one');
    should(accounts[0]?.wrapper).equal('/state/fleet/bin/claude-auto-one');
  });

  it('should carry the declared reason a model is down', () => {
    // Arrange / Act
    const accounts = parseAccountManifest(
      manifest(
        row({
          defaultModel: 'apex',
          models: [
            { id: 'apex', available: true },
            { id: 'legacy', available: false, unavailableReason: 'retired by the provider' },
          ],
        }),
      ),
      SOURCE,
    );

    // Assert — availability is declared, so an unavailable model cannot be recommended
    should(accounts[0]?.models[1]).eql({
      id: 'legacy',
      available: false,
      unavailableReason: 'retired by the provider',
    });
  });

  it('should read an account the fleet declared down', () => {
    // Arrange / Act
    const accounts = parseAccountManifest(
      manifest(row({ available: false, defaultModel: null, unavailableReason: 'quota exhausted' })),
      SOURCE,
    );

    // Assert
    should(accounts[0]?.available).be.false();
    should(accounts[0]?.unavailableReason).equal('quota exhausted');
  });

  it('should read every account, not only the first', () => {
    // Arrange / Act
    const accounts = parseAccountManifest(
      manifest(
        row(),
        row({
          id: ID_TWO,
          kind: 'codex',
          wrapper: '/state/fleet/bin/codex-auto-two',
          home: '/state/fleet/homes/auto-two',
        }),
      ),
      SOURCE,
    );

    // Assert
    should(accounts.map(item => item.agent)).eql(['claude-auto-one', 'codex-auto-two']);
  });

  it('should refuse a manifest it cannot read rather than answer an empty fleet', () => {
    // Arrange — a row no provisioner would write. The file is present, so the fleet is not empty:
    // what this daemon has is no idea what is in it, and saying "no accounts" would be a claim.
    const damaged = { version: 1, generatedAt: '2027-01-15T08:00:00.000Z', accounts: [row({ kind: 'telepathy' })] };

    // Act / Assert
    should(() => parseAccountManifest(damaged, SOURCE)).throw(FleetManifestUnreadableError);
    should(() => parseAccountManifest(damaged, SOURCE)).throw(/manifest at \/state\/fleet\/manifest\.json/u);
  });

  it('should refuse a payload that is not a manifest at all, naming the file', () => {
    // Act / Assert — the daemon reads one file at one path; anything else there is damage
    should(() => parseAccountManifest({ error: 'not provisioned' }, SOURCE)).throw(FleetManifestUnreadableError);
    should(() => parseAccountManifest('nonsense', SOURCE)).throw(/present but cannot be read/u);
  });
});

describe('fleetManifestRefusal', () => {
  it('should name the file, the failure and what will now be refused', () => {
    // Arrange
    const error = new FleetManifestUnreadableError(SOURCE, 'accounts[0]: unrecognized key "agent"');

    // Act
    const refusal = fleetManifestRefusal(error, 'fy');

    // Assert — the consequence is stated because the two readings of one file are what confuse:
    // `fy fleet ls` will list these accounts happily while this daemon refuses every start.
    should(refusal).containEql(SOURCE);
    should(refusal).containEql('unrecognized key');
    should(refusal).match(/Every session start will be refused/u);
    should(refusal).match(/`fy fleet apply`/u);
  });
});
