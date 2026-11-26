import { expect, test } from 'bun:test';
import { ResumeSessionController } from '../../../cli/lib/session/lifecycle-controllers.ts';
import { RestartController } from '../../../cli/lib/restart/controller.ts';
import { capturedPresenter, RecordingApi } from './session/controller-doubles.ts';
import { sessionView } from './session/session-fixtures.ts';
import { RecordingRestartGateway } from './restart/fixtures.ts';

const notice = "Started without Fast: Codex's model list is still loading; try again in a few seconds";
for (const json of [false, true]) {
  test(`E-266 R2 resume shows its fallback sentence and keeps stdout JSON clean (${json})`, async () => {
    const { io, presenter } = capturedPresenter();
    const api = new RecordingApi({ get: sessionView() });
    api.resume = async () => ({ id: 'wren', notice });
    await new ResumeSessionController(api, presenter).execute('wren', { json });
    expect(io.err.join('\n')).toContain(notice);
    if (json) expect(() => JSON.parse(io.out.join('\n'))).not.toThrow();
  });
  test(`E-266 R2 restart shows each ferret's persisted fallback sentence (${json})`, async () => {
    const { io, presenter } = capturedPresenter();
    const result = { restarted: [{ id: 'wren', notice }], queued: [], skipped: [], failed: [] };
    await new RestartController(new RecordingRestartGateway(result), presenter).execute(['wren'], { json });
    expect(io.out.join('\n')).toContain(notice);
    if (json) expect(JSON.parse(io.out.join('\n'))).toEqual(result);
  });
}
