import { describe, expect, it } from 'bun:test';
import type { AgendaCall } from '../../../app/lib/agenda-call.ts';
import { DaemonResponseError } from '../../../app/lib/agenda-call.ts';
import { AgendaFleet } from '../../../app/lib/agenda-fleet.ts';
import { answerFilePorts } from '../../../app/lib/answer-file-ports.ts';
import { daemonConnection, daemonId } from '../../../app/lib/machine.ts';

const here = daemonConnection({ daemonId: 'here' });
const there = daemonConnection({ daemonId: 'there' });
const nowhere = daemonConnection({ daemonId: 'nowhere' });

const VIEW = {
  id: `att_${'b'.repeat(64)}`,
  filename: 'blank.png',
  mime: 'image/png',
  size: 3,
  sha256: '0'.repeat(64),
  createdAt: '2026-10-30T10:00:00.000Z',
};

const recording = (answer: unknown = VIEW) => {
  const calls: Array<{ route: string; init: unknown }> = [];
  const client: AgendaCall = {
    call: async (route, init) => {
      calls.push({ route, init });
      return answer as never;
    },
  };
  return { calls, client };
};

describe('the answer-file ports', () => {
  it('uploads through Conversation’s route by its key, into the card’s ferret, as inline base64', async () => {
    const page = recording();
    const ports = answerFilePorts({ daemon: daemonId('here'), client: page.client });
    const stored = await ports.uploadAttachment(here, 'sess-g', new File(['png'], 'blank.png', { type: 'image/png' }));
    expect(stored.id).toBe(VIEW.id);
    expect(page.calls).toEqual([
      {
        route: 'POST /v1/ferrets/:ferretId/attachments',
        init: {
          params: { ferretId: 'sess-g' },
          body: { filename: 'blank.png', mime: 'image/png', base64: btoa('png') },
        },
      },
    ]);
  });

  it('names an untyped file as raw bytes', async () => {
    const page = recording();
    await answerFilePorts({ daemon: daemonId('here'), client: page.client }).uploadAttachment(
      here,
      's',
      new File(['x'], 'notes'),
    );
    expect(page.calls[0]?.init).toMatchObject({ body: { mime: 'application/octet-stream' } });
  });

  it('goes through the client of the card’s machine: the page’s own, or the fleet’s for another', async () => {
    const page = recording();
    const other = recording();
    const fleet = new AgendaFleet();
    fleet.clientOf = daemon => (daemon === daemonId('there') ? other.client : undefined);
    const ports = answerFilePorts({ daemon: daemonId('here'), client: page.client }, fleet);
    await ports.uploadAttachment(there, 's', new File(['x'], 'a.png', { type: 'image/png' }));
    expect(page.calls).toHaveLength(0);
    expect(other.calls).toHaveLength(1);
    expect(await ports.answerFiles(here)).toBe(true);
    expect(await ports.answerFiles(there)).toBe(true);
  });

  it('takes no files for a machine this device holds no client for, and uploads nothing there', async () => {
    const page = recording();
    const ports = answerFilePorts({ daemon: daemonId('here'), client: page.client }, new AgendaFleet());
    expect(await ports.answerFiles(nowhere)).toBe(false);
    await expect(ports.uploadAttachment(nowhere, 's', new File(['x'], 'a.png'))).rejects.toThrow('not reachable');
    expect(page.calls).toHaveLength(0);
  });

  it('refuses an answer that is no attachment, and passes the daemon’s refusal on', async () => {
    const odd = recording({ ok: true });
    await expect(
      answerFilePorts({ daemon: daemonId('here'), client: odd.client }).uploadAttachment(
        here,
        's',
        new File(['x'], 'a'),
      ),
    ).rejects.toThrow();
    const refusing: AgendaCall = {
      call: async () => {
        throw Object.assign(new Error('unsupported'), { status: 415, code: 'unsupported_mime' });
      },
    };
    await expect(
      answerFilePorts({ daemon: daemonId('here'), client: refusing }).uploadAttachment(here, 's', new File(['x'], 'a')),
    ).rejects.toBeInstanceOf(DaemonResponseError);
  });
});
