import { afterEach, describe, it } from 'bun:test';
import type { SessionTransferEdge } from '@ferretry/protocol';
import should from 'should';
import {
  SessionTransferEnvelopeError,
  StorageTransferEnvelopeWriter,
} from '../../../src/adapters/transfer/storage-transfer-envelope-writer.ts';
import { StorageSessionProvenanceStore } from '../../../src/adapters/session/provenance/index.ts';
import {
  parseSessionProvenance,
  SessionProvenanceRecorder,
  SessionProvenanceStamper,
} from '../../../src/lib/session/provenance/index.ts';
import { parseSessionId } from '../../../src/lib/session-id.ts';
import type { SessionTransferEnvelope } from '../../../src/lib/transfer/types.ts';
import { AT, SOURCE_ID, TARGET_ID, cleanup, openStorage, plan } from '../fork/fixtures.ts';

/**
 * The transfer envelope, against real session documents.
 *
 * Three things are proved here that no fake storage could: the exact merged document a reader parses
 * afterwards, that two applications of one envelope produce identical bytes, and that the writer
 * refuses to be aimed at the source named in the very edge it is applying.
 */

function envelope(cwd: string, overrides: Partial<SessionTransferEnvelope> = {}): SessionTransferEnvelope {
  const frozen = plan(cwd);
  const transferredFrom: SessionTransferEdge = {
    v: 1,
    kind: 'fork',
    sourceSessionId: SOURCE_ID,
    sourceIncarnation: `${SOURCE_ID}-1`,
    sourceHarness: 'claude',
    cutMessagePoint: frozen.source.cutMessagePoint,
    planId: frozen.planId,
    at: AT,
  };
  return { durable: frozen.durable, transferredFrom, lineage: frozen.facets.lineage, ...overrides };
}

/** A minimal configuration document, as the lifecycle's create leaves one behind. */
function created(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    incarnation: `${id}-1`,
    runtimeGeneration: 1,
    name: 'Forked',
    parent: '20260806-someone-else',
    boardAccess: 'worker',
    agent: 'claude-auto-zelda',
    harness: 'claude',
    modelHint: 'claude-opus-5',
    model: 'claude-opus-5',
    mode: 'auto',
    remoteControl: false,
    harnessFlags: [],
    label: 'stale',
    cwd: '/somewhere/else',
    createdAt: AT,
    updatedAt: AT,
    turn: 1,
    intervalSeconds: 1,
    timeoutSeconds: 1,
    nudgeAfterSeconds: 1,
    killAfterSeconds: 1,
    directSendMaxChars: 1,
    resumeMenuChoice: 'summary',
    maxSnapshots: 1,
    retry: { transientAttempts: 0, stalledAttempts: 0, waitForQuotaReset: false, allowAccountFailover: false },
    ...overrides,
  };
}

async function refusal(promise: Promise<unknown>): Promise<SessionTransferEnvelopeError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SessionTransferEnvelopeError) return error;
    throw error;
  }
  throw new Error('expected the envelope to be refused, but it applied');
}

describe('StorageTransferEnvelopeWriter', () => {
  afterEach(async () => await cleanup());

  it('should write the durable decision, the target-only edge and a fresh warden stamp', async () => {
    // Arrange
    const { storage } = await openStorage('envelope-apply');
    const target = parseSessionId(TARGET_ID);
    await storage.writeConfig(target, created(TARGET_ID));
    const applied = envelope('/work/forked');

    // Act
    await new StorageTransferEnvelopeWriter(storage).apply(TARGET_ID, applied);

    // Assert
    const document = (await storage.readConfig(target)) as Record<string, unknown>;
    should(document.cwd).equal('/work/forked');
    should(document.boardAccess).equal('none');
    // The source label remains inventoried in the plan, but warden descent forces the target's
    // operational label so the label and provenance shields agree from the first durable write.
    should(document.label).equal('fleet-warden');
    should(document.harnessFlags).eql(['--dangerously-skip-permissions']);
    should(document.remoteControl).equal(true);
    should(document.resumeMenuChoice).equal('full');
    should(document.maxSnapshots).equal(5);
    should(document.retry).eql(applied.durable.retry);
    should(document.transferredFrom).eql(applied.transferredFrom);
    // An absent parent is an ABSENT FIELD: the schema every reader parses this with refuses a null.
    should(Object.hasOwn(document, 'parent')).equal(false);
    // Descent recorded where the warden detector reads its shield from, with no parent to walk.
    should(parseSessionProvenance(document.provenance)).eql({
      v: 1,
      at: AT,
      origin: 'warden',
      warden: '20260806-warden',
      wardenLineage: true,
      lineageSource: 'parent_stamp',
    });
  });

  it('should produce identical bytes on a replay, so a crash around it converges', async () => {
    // Arrange
    const { storage } = await openStorage('envelope-replay');
    const target = parseSessionId(TARGET_ID);
    await storage.writeConfig(target, created(TARGET_ID));
    const subject = new StorageTransferEnvelopeWriter(storage);
    const applied = envelope('/work/forked');

    // Act
    await subject.apply(TARGET_ID, applied);
    const first = JSON.stringify(await storage.readConfig(target));
    await subject.apply(TARGET_ID, applied);

    // Assert: the stamp's instant is the edge's, never a fresher clock reading.
    should(JSON.stringify(await storage.readConfig(target))).equal(first);
  });

  /**
   * The §G interaction, and the only test that runs BOTH writers of this field against one document.
   *
   * A fork's stamp is `parent_stamp`-sourced and names no parent, so a re-stamp resolving against an
   * empty ancestry would answer `none` — which would unshield a warden descendant on its first
   * revive. What saves it is `restamp`'s monotonic branch, which returns a recorded shield verbatim.
   * That branch is easy to "simplify" away by someone reading the recorder alone, so the guard is
   * pinned here, where the two writers meet.
   */
  it('should keep a forked warden descendant shielded across a later revive', async () => {
    // Arrange: the fork writes the stamp, then the recorder runs with nothing left in the fleet.
    const { storage } = await openStorage('envelope-revive');
    const target = parseSessionId(TARGET_ID);
    await storage.writeConfig(target, created(TARGET_ID));
    await new StorageTransferEnvelopeWriter(storage).apply(TARGET_ID, envelope('/work/forked'));
    const store = new StorageSessionProvenanceStore(storage);
    const recorder = new SessionProvenanceRecorder(
      new SessionProvenanceStamper({ now: () => '2026-08-06T23:00:00.000Z' }),
      store,
      { snapshot: async () => new Map() },
    );

    // Act
    const recorded = await recorder.recordRelaunch({ id: TARGET_ID, requestedByHuman: true });

    // Assert: the SHIELD is preserved verbatim — same warden, same evidence, same spawn instant.
    should(recorded.provenance.wardenLineage).equal(true);
    should(recorded.provenance.warden).equal('20260806-warden');
    should(recorded.provenance.lineageSource).equal('parent_stamp');
    should(recorded.provenance.at).equal(AT);
    should((await store.read(TARGET_ID)).provenance?.wardenLineage).equal(true);

    // The envelope wrote the forced label together with the stamp, so revive has nothing to repair.
    should(recorded.written).equal(false);
    should(recorded.label).equal('fleet-warden');
    should((await store.read(TARGET_ID)).label).equal('fleet-warden');
  });

  it('should record no warden descent when the transfer carried none', async () => {
    // Arrange
    const { storage } = await openStorage('envelope-lineage');
    const target = parseSessionId(TARGET_ID);
    await storage.writeConfig(target, created(TARGET_ID));
    const clean = envelope('/work/forked', { lineage: { wardenLineage: false, warden: null } });

    // Act
    await new StorageTransferEnvelopeWriter(storage).apply(TARGET_ID, clean);

    // Assert
    const document = (await storage.readConfig(target)) as Record<string, unknown>;
    const stamped = parseSessionProvenance(document.provenance);
    should(stamped).eql({ v: 1, at: AT, origin: 'human', wardenLineage: false, lineageSource: 'none' });
    should(document.label).equal('f117');
  });

  it('should refuse a valid spawn stamp naming a warden this transfer did not trace', async () => {
    // Arrange: a fresh target has no spawn history, so a well-formed foreign stamp is evidence that
    // something else owns this id — and adopting its shield would exempt this session from warden
    // escalation on the strength of somebody else's ancestry.
    const { storage } = await openStorage('envelope-foreign-warden');
    const target = parseSessionId(TARGET_ID);
    await storage.writeConfig(
      target,
      created(TARGET_ID, {
        provenance: {
          v: 1,
          at: AT,
          origin: 'warden',
          warden: '20260806-another-warden',
          wardenLineage: true,
          lineageSource: 'parent_stamp',
        },
      }),
    );
    const before = JSON.stringify(await storage.readConfig(target));

    // Act
    const refused = await refusal(new StorageTransferEnvelopeWriter(storage).apply(TARGET_ID, envelope('/work/x')));

    // Assert: refused rather than preserved, and refused rather than overwritten.
    should(refused.message).match(/a spawn stamp this transfer could not have written/u);
    should(JSON.stringify(await storage.readConfig(target))).equal(before);
  });

  it('should refuse a malformed spawn stamp rather than write over it', async () => {
    // Arrange
    const { storage } = await openStorage('envelope-damaged-stamp');
    const target = parseSessionId(TARGET_ID);
    await storage.writeConfig(target, created(TARGET_ID, { provenance: { v: 1, wardenLineage: 'yes' } }));

    // Act
    const refused = await refusal(new StorageTransferEnvelopeWriter(storage).apply(TARGET_ID, envelope('/work/x')));

    // Assert: a record that cannot be parsed is not the same as no record, and treating it as one
    // would erase whatever wrote it.
    should(refused.message).match(/a spawn stamp this transfer could not have written/u);
    should(((await storage.readConfig(target)) as Record<string, unknown>).provenance).eql({
      v: 1,
      wardenLineage: 'yes',
    });
  });

  it('should drop a label the transfer does not carry', async () => {
    // Arrange
    const { storage } = await openStorage('envelope-label');
    const target = parseSessionId(TARGET_ID);
    await storage.writeConfig(target, created(TARGET_ID));
    const unlabelled = envelope('/work/forked');

    // Act
    await new StorageTransferEnvelopeWriter(storage).apply(TARGET_ID, {
      ...unlabelled,
      durable: { ...unlabelled.durable, label: null },
      lineage: { wardenLineage: false, warden: null },
    });

    // Assert
    should(Object.hasOwn((await storage.readConfig(target)) as Record<string, unknown>, 'label')).equal(false);
  });

  it('should refuse a target key that is not a usable session id', async () => {
    // Arrange
    const { storage } = await openStorage('envelope-invalid');

    // Act
    const refused = await refusal(new StorageTransferEnvelopeWriter(storage).apply('../escape', envelope('/work/x')));

    // Assert
    should(refused.message).match(/is not a usable session id/u);
  });

  it('should refuse to be applied to the very source its edge names', async () => {
    // Arrange
    const { storage } = await openStorage('envelope-source');
    const source = parseSessionId(SOURCE_ID);
    await storage.writeConfig(source, created(SOURCE_ID));
    const before = JSON.stringify(await storage.readConfig(source));

    // Act
    const refused = await refusal(new StorageTransferEnvelopeWriter(storage).apply(SOURCE_ID, envelope('/work/x')));

    // Assert: the one document that names the source is never written into it, and nothing changed.
    should(refused.message).match(/may only ever be written to the fresh session it created/u);
    should(JSON.stringify(await storage.readConfig(source))).equal(before);
  });
});
