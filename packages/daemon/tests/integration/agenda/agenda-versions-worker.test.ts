import { it } from 'bun:test';
import should from 'should';
import { bundledWorkerUrl, probeBundledWorker } from '../../../src/adapters/runtime/bundled-worker.ts';
import { agendaVersionsWorkerContract } from '../../support/agenda-versions-worker-contract.ts';

agendaVersionsWorkerContract();

it('embeds the agenda archive worker at the compiled URL and answers the self-check probe', async () => {
  should(bundledWorkerUrl('agenda-versions', 'file:///$bunfs/root/fyd.js')).equal(
    'file:///$bunfs/root/agenda-versions.worker.js',
  );
  should(await probeBundledWorker('agenda-versions')).deepEqual({ name: 'agenda-versions', ready: true });
});
