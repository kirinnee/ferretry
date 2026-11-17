import { describe, expect, test } from 'bun:test';
import { PERSON_ORIGIN } from '../../../../contract/index.ts';
import type { FerretSessionPort } from '../../../../daemon/lib/ferrets/service.ts';
import {
  STOP_UNCONFIRMED,
  stopUnconfirmedIn,
  withStampedLabel,
} from '../../../../daemon/lib/ferrets/restart-guards.ts';
import { additivesFixture } from './additives-fixture.ts';

/**
 * The two guards a restart/resume carries (c58-59): a resume refuses over a ferret whose last stop was never confirmed
 * (the session document says `kill_failed`: its old pane may still be alive), and the label the spawn stamp forced onto a
 * ferret below the Warden is carried to the ferret's record, so a reader of the record sees what the document holds.
 * Fakes only.
 */

describe('stopUnconfirmedIn: what the state document says', () => {
  test.each([
    [{ status: 'kill_failed' }, true],
    [{ status: 'stopped' }, false],
    [{ status: 'running' }, false],
    [{}, false],
    [undefined, false],
    ['kill_failed', false],
    [null, false],
  ] as const)('should read %j as %p', (state, expected) => {
    expect(stopUnconfirmedIn(state)).toBe(expected);
  });
});

describe('withStampedLabel: the details once the forced label is carried', () => {
  test('should add the label to details that hold none, keeping every other option', () => {
    expect(withStampedLabel({ options: { model: 'm' } }, 'fleet-warden')).toEqual({
      options: { model: 'm', label: 'fleet-warden' },
    });
    expect(withStampedLabel(undefined, 'fleet-warden')).toEqual({ options: { label: 'fleet-warden' } });
  });

  test('should replace a requested label, and say nothing when the details already hold it or none was forced', () => {
    expect(withStampedLabel({ options: { label: 'mine' } }, 'fleet-warden')).toEqual({
      options: { label: 'fleet-warden' },
    });
    expect(withStampedLabel({ options: { label: 'fleet-warden' } }, 'fleet-warden')).toBeUndefined();
    expect(withStampedLabel({ options: { label: 'mine' } }, undefined)).toBeUndefined();
  });
});

describe('a resume over a stop nobody confirmed', () => {
  test('should refuse, launch nothing and change nothing when the session document says kill_failed', async () => {
    // Arrange
    const f = additivesFixture({ state: 'stopped' });
    f.ports.stopUnconfirmed = async () => true;

    // Act
    const resumed = await f.service.resume(f.id, 'carry on', { origin: PERSON_ORIGIN });

    // Assert
    expect(resumed).toEqual({ ok: false, error: { code: 'refused', reason: STOP_UNCONFIRMED('fern') } });
    expect(f.runner.starts).toBe(0);
    expect(f.registry.get(f.id)?.state).toBe('stopped');
  });

  test('should resume as ever when the document says nothing of it', async () => {
    // Arrange
    const f = additivesFixture({ state: 'stopped' });
    f.ports.stopUnconfirmed = async () => false;

    // Act
    const resumed = await f.service.resume(f.id, undefined, { origin: PERSON_ORIGIN });

    // Assert
    expect(resumed.ok).toBe(true);
    expect(f.runner.starts).toBe(1);
  });

  test('should refuse, saying it could not be read, when the document cannot be read (fail closed)', async () => {
    // Arrange
    const f = additivesFixture({ state: 'stopped' });
    f.ports.stopUnconfirmed = async () => await Promise.reject(new Error('state.json is damaged: FIXTURE_SECRET'));

    // Act
    const resumed = await f.service.resume(f.id, undefined, { origin: PERSON_ORIGIN });

    // Assert: the reason names the ferret and never quotes the read's own error.
    expect(resumed).toEqual({
      ok: false,
      error: {
        code: 'refused',
        reason: 'whether the last stop of fern was confirmed could not be read, so it was not resumed',
      },
    });
    expect(f.runner.starts).toBe(0);
  });
});

describe('the label the spawn stamp forced is the record’s too', () => {
  const stamping = (forced: { stamp?: string; carry?: string }): FerretSessionPort => ({
    prepare: async () => {},
    stamp: async () => forced.stamp,
    carry: async () => forced.carry,
  });

  test('should carry the forced label of a start to the ferret’s summary, over the label that was requested', async () => {
    // Arrange
    const f = additivesFixture({ empty: true, session: stamping({ stamp: 'fleet-warden' }) });

    // Act
    const started = await f.service.start(
      { folder: '/work', by: 'warden', options: { label: 'batch-7' } },
      PERSON_ORIGIN,
    );

    // Assert
    expect(started.ok).toBe(true);
    expect(f.registry.summary(f.id)?.label).toBe('fleet-warden');
  });

  test('should leave the requested label alone when the stamp forced none', async () => {
    // Arrange
    const f = additivesFixture({ empty: true, session: stamping({}) });

    // Act
    await f.service.start({ folder: '/work', by: 'owner', options: { label: 'batch-7' } }, PERSON_ORIGIN);

    // Assert
    expect(f.registry.summary(f.id)?.label).toBe('batch-7');
  });

  test('should carry the label a resume’s stamp holds to the record, as a ferret stamped before this build', async () => {
    // Arrange
    const f = additivesFixture({ state: 'stopped', session: stamping({ carry: 'fleet-warden' }) });
    expect(f.registry.summary(f.id)?.label).toBeUndefined();

    // Act
    const resumed = await f.service.resume(f.id, undefined, { origin: PERSON_ORIGIN });

    // Assert
    expect(resumed.ok).toBe(true);
    expect(f.registry.summary(f.id)?.label).toBe('fleet-warden');
  });
});
