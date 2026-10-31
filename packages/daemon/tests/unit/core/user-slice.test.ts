import { describe, it } from 'bun:test';
import should from 'should';
import { readUserSlice, type UserSliceReading, userSliceChecks } from '../../../src/lib/core/user-slice.ts';

const base = { uid: 1001, user: 'alice' } as const;

describe('shared-host user slice rows', () => {
  it('should say nothing when the host reported nothing', () => {
    should(userSliceChecks(undefined)).deepEqual([]);
    should(userSliceChecks(base)).deepEqual([]);
  });

  it('should warn with the guide’s command when memory is unlimited', () => {
    const rows = userSliceChecks({ ...base, memoryMax: 'max', tasksMax: '4096' });

    should(rows).have.length(1);
    should(rows[0]?.name).equal('user slice limits');
    should(rows[0]?.requirement).equal('optional');
    should(rows[0]?.status).equal('missing');
    should(rows[0]?.summary).equal('user-1001.slice has no MemoryMax');
    should(rows[0]?.impact).match(
      /sudo systemctl set-property user-1001\.slice MemoryMax=12G TasksMax=4096 CPUWeight=100/u,
    );
  });

  it('should name both limits when neither is set, and read infinity as unlimited', () => {
    const rows = userSliceChecks({ ...base, memoryMax: 'infinity', tasksMax: 'max' });

    should(rows[0]?.summary).equal('user-1001.slice has no MemoryMax or TasksMax');
  });

  it('should name only TasksMax when only the task cap is missing', () => {
    const rows = userSliceChecks({ ...base, memoryMax: '12884901888', tasksMax: 'max' });

    should(rows[0]?.summary).equal('user-1001.slice has no TasksMax');
  });

  it('should report a capped slice as fine, even when only one controller answered', () => {
    for (const reading of [
      { ...base, memoryMax: '12884901888', tasksMax: '4096' },
      { ...base, tasksMax: '4096' },
    ] satisfies readonly UserSliceReading[]) {
      const rows = userSliceChecks(reading);
      should(rows.map(row => [row.name, row.status])).deepEqual([['user slice limits', 'present']]);
    }
  });

  it('should warn when linger is off, naming the user and the guide’s command', () => {
    const rows = userSliceChecks({ ...base, linger: false });

    should(rows).have.length(1);
    should(rows[0]?.name).equal('linger');
    should(rows[0]?.status).equal('missing');
    should(rows[0]?.summary).equal('linger is off for alice');
    should(rows[0]?.impact).match(/sudo loginctl enable-linger alice/u);
  });

  it('should report linger on as fine', () => {
    const rows = userSliceChecks({ ...base, linger: true });

    should(rows.map(row => [row.name, row.status])).deepEqual([['linger', 'present']]);
  });
});

describe('reading the user slice', () => {
  const reading: UserSliceReading = { ...base, memoryMax: 'max', linger: false };

  it('should ask on a Linux host whose browser ports are not random', async () => {
    let asked = 0;
    const result = await readUserSlice('linux', async () => 'per-user', {
      read: async () => {
        asked += 1;
        return reading;
      },
    });

    should(result).equal(reading);
    should(asked).equal(1);
  });

  it('should never ask on a single-user host, an unreadable setting, or another operating system', async () => {
    let asked = 0;
    const reader = {
      read: async () => {
        asked += 1;
        return reading;
      },
    };

    should(await readUserSlice('linux', async () => 'random', reader)).equal(undefined);
    should(
      await readUserSlice(
        'linux',
        async () => {
          throw new Error('unreadable');
        },
        reader,
      ),
    ).equal(undefined);
    should(await readUserSlice('darwin', async () => 'per-user', reader)).equal(undefined);
    should(asked).equal(0);
  });

  it('should answer nothing when the reader fails', async () => {
    const result = await readUserSlice('linux', async () => 'per-user', {
      read: async () => {
        throw new Error('no systemd');
      },
    });

    should(result).equal(undefined);
  });
});
