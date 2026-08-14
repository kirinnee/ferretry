import { describe, expect, it } from 'bun:test';
import { renderTransferBrief } from '../../../src/lib/transfer/brief.ts';
import { AT, plan } from './fixtures.ts';

describe('renderTransferBrief', () => {
  it('says whose conversation this is, where it was cut, and that the reader was not there', () => {
    const document = renderTransferBrief(plan(), 'fork');

    expect(document.startsWith('# Prior context carried into this session by a fork\n')).toBe(true);
    expect(document).toContain('from `source-a` (claude, agent `account-a`, named `zelda`)');
    expect(document).toContain('cut at byte 512 block 0 of');
    expect(document).toContain('It is not your own history');
  });

  it('names the exact block when one record normalized into several messages', () => {
    const document = renderTransferBrief(
      plan({ source: { ...plan().source, cutMessagePoint: { v: 1, byteOffset: 512, blockIndex: 2 } } }),
      'fork',
    );

    expect(document).toContain('cut at byte 512 block 2');
  });

  it('quotes the carried messages line by line, leaving every authored byte intact', () => {
    const document = renderTransferBrief(
      plan({
        facets: {
          ...plan().facets,
          conversation: {
            messages: [
              {
                point: { v: 1, byteOffset: 0, blockIndex: 0 },
                role: 'user',
                text: 'look at &T12\n\nand `%terminal:abc123`',
              },
              {
                point: { v: 1, byteOffset: 512, blockIndex: 0 },
                role: 'assistant',
                text: 'done',
                timestamp: AT,
              },
            ],
          },
        },
      }),
      'fork',
    );

    expect(document).toContain('**user**\n\n> look at &T12\n>\n> and `%terminal:abc123`');
    expect(document).toContain(`**assistant** — ${AT}\n\n> done`);
  });

  it('renders a transfer that carried no conversation as exactly that', () => {
    const document = renderTransferBrief(
      plan({
        source: { ...plan().source, cutMessagePoint: null },
        facets: { ...plan().facets, conversation: null },
      }),
      'handover',
    );

    expect(document).toContain('no conversation was cut');
    expect(document).toContain('None was carried: this transfer moved configuration and evidence only.');
  });

  it('points at the omission list when a conversation was asked for and could not be read', () => {
    const document = renderTransferBrief(
      plan({ facets: { ...plan().facets, conversation: { messages: [] } } }),
      'fork',
    );

    expect(document).toContain('None could be read from the source session.');
    expect(document).toContain('before assuming this conversation started empty');
  });

  it('lists the attachments that crossed and marks the ones that will ask for a password again', () => {
    const document = renderTransferBrief(
      plan({
        facets: {
          ...plan().facets,
          attachments: {
            attachments: [
              {
                id: `att_${'a'.repeat(64)}`,
                filename: 'notes.pdf',
                mime: 'application/pdf',
                size: 1024,
                sha256: 'a'.repeat(64),
                createdAt: AT,
                encrypted: { kind: 'pdf', locked: true },
              },
              {
                id: `att_${'b'.repeat(64)}`,
                filename: 'plain.txt',
                mime: 'text/plain',
                size: 12,
                sha256: 'b'.repeat(64),
                createdAt: AT,
                encrypted: null,
              },
            ],
          },
        },
      }),
      'fork',
    );

    expect(document).toContain('## Attachments carried');
    expect(document).toContain(
      '- `notes.pdf` (application/pdf, 1024 bytes) (encrypted — it asks for its password again here)',
    );
    expect(document).toContain('- `plain.txt` (text/plain, 12 bytes)\n');
  });

  it('omits the attachment section entirely when none crossed', () => {
    expect(renderTransferBrief(plan(), 'fork')).not.toContain('## Attachments carried');
  });

  it('renders the plan’s omission list, one line each, and never a second computation of it', () => {
    const document = renderTransferBrief(
      plan({
        notCarried: [
          { facet: 'workspace', subject: '/work/repo', reason: 'not_implemented', detail: 'time was rewound' },
          { facet: 'references', subject: '&task', reason: 'session_scoped', detail: 'the board is empty here' },
        ],
      }),
      'fork',
    );

    expect(document).toContain('- **workspace** `/work/repo` — _not_implemented_: time was rewound');
    expect(document).toContain('- **references** `&task` — _session_scoped_: the board is empty here');
  });

  it('says plainly when nothing was left behind', () => {
    expect(renderTransferBrief(plan(), 'fork')).toContain('Nothing: every facet crossed intact.');
  });
});
