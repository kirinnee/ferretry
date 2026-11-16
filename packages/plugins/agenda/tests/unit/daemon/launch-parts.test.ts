import { describe, expect, test } from 'bun:test';
import type { LaunchSpec } from '@ferretry/core-ferrets/contract';
import { AGENDA_ENV, agendaLaunchPart } from '../../../daemon/lib/launch-parts.ts';

const spec = (ferret: string): Omit<LaunchSpec, 'parts'> => ({ ferret }) as unknown as Omit<LaunchSpec, 'parts'>;

describe('agenda launch.parts: FY_AGENDA', () => {
  test('a ferret with agenda mode on is launched with FY_AGENDA=1', async () => {
    const part = agendaLaunchPart(async () => true);
    expect(AGENDA_ENV).toBe('FY_AGENDA');
    expect(await part.parts(spec('f1'))).toEqual([{ kind: 'env', env: { FY_AGENDA: '1' } }]);
  });

  test('a ferret with agenda mode off is launched with FY_AGENDA=0, asked by its own id', async () => {
    const asked: string[] = [];
    const part = agendaLaunchPart(async ferret => {
      asked.push(ferret);
      return false;
    });
    expect(await part.parts(spec('f2'))).toEqual([{ kind: 'env', env: { FY_AGENDA: '0' } }]);
    expect(asked).toEqual(['f2']);
  });
});
