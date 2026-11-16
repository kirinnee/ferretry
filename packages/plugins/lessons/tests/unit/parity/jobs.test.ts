/**
 * The Lessons-owned J row of docs/design/rebuild-parity.tsv. Today's `run: spawn => miner.run(spawn)` is
 * `POST /v1/lessons/run` → `LessonsMiner.run(spawn)`: no timer arms it (today's learning module had no jobs either).
 */
import { describe, expect, test } from 'bun:test';
import { owner } from '@ferretry/kernel/testing';
import { LESSONS_MINER_GAP_CODE } from '../../../contract/index.ts';
import { lessonsHost } from './host.ts';

describe('the lessons run', () => {
  test('J-0040 the run arm is miner.run(spawn): no job is scheduled, an ingest-only run folds and answers', async () => {
    const { host } = await lessonsHost();
    expect(host.jobIds()).toEqual([]);
    const ingest = await host.request('POST', '/v1/lessons/run', { as: owner(), body: { spawn: false } });
    expect(ingest.status).toBe(200);
  });

  test('J-0040 a spawning run refuses with the miner gap rather than start a miner in an owner’s project', async () => {
    const { host, ferrets } = await lessonsHost();
    const spawn = await host.request('POST', '/v1/lessons/run', { as: owner(), body: { spawn: true } });
    expect(spawn.status).toBe(503);
    expect(JSON.parse(String(spawn.body)).code).toBe(LESSONS_MINER_GAP_CODE);
    expect(ferrets.starts).toEqual([]);
  });

  test.skip('J-0040 a spawning run starts a miner in Lessons’ own folder … pending port: Ferrets start work folder (D2 #19)', () => {});
});
