import { describe, it } from 'bun:test';
import should from 'should';
import * as refs from '../../src/lib/board-refs.ts';
import {
  BOARD_TASK_ID_PATTERN,
  BoardProjectIdSchema,
  BoardTaskIdSchema,
  boardErr,
  boardOk,
  formatTaskRef,
  MachineIdSchema,
  parseTaskRef,
  TaskRefSchema,
  UNFILED_PROJECT_ID,
} from '../../src/lib/board-refs.ts';
import { SessionConfigSchema } from '../../src/lib/session.ts';
import { sessionView } from '../fixtures.ts';
import { TaskIdSchema } from '../../src/lib/tasks.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const VALID: readonly SchemaCase[] = [
  { name: 'id', schema: BoardTaskIdSchema, value: 'F412' },
  { name: 'machine', schema: MachineIdSchema, value: 'mac' },
  { name: 'local ref', schema: TaskRefSchema, value: { id: 'B1' } },
  { name: 'remote ref', schema: TaskRefSchema, value: { machineId: 'kirin-box', id: 'C999999999' } },
  { name: 'project id', schema: BoardProjectIdSchema, value: '00000000-0000-4000-8000-000000000001' },
  { name: 'unfiled', schema: BoardProjectIdSchema, value: UNFILED_PROJECT_ID },
];

const INVALID: readonly SchemaCase[] = [
  { name: 'zero', schema: BoardTaskIdSchema, value: 'F0' },
  { name: 'leading zero', schema: BoardTaskIdSchema, value: 'F01' },
  { name: 'unknown kind', schema: BoardTaskIdSchema, value: 'X1' },
  { name: 'ten digits', schema: BoardTaskIdSchema, value: 'F1234567890' },
  { name: 'lowercase', schema: BoardTaskIdSchema, value: 'f1' },
  { name: 'blank machine', schema: MachineIdSchema, value: '  ' },
  { name: 'stray field', schema: TaskRefSchema, value: { id: 'F1', session: 's' } },
  { name: 'not a project', schema: BoardProjectIdSchema, value: 'ferretry' },
];

describe('board task refs', () => {
  it('should round-trip every valid ref shape and refuse the rest', () => {
    assertRoundTrips(VALID);
    assertRejects(INVALID);
    assertCoversEverySchema(refs, VALID);
  });

  it('should keep the board id the same shape as the v1 id it replaces', () => {
    // Arrange
    const samples = ['F1', 'B999999999', 'I42', 'C7', 'F0', 'F01', 'X1', 'F1234567890', 'f1', '', 'F 1'];

    // Act
    const disagreements = samples.filter(
      sample => BoardTaskIdSchema.safeParse(sample).success !== TaskIdSchema.safeParse(sample).success,
    );

    // Assert
    should(disagreements).deepEqual([]);
    should(BOARD_TASK_ID_PATTERN.source).equal('^[BFIC][1-9][0-9]{0,8}$');
  });

  it('should write a ref with the task sigil and never the machine', () => {
    should(formatTaskRef({ id: 'F412' })).equal('&F412');
    should(formatTaskRef({ machineId: 'mac', id: 'B3' })).equal('&B3');
  });

  it('should read the current, retired and bare forms in any case', () => {
    for (const input of ['&F412', '#F412', 'F412', 'f412', '&f412', '  #f412 ']) {
      should(parseTaskRef(input)).deepEqual({ ok: true, value: { id: 'F412' } });
    }
  });

  it('should refuse empty and malformed input without throwing', () => {
    should(parseTaskRef('   ')).deepEqual({ ok: false, error: { code: 'empty' } });
    for (const input of ['&&F1', '!A3', 'F0', '&F', 'F1 F2', '@F1']) {
      should(parseTaskRef(input)).deepEqual({ ok: false, error: { code: 'malformed', input } });
    }
  });

  it('should build both rails of a result', () => {
    should(boardOk(1)).deepEqual({ ok: true, value: 1 });
    should(boardErr('no')).deepEqual({ ok: false, error: 'no' });
  });
});

describe('a session’s board and focus card', () => {
  const PROJECT = '00000000-0000-4000-8000-000000000001';

  it('should keep the project and the focus card a session config names', () => {
    // Act
    const config = SessionConfigSchema.parse({ ...sessionView.config, projectId: PROJECT, focusTask: { id: 'F12' } });

    // Assert
    should(config.projectId).equal(PROJECT);
    should(config.focusTask).deepEqual({ id: 'F12' });
    should(SessionConfigSchema.parse({ ...sessionView.config, projectId: UNFILED_PROJECT_ID }).projectId).equal(
      'unfiled',
    );
  });

  it('should read a session from before boards as having neither', () => {
    // Act
    const config = SessionConfigSchema.parse(sessionView.config);

    // Assert
    should(config.projectId).be.undefined();
    should(config.focusTask).be.undefined();
  });

  it('should refuse a malformed project or focus card', () => {
    should(SessionConfigSchema.safeParse({ ...sessionView.config, projectId: 'ferretry' }).success).be.false();
    should(SessionConfigSchema.safeParse({ ...sessionView.config, focusTask: '&F12' }).success).be.false();
  });
});
