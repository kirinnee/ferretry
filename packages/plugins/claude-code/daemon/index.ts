import type { ConfigCollectionDef, ConfigFileDef } from '@ferretry/kernel/contract';
import { implementDaemon } from '@ferretry/kernel/manifest';
import { milliseconds } from '@ferretry/std';
import {
  CLAUDE_CODE_CONFIG,
  CLAUDE_CODE_DISCOVERY,
  CLAUDE_CODE_HOOKS,
  CLAUDE_CODE_SETTINGS,
  ClaudeCodeUpdateFinished,
  type Discovery,
  type HarnessConfig,
  type HarnessCliView,
  type HooksItem,
  type SettingsItem,
} from '../contract/index.ts';
import manifest from '../manifest.ts';
import { ClaudeHarness } from './adapters/claude-harness.ts';
import { PaneDirectory, TmuxPane } from './adapters/tmux-pane.ts';
import { factsSource, hostFacts, locationSource, npmLatest, probe, spawnRun } from './adapters/update-ports.ts';
import { DialogAnswerService } from './lib/dialog/service.ts';
import { PermissionAnswerService } from './lib/permission/service.ts';
import { isConversationId } from './lib/harness/claude-path.ts';
import { fastStartDecision } from './lib/harness/fast-mode.ts';
import { claudeHooksSource, claudeSettingsSource } from './lib/profile-components.ts';
import { ClaudeProjectApprovals } from './lib/project-approvals.ts';
import { dialogRoute, permissionRoute, promptRoute, updateStartRoute, updateViewRoute } from './lib/routes.ts';
import { HarnessUpdateService } from './lib/update/service.ts';

/** The product name the verification link is built from. */
const PRODUCT = 'ferretry';

const configFile = CLAUDE_CODE_CONFIG as unknown as ConfigFileDef<HarnessConfig>;

/** What discovery last found, from a view (never the harness's sign-in files). */
const discoveryOf = (view: HarnessCliView, checkedAt: Discovery['checkedAt']): Discovery => ({
  format: 1,
  checkedAt,
  location: view.location,
  installed: view.installed,
  method: view.method,
});

/**
 * Claude Code's daemon half: the harness it provides to Ferrets, the update view others may read, and the three
 * governed answers (the update, the permission prompt, the harness dialog). It needs nothing; it reaches the
 * runner a ferret runs in only through the one Ferrets hands it at a start.
 *
 * `approvedProjectServers` is MCP's question "did this ferret's Claude approve, leave pending or DISABLE a project
 * server?", answered from this plugin's own ferret home through the same root the harness writes it with
 * (`agent-homes`, scoped to that ferret), so MCP holds no root over a harness home.
 */
export default implementDaemon(manifest, {
  build: ({ kernel, needs }) => {
    const host = hostFacts(kernel.spawn);
    const location = locationSource(kernel.spawn, () => kernel.config.file(configFile), host);
    const inner = new HarnessUpdateService({
      product: PRODUCT,
      location,
      facts: factsSource(kernel.spawn, host),
      probe: probe(kernel.spawn),
      latest: npmLatest(kernel.fetch, `${PRODUCT} (claude-code plugin)`),
      run: spawnRun(kernel.spawn),
      clock: { now: () => kernel.clock.nowMs() },
      checks: true,
    });
    // An update that ends is announced after its write.
    const update = {
      view: () => inner.view(),
      settled: () => inner.settled(),
      start: async (request: Parameters<HarnessUpdateService['start']>[0]) => {
        const view = await inner.start(request);
        void inner.settled().then(async () => {
          const job = (await inner.view()).job;
          if (job?.state === 'finished')
            kernel.events.publish(ClaudeCodeUpdateFinished, {
              outcome: job.report.outcome,
              finishedAt: job.report.finishedAt,
            });
        });
        return view;
      },
    };

    const panes = new PaneDirectory();
    const pane = new TmuxPane(kernel.spawn, panes);
    const sleep = async (ms: number): Promise<void> => await kernel.clock.sleep(milliseconds(ms));
    // The harness's own plain-name guard (`ClaudeHarness.home`): a multi-part id would name a folder inside another home.
    const approvals = new ClaudeProjectApprovals(
      ferret => {
        if (!isConversationId(ferret)) throw new Error('the ferret id must be one plain name');
        return kernel.roots.root('agent-homes', { ferret, subfolder: ferret });
      },
      () => kernel.roots.root('agent-homes'),
    );
    const permission = new PermissionAnswerService(pane, sleep);
    const dialog = new DialogAnswerService(pane, sleep);

    const harness = new ClaudeHarness({
      roots: kernel.roots,
      config: kernel.config,
      state: kernel.state,
      spawn: kernel.spawn,
      clock: kernel.clock,
      redaction: kernel.redaction,
      location,
      probe: probe(kernel.spawn),
      update,
      panes,
      permission,
      dialog,
      newConversationId: () => crypto.randomUUID(),
      historyHome: async () => {
        const directory = await host.home();
        return directory.startsWith('/') ? `${directory.replace(/\/+$/u, '')}/.claude` : '';
      },
    });

    return {
      routes: {
        'GET /v1/claude-code/update': updateViewRoute(update),
        'POST /v1/claude-code/update': updateStartRoute(update),
        'GET /v1/ferrets/:ferretId/prompt': promptRoute(needs.ferrets),
        'POST /v1/ferrets/:ferretId/permission': permissionRoute(permission),
        'POST /v1/ferrets/:ferretId/dialog': dialogRoute(dialog),
      },
      provides: {
        claudeCode: {
          view: async () => {
            const view = await update.view();
            await kernel.state.write(CLAUDE_CODE_DISCOVERY, discoveryOf(view, kernel.clock.now()));
            return view;
          },
          discovery: async () => {
            const read = await kernel.state.read(CLAUDE_CODE_DISCOVERY);
            return read.ok ? read.value : undefined;
          },
          approvedProjectServers: async query => await approvals.approvedProjectServers(query),
        },
      },
      hooks: {
        'harnesses:claude-code': harness,
        // Runtimes' read of the `settings` and `hooks` components a profile names for Claude: this plugin's own items,
        // live, no cache.
        'runtimes.components.settings.claude:components': claudeSettingsSource(() =>
          kernel.config.collection(CLAUDE_CODE_SETTINGS as ConfigCollectionDef<SettingsItem>),
        ),
        'runtimes.components.hooks.claude:components': claudeHooksSource(() =>
          kernel.config.collection(CLAUDE_CODE_HOOKS as ConfigCollectionDef<HooksItem>),
        ),
        // A fast start on a model without fast mode is refused before anything is written (today's fyd start refusal).
        'start.decide': fastStartDecision,
      },
    };
  },
});
