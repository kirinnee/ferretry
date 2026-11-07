import { describe, expect, it } from 'bun:test';
import type { AttachmentView } from '@ferretry/protocol';
import { AttachmentFacetContributor } from '../../../src/lib/transfer/facets/attachments.ts';
import { LineageFacetContributor } from '../../../src/lib/transfer/facets/lineage.ts';
import { ReferenceFacetContributor } from '../../../src/lib/transfer/facets/references.ts';
import { WorkspaceFacetContributor } from '../../../src/lib/transfer/facets/workspace.ts';
import { TransferPrepareError, type TransferReferenceInventory } from '../../../src/lib/transfer/types.ts';
import { WARDEN_LABEL } from '../../../src/lib/warden/types.ts';
import { AT, request, sourceSession, target } from './fixtures.ts';

const input = (source = sourceSession(), overrides: Parameters<typeof request>[0] = {}) => ({
  request: request(overrides),
  source,
});

const attachment = (overrides: Partial<AttachmentView> = {}): AttachmentView => ({
  id: `att_${'a'.repeat(64)}`,
  filename: 'notes.pdf',
  mime: 'application/pdf',
  size: 1024,
  sha256: 'a'.repeat(64),
  createdAt: AT,
  ...overrides,
});

describe('AttachmentFacetContributor', () => {
  it('plans content-addressed ids and manifests, and copies nothing while planning', async () => {
    const contributor = new AttachmentFacetContributor({ list: async () => [attachment({ encrypted: undefined })] });

    const contribution = await contributor.contribute(input());

    expect(contribution.value.attachments).toEqual([
      {
        id: `att_${'a'.repeat(64)}`,
        filename: 'notes.pdf',
        mime: 'application/pdf',
        size: 1024,
        sha256: 'a'.repeat(64),
        createdAt: AT,
        encrypted: null,
      },
    ]);
    expect(contribution.omissions).toEqual([]);
    expect(contributor.facet).toBe('attachments');
  });

  it('plans an unlocked source attachment as LOCKED and reports the credential that did not cross', async () => {
    const contributor = new AttachmentFacetContributor({
      list: async () => [attachment({ encrypted: { kind: 'pdf', locked: false, expiresAt: AT, decryptedSize: 900 } })],
    });

    const contribution = await contributor.contribute(input());

    expect(contribution.value.attachments[0]?.encrypted).toEqual({ kind: 'pdf', locked: true });
    expect(contribution.omissions).toEqual([
      {
        facet: 'attachments',
        subject: 'notes.pdf',
        reason: 'credential',
        detail:
          'this attachment is encrypted; its original bytes are carried but no decrypted copy and no unlock are, ' +
          'so the new session asks for the password again before it can read it',
      },
    ]);
  });

  it('drops whole files past an injected budget and names each one, rather than truncating a copy', async () => {
    const contributor = new AttachmentFacetContributor(
      {
        list: async () => [
          attachment({ id: `att_${'b'.repeat(64)}`, filename: 'small.txt', size: 10, sha256: 'b'.repeat(64) }),
          attachment({ id: `att_${'c'.repeat(64)}`, filename: 'huge.bin', size: 999, sha256: 'c'.repeat(64) }),
          attachment({ id: `att_${'d'.repeat(64)}`, filename: 'third.txt', size: 1, sha256: 'd'.repeat(64) }),
        ],
      },
      { maxCount: 2, maxTotalBytes: 100 },
    );

    const contribution = await contributor.contribute(input());

    expect(contribution.value.attachments.map(planned => planned.filename)).toEqual(['small.txt', 'third.txt']);
    expect(contribution.omissions).toEqual([
      {
        facet: 'attachments',
        subject: 'huge.bin',
        reason: 'unavailable',
        detail:
          'this attachment is past the transfer budget for one session and is not copied, rather than copied in part',
      },
    ]);
  });

  it('stops at the count ceiling as well as the byte ceiling', async () => {
    const contributor = new AttachmentFacetContributor(
      {
        list: async () => [
          attachment({ id: `att_${'b'.repeat(64)}`, filename: 'one.txt', size: 1, sha256: 'b'.repeat(64) }),
          attachment({ id: `att_${'c'.repeat(64)}`, filename: 'two.txt', size: 1, sha256: 'c'.repeat(64) }),
        ],
      },
      { maxCount: 1, maxTotalBytes: 1_000 },
    );

    const contribution = await contributor.contribute(input());

    expect(contribution.value.attachments.map(planned => planned.filename)).toEqual(['one.txt']);
    expect(contribution.omissions.map(omission => omission.subject)).toEqual(['two.txt']);
  });
});

const conversation = (...texts: readonly string[]) => ({
  messages: texts.map((text, index) => ({
    point: { v: 1 as const, byteOffset: index, blockIndex: 0 },
    role: 'user' as const,
    text,
  })),
});

const counting = (counts: Partial<Awaited<ReturnType<TransferReferenceInventory['count']>>>) => ({
  count: async () => ({
    agent: 0,
    file: 0,
    task: 0,
    attention: 0,
    skill: 0,
    terminal: 0,
    browser: 0,
    ...counts,
  }),
});

describe('ReferenceFacetContributor', () => {
  it('counts nothing and reports nothing when no conversation crosses', async () => {
    const contributor = new ReferenceFacetContributor(counting({ task: 4 }));

    const contribution = await contributor.contribute({ ...input(), conversation: null });

    expect(contribution.value.counts.task).toBe(0);
    expect(contribution.omissions).toEqual([]);
    expect(contributor.facet).toBe('references');
  });

  it('says so mechanically when this build cannot count the tokens it carried', async () => {
    const contributor = new ReferenceFacetContributor();

    const contribution = await contributor.contribute({ ...input(), conversation: conversation('see &T12') });

    expect(contribution.value.counts).toEqual({
      agent: 0,
      file: 0,
      task: 0,
      attention: 0,
      skill: 0,
      terminal: 0,
      browser: 0,
    });
    expect(contribution.omissions).toHaveLength(1);
    expect(contribution.omissions[0]?.reason).toBe('not_implemented');
    expect(contribution.omissions[0]?.subject).toBe('inventory');
  });

  it('reports the session-scoped kinds even for a same-harness transfer, and never the re-proved ones', async () => {
    const contributor = new ReferenceFacetContributor(
      counting({ agent: 3, file: 2, task: 1, attention: 1, terminal: 1, browser: 1 }),
    );

    const contribution = await contributor.contribute({ ...input(), conversation: conversation('a token') });

    expect(contribution.omissions.map(omission => omission.subject)).toEqual([
      '&task',
      '!attention',
      '%terminal:',
      '%browser:',
    ]);
    expect(contribution.omissions.every(omission => omission.reason === 'session_scoped')).toBe(true);
    expect(contribution.value.counts.agent).toBe(3);
  });

  it('warns about skills only when the target harness differs, because its catalogue decides', async () => {
    const contributor = new ReferenceFacetContributor(counting({ skill: 2 }));
    const same = await contributor.contribute({ ...input(), conversation: conversation('/deploy') });
    const across = await contributor.contribute({
      ...input(sourceSession(), { target: target({ harness: 'codex' }) }),
      conversation: conversation('/deploy'),
    });

    expect(same.omissions).toEqual([]);
    expect(across.omissions).toHaveLength(1);
    expect(across.omissions[0]?.subject).toBe('/skill');
    expect(across.omissions[0]?.reason).toBe('unavailable');
  });
});

describe('WorkspaceFacetContributor', () => {
  it('reports the working tree and always warns that filesystem state was not rewound', async () => {
    const contributor = new WorkspaceFacetContributor({
      probe: async cwd => {
        expect(cwd).toBe('/work/repo');
        return {
          head: 'abc123',
          status: {
            staged: true,
            unstaged: false,
            untracked: true,
            ignored: false,
            conflicted: false,
            dirtySubmodule: false,
            truncated: false,
          },
        };
      },
    });

    const contribution = await contributor.contribute(input());

    expect(contribution.value.repositorySnapshot).toBeNull();
    expect(contribution.value.head).toBe('abc123');
    expect(contribution.value.status?.staged).toBe(true);
    expect(contribution.omissions).toHaveLength(1);
    expect(contribution.omissions[0]?.reason).toBe('not_implemented');
    expect(contribution.omissions[0]?.detail).toContain('conversation time was rewound');
    expect(contributor.facet).toBe('workspace');
  });

  it('keeps the hard null even when the probe can say nothing about the tree', async () => {
    const contributor = new WorkspaceFacetContributor({ probe: async () => ({ head: null, status: null }) });

    const contribution = await contributor.contribute(input());

    expect(contribution.value).toEqual({
      cwd: '/work/repo',
      head: null,
      status: null,
      repositorySnapshot: null,
    });
  });
});

describe('LineageFacetContributor', () => {
  it('carries no warden descent for a source that has none', async () => {
    const contributor = new LineageFacetContributor();

    const unstamped = await contributor.contribute(input(sourceSession({ provenance: undefined })));
    const plain = await contributor.contribute(
      input(
        sourceSession({
          provenance: { v: 1, at: AT, origin: 'human', wardenLineage: false, lineageSource: 'none' },
        }),
      ),
    );

    expect(unstamped.value).toEqual({ wardenLineage: false, warden: null });
    expect(plain.value).toEqual({ wardenLineage: false, warden: null });
    expect(contributor.facet).toBe('lineage');
  });

  it('carries the label shield with a traceable warden when a legacy stamp is absent or negative', async () => {
    const contributor = new LineageFacetContributor();

    const unstamped = await contributor.contribute(
      input(sourceSession({ label: WARDEN_LABEL, provenance: undefined })),
    );
    const negativelyStamped = await contributor.contribute(
      input(
        sourceSession({
          label: WARDEN_LABEL,
          provenance: { v: 1, at: AT, origin: 'human', wardenLineage: false, lineageSource: 'none' },
        }),
      ),
    );

    expect(unstamped.value).toEqual({ wardenLineage: true, warden: 'source-a' });
    expect(negativelyStamped.value).toEqual({ wardenLineage: true, warden: 'source-a' });
    expect(unstamped.omissions).toEqual([]);
    expect(negativelyStamped.omissions).toEqual([]);
  });

  it('carries warden descent forward with the warden it traces back to', async () => {
    const contributor = new LineageFacetContributor();

    const contribution = await contributor.contribute(
      input(
        sourceSession({
          provenance: {
            v: 1,
            at: AT,
            origin: 'warden',
            warden: 'warden-7',
            wardenLineage: true,
            lineageSource: 'parent_stamp',
          },
        }),
      ),
    );

    expect(contribution.value).toEqual({ wardenLineage: true, warden: 'warden-7' });
    expect(contribution.omissions).toEqual([]);
  });

  it('refuses a shield with no traceback rather than inventing one or dropping it', async () => {
    const contributor = new LineageFacetContributor();

    const error = (await contributor
      .contribute(
        input(
          sourceSession({
            provenance: { v: 1, at: AT, origin: 'warden', wardenLineage: true, lineageSource: 'self_label' },
          }),
        ),
      )
      .catch((thrown: unknown) => thrown)) as TransferPrepareError;

    expect(error).toBeInstanceOf(TransferPrepareError);
    expect(error.failure).toBe('lineage_untraceable');
  });
});
