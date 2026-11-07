import type { ConfigFileDef } from '@ferretry/kernel/contract';
import { implementDaemon } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import {
  CODEX_CONFIG,
  CODEX_DISCOVERY,
  CodexUpdateFinished,
  type CodexApi,
  type Discovery,
  type HarnessConfig,
  HarnessConfigSchema,
} from '../contract/index.ts';
import { codexHarness } from './adapters/codex-harness.ts';
import { HostCodexFacts } from './adapters/facts.ts';
import { HostPrograms } from './adapters/host-programs.ts';
import { NpmCodexLatest } from './adapters/npm-latest.ts';
import { packageRunner } from './adapters/package-run.ts';
import { HostCodexProbe } from './adapters/probe.ts';
import { codexUpdateRoutes, HarnessUpdateService, locateCodex } from './lib/index.ts';
import { codexProjectApprovals } from './lib/project-approvals.ts';

export default implementDaemon(manifest, {
  build(ctx) {
    const { kernel } = ctx;
    const host = new HostPrograms(kernel.spawn);

    // `config/harness-codex.yaml`, read each time so an edit is seen on the next look.
    const paths = () =>
      HarnessConfigSchema.parse(kernel.config.file(CODEX_CONFIG as ConfigFileDef<HarnessConfig>) ?? {});
    let home: Promise<string> | undefined;
    const homeDirectory = async (): Promise<string> => {
      home ??= host.environment('HOME').then(value => value ?? '');
      return await home;
    };
    const locate = async () => {
      const configured = paths();
      return await locateCodex(
        { binary: configured.binary, searchPaths: configured.searchPaths },
        host,
        await homeDirectory(),
      );
    };

    const probeHome = kernel.roots.root('agent-homes', { subfolder: 'probe' }).resolve('');
    if (!probeHome.ok) throw new Error(`Codex's probe home could not be placed: ${probeHome.error}`);
    const probe = new HostCodexProbe(kernel.spawn, host, probeHome.value);

    const service = new HarnessUpdateService({
      product: 'ferretry',
      homeDirectory,
      locate,
      facts: new HostCodexFacts(host),
      probe,
      latest: new NpmCodexLatest(kernel.fetch, kernel.clock, 'ferretry'),
      executables: host,
      run: packageRunner(kernel.spawn, kernel.clock, host),
      nowMs: () => kernel.clock.nowMs(),
      checks: true,
    });

    // Looking is when discovery is recorded: what was found, never anything read from Codex's sign-in files.
    const view: CodexApi['view'] = async () => {
      const seen = await service.view();
      const found: Discovery = {
        format: 1,
        checkedAt: kernel.clock.now(),
        location: seen.location,
        installed: seen.installed,
        method: seen.method,
      };
      await kernel.state.write(CODEX_DISCOVERY, found);
      return seen;
    };
    const discovery: CodexApi['discovery'] = async () => {
      const read = await kernel.state.read(CODEX_DISCOVERY);
      return read.ok ? read.value : undefined;
    };

    const start: typeof service.start = async request => {
      const result = await service.start(request);
      void service
        .settled()
        .then(async () => {
          const job = (await service.view()).job;
          if (job?.state === 'finished')
            kernel.events.publish(CodexUpdateFinished, {
              outcome: job.report.outcome,
              finishedAt: job.report.finishedAt,
            });
        })
        .catch(() => kernel.log.warn('Codex update completion could not be reported'));
      return result;
    };
    const routes = codexUpdateRoutes({ view, start });

    return {
      routes,
      // `approvedProjectServers` is always `not-taken` (Codex takes no `.mcp.json` server's sign-in, as today); MCP
      // answers `not-taken` for a Codex launch without asking, so this is the contract's answer, not MCP's gate.
      provides: { codex: { view, discovery, approvedProjectServers: codexProjectApprovals } },
      hooks: {
        'harnesses:codex': codexHarness({
          kernel,
          locate,
          probe,
          permissionMode: () => paths().permissionMode,
          historyDirectory: async () => {
            const home = await homeDirectory();
            return home === '' ? undefined : `${home}/.codex/sessions`;
          },
          update: { view, start, settled: () => service.settled() },
        }),
      },
    };
  },
});
