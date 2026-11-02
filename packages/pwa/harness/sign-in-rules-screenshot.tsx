/**
 * Screenshots of the standing sign-in rule screens (docs/secure-copy.md "Standing sign-in rules"), at a 390px phone
 * and a 1440px desktop, in the light and dark studio themes. Review evidence; nothing compares the PNGs.
 *
 *   bun harness/sign-in-rules-screenshot.tsx [out-dir] [states]   # writes sign-in-rules-<state>-<viewport>-<scheme>.png
 *
 * `states` is a comma list of: create-page, create-totp, create-terminal, ineligible, suggestion, passkey, machine,
 * settings, suspended, narrow, site-panel, edit-warning, fallback, history, device-revoke, replaces, filled, widen, rule-card, narrow-hours, revoke-all, passkey-flags, needs-update,
 * deep-link-elsewhere.
 * "create-*" are the owner's sheet (a page rule, a page rule with the code ticked and its red acknowledgement, a sudo
 * rule with the root flag); "ineligible" is the sheet for a sign-in that cannot have a rule; "suggestion" is a
 * ferret's card, nothing ticked; "passkey" is the passkey sheet with the daemon's own words for a root stage;
 * "machine" is a rule staged with `fy rules add`; "settings" is Settings › Secure copy › Standing rules; "suspended"
 * and "narrow" are the rule card; "site-panel" and "edit-warning" are the Accounts site's Rule and Method tabs;
 * "fallback" is the input card for a rule that did not apply; "history" is the closed card of a fill that did;
 * "device-revoke" is Settings › Devices with the rules a device's passkey approved; "replaces" is a ferret's suggestion
 * opened for a sign-in that already has a rule (it renews it, never a second rule); "filled" is the owner's input card
 * a rule filled, with the place. "widen" clicks Change (passkey) on the real Accounts Rule tab, so it is the real sheet with the real host props; "rule-card" is the card
 * with its Change button; "narrow-hours" is the narrow form ending in hours; "revoke-all" is an account's revoke-all
 * confirm; "passkey-flags" is the passkey sheet with the red root block and the amber cautions apart; "needs-update"
 * is the one line a machine too old for a feature shows; "deep-link-elsewhere" is the toast for a link to another machine.
 *
 * Fake fixtures only: no real account, no daemon, no value. Every width asserts no sideways scroll and the touch floor
 * on every button and checkbox of the phone.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out');
const outDir = resolve(process.argv[2] ?? buildDir);

const fail = (message: string): never => {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(1);
};

const run = (command: string, args: readonly string[]): void => {
  const result = spawnSync(command, args, { cwd: packageDir, stdio: 'inherit' });
  if (result.status !== 0) fail(`${command} exited ${result.status}`);
};

const PAGE_ENTRY = `
import { createRoot } from 'react-dom/client';
import { DAEMON_CAPABILITIES } from '@ferretry/protocol';
import { Markdown } from '../../src/components/markdown.tsx';
import { AccountRulesRevoke } from '../../src/features/accounts/account-rules.tsx';
import { SignInRuleCard } from '../../src/features/accounts/sign-in-rule-card.tsx';
import { SignInRuleSheet } from '../../src/features/accounts/sign-in-rule-sheet.tsx';
import { SiteDetail } from '../../src/features/accounts/site-detail.tsx';
import { AgendaItemView } from '../../src/features/agenda/agenda-item-view.tsx';
import { AgendaSettled } from '../../src/features/agenda/agenda-settled.tsx';
import { InputCard } from '../../src/features/input-request/input-card.tsx';
import { DeviceRuleNote } from '../../src/features/secure-copy/device-rule-note.tsx';
import { SignInRuleSuggestionHost } from '../../src/features/secure-copy/sign-in-rule-suggestion-host.tsx';
import { MachineRuleStage, SignInRulesSurface } from '../../src/features/secure-copy/sign-in-rules-surface.tsx';
import { DaemonSettingsFrame } from '../../src/features/settings/daemon-settings-frame.tsx';
import { ActionToast } from '../../src/features/session-actions/action-toast.tsx';
import { AddDeviceCard } from '../../src/features/settings/add-device-settings.tsx';
import { StepUpDialog } from '../../src/features/step-up/step-up-dialog.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { fieldsOf } from '../../src/lib/input-card.ts';
import { passkeyWords, RULE_LINKED_ELSEWHERE_WORDS } from '../../src/lib/sign-in-rules.ts';
import { DaemonClientProvider } from '../../src/lib/store.tsx';
import { healthOf } from '../../tests/support/health.ts';
import { StepUpGate } from '../../src/lib/step-up-gate.ts';
import { list as accountList } from '../../tests/support/accounts-fixtures.ts';
import { NOW, request as fakeRequest } from '../../tests/support/input-fixtures.ts';
import {
  RULE_ID, SITE_SIGN_IN, STAGE_ID, codeRule, machineStage, pageRule, ruleList, sitePlace, sudoPlace,
  stagedRule, suggestion, suspendedRule, terminalRule,
} from '../../tests/support/sign-in-rule-fixtures.ts';

const view = new URLSearchParams(location.search).get('view');
const connection = daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.example', deviceId: 'phone-1' });
const quiet = () => undefined;
const accounts = accountList();

const rulesFor = () => {
  switch (view) {
    case 'settings': return { rules: [pageRule(), codeRule(), terminalRule(), suspendedRule2()], stages: [machineStage()] };
    case 'rule-card': case 'revoke-all': return { rules: [pageRule(), pageRule({ id: 'sr_' + 'e'.repeat(24), signIn: 'si_0000000000000009' })], stages: [] };
    case 'widen': return { rules: [pageRule({ uses: 5, remaining: 2 })], stages: [] };
    case 'site-panel': case 'edit-warning': case 'device-revoke': return { rules: [pageRule(), terminalRule()], stages: [] };
    default: return { rules: [], stages: [] };
  }
};
function suspendedRule2() {
  return {
    ...suspendedRule(), id: 'sr_' + 'f'.repeat(24), signIn: 'si_0000000000000004',
    account: { id: 'VERCEL_WORK', label: 'vercel work' }, place: { kind: 'site', domains: ['vercel.com'], match: [] },
  };
}

const answerFor = (path, method) => {
  if (path === '/v1/accounts') return accounts;
  if (path === '/v1/sign-in-rules') return ruleList(rulesFor());
  if (path.startsWith('/v1/sign-in-rules/eligibility')) return eligible;
  if (path === '/v1/sign-in-rules/suggestions') return { suggestions: [suggestion()] };
  throw new Error('the harness has no answer for ' + method + ' ' + path);
};
const client = {
  request: async (path, schema, init) => schema.parse(answerFor(path, init?.method ?? 'GET')),
};

const eligible = { signIn: SITE_SIGN_IN, eligible: true, history: 3 };
const sheet = (extra = {}) => (
  <div className="fy-card" data-harness-card="">
    <SignInRuleSheet accountName={view === 'create-terminal' ? 'kirin' : 'github work'} autoRecipe={false} canUsePasskey codeAvailable eligibility={eligible}
      onApprove={quiet} onCancel={quiet} origin="owner" phase={{ kind: 'idle' }} place={sitePlace}
      codeKey="GitHub authenticator" scopes={[{ kind: 'any' }]} username="kirin@atomi.cloud" {...extra} />
  </div>
);
const ruleCard = rule => (
  <div className="fy-card" data-harness-card="">
    <SignInRuleCard busy={false} canUsePasskey onNarrow={quiet} onReapprove={quiet} onRevoke={quiet} rule={rule} />
  </div>
);

const ops = new Proxy({}, { get: () => async () => false });
const site = tab => (
  <div className="fy-card" data-harness-card="">
    <SiteDetail account={accounts.accounts[0]} accounts={accounts.accounts} busy={false}
      defaults={{ kind: 'read', file: {} }} error={null} onClosed={quiet} onTab={quiet} ops={ops}
      rules={{ client, askPasskey: async () => true }} signIn={accounts.signIns[0]} tab={tab} />
  </div>
);

const DEVICE_ID = 'fy_device_id_AAAAAAAAAAAAAAAAAAAAAA';
const grants = Object.fromEntries(DAEMON_CAPABILITIES.map(capability => [capability, { use: capability === 'fleet', configure: false }]));
const devices = {
  devices: [{ id: DEVICE_ID, name: 'Kirin’s phone', platform: 'browser', createdAt: '2026-10-01T09:00:00.000Z',
    lastSeenAt: '2026-11-01T09:00:00.000Z', idleExpiresAt: '2027-01-01T00:00:00.000Z', grants }],
  hostLocal: true, thisDeviceId: 'fy_device_id_BBBBBBBBBBBBBBBBBBBBBB', mayWiden: grants,
};

const item = {
  id: 'A8', source: 'question', sourceRef: 'rule', sourceSeq: 2, kind: 'input', input: { requestId: 'in_filled' },
  title: 'Needs your password', subject: 'A password prompt in your terminal', why: 'A password prompt in your terminal',
  context: 'The agent says: it needs to deploy.', neededBy: '2026-11-01T11:00:00.000Z', waitingSince: '2026-11-01T09:00:00.000Z',
  raisedBy: 'daemon', raisedBySession: 'sess-1',
};
const itemView = (extra, shown = item) => (
  <div style={{ height: '100vh', display: 'grid' }}>
    <AgendaItemView busy={false} error={null} ferret="Hadi" history={[]} item={shown} now={NOW} onAct={quiet}
      onClose={quiet} position={{ index: 0, total: 1 }} renderProse={text => <Markdown text={text} />} swipeable={false} {...extra} />
  </div>
);

if (view === 'passkey' || view === 'passkey-flags') {
  const gate = new StepUpGate({ ceremony: () => new Promise(() => undefined), describe: () => 'unknown' });
  globalThis.__openGate = () => {
    const words = passkeyWords(view === 'passkey' ? machineStage() : stagedRule({ totp: true, autoRecipe: true, fields: ['password', 'totp'] }));
    void gate.require(connection, words.does, 'explicit', 'approve-sign-in-rule', STAGE_ID, words);
  };
  globalThis.__gate = gate;
}

const root = document.getElementById('root');
const body = () => {
  switch (view) {
    case 'create-totp': return sheet();
    case 'create-terminal': return sheet({ place: sudoPlace, username: 'kirin', codeAvailable: false, codeKey: undefined });
    case 'ineligible': return sheet({ eligibility: { signIn: SITE_SIGN_IN, eligible: false, because: 'no-history' } });
    case 'suggestion': return (
      <div className="fy-card" data-harness-card="">
        <SignInRuleSuggestionHost agentName="Hadi" askPasskey={async () => true} connection={connection}
          createClient={async () => client} item={{ signInRuleSuggestion: { suggestion: suggestion().id } }} offered />
      </div>
    );
    case 'widen': return site('rule');
    case 'rule-card': return ruleCard(pageRule());
    case 'narrow-hours': return ruleCard(codeRule());
    case 'revoke-all': return (
      <div className="fy-card" data-harness-card="">
        <AccountRulesRevoke account={{ ...accounts.accounts[0], id: 'GITHUB_WORK', label: 'github work' }} rules={{ client, askPasskey: async () => true }} />
      </div>
    );
    case 'needs-update': return (
      <DaemonClientProvider client={async () => ({ request: async (_path, schema) => schema.parse(healthOf('1.0.0', [])) })}>
        <DaemonSettingsFrame additionalTabs={[]} connection={connection} createSecretClient={async () => client}
          createWardenClient={async () => client} name="Studio" onOpenPanel={quiet} panel="secure-copy"
          readWardenStatus={async () => { throw new Error('quiet'); }} />
      </DaemonClientProvider>
    );
    case 'deep-link-elsewhere': return <ActionToast notice={RULE_LINKED_ELSEWHERE_WORDS} onDismiss={quiet} />;
    case 'passkey': case 'passkey-flags': case 'machine': return (
      <div className="fy-card" data-harness-card="">
        <MachineRuleStage canUsePasskey onConfirm={quiet} onDeny={quiet} phase={{ kind: 'idle' }} staged={machineStage()} />
      </div>
    );
    case 'settings': return (
      <div className="fy-card" data-harness-card="">
        <SignInRulesSurface askPasskey={async () => true} connection={connection} createClient={async () => client} pollMs={600000} />
      </div>
    );
    case 'suspended': return ruleCard(suspendedRule());
    case 'narrow': return ruleCard(codeRule());
    case 'site-panel': return site('rule');
    case 'edit-warning': return site('method');
    case 'device-revoke': return (
      <AddDeviceCard connection={connection} deviceNote={deviceId => <DeviceRuleNote client={client} deviceId={deviceId} />}
        invite={null} nowMs={Date.parse('2026-11-01T10:00:00.000Z')} onChangeDeviceGrants={quiet} onDiscardInvite={quiet}
        onMint={quiet} onRevokeCode={quiet} onRevokeDevice={quiet} view={devices} />
    );
    case 'history': {
      const closed = { ...item, resolvedAt: '2026-11-01T09:42:00.000Z', resolvedBy: 'daemon', resolvedBySession: null,
        resolvedByName: null, disposition: 'done', resolutionNote: 'Input request delivered.' };
      return itemView({ settled: <AgendaSettled busy={false} error={null} ferret="Hadi" item={closed} now={NOW} /> }, closed);
    }
    case 'replaces': return sheet({ origin: 'suggestion', replacesExisting: true, replacing: pageRule({ status: 'expired' }) });
    case 'filled': {
      const page = { kind: 'browser', pageId: 'page-1', origin: 'https://github.com', secure: true, navigationId: 'nav-1',
        fields: [{ fieldId: 'f1', frameOrigin: 'https://github.com', frameId: 'frame-1', backendNodeId: 7,
          field: { tag: 'input', type: 'password' }, box: { x: 0, y: 0, w: 200, h: 24 }, visible: true }] };
      const input = fakeRequest({ state: 'delivered', observed: page, preapproval: { by: 'rule', rule: RULE_ID, revision: 1, outcome: 'filled' } });
      return itemView({ inputForm: <InputCard agentName="Hadi" client={client} embedded fields={fieldsOf(input)} now={NOW} onDone={quiet} request={input} /> },
        { ...item, input: { requestId: input.id } });
    }
    case 'fallback': {
      const input = fakeRequest({ preapproval: { by: 'rule', rule: RULE_ID, revision: 1, outcome: 'did-not-apply', reason: 'rate' } });
      return itemView({ inputForm: <InputCard agentName="Hadi" client={client} embedded fields={fieldsOf(input)} now={NOW} onDone={quiet} request={input} /> },
        { ...item, input: { requestId: input.id } });
    }
    default: return sheet();
  }
};
createRoot(root).render(
  <div className="kt-shell flex min-h-full flex-col items-center bg-bg p-3">
    <div className="w-full max-w-[640px]">{body()}</div>
    {view === 'passkey' || view === 'passkey-flags' ? <StepUpDialog gate={globalThis.__gate} machineName={() => 'Studio'} /> : null}
  </div>,
);
`;

const html = (theme: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="/app.css" />
    <style>html, body, #root { min-height: 100%; margin: 0; }</style>
  </head>
  <body><div id="root"></div><script type="module" src="/sign-in-rules-entry.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
await Bun.write(join(buildDir, 'sign-in-rules-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(buildDir, 'sign-in-rules-entry.tsx'), '--outdir', buildDir, '--target', 'browser']);
run('./node_modules/.bin/tailwindcss', [
  '--config',
  'tailwind.config.ts',
  '--input',
  'src/styles/index.css',
  '--output',
  join(buildDir, 'app.css'),
]);

const ALL_STATES = [
  'create-page',
  'create-totp',
  'create-terminal',
  'ineligible',
  'suggestion',
  'passkey',
  'machine',
  'settings',
  'suspended',
  'narrow',
  'site-panel',
  'edit-warning',
  'fallback',
  'history',
  'device-revoke',
  'replaces',
  'filled',
  'widen',
  'rule-card',
  'narrow-hours',
  'revoke-all',
  'passkey-flags',
  'needs-update',
  'deep-link-elsewhere',
] as const;
const wanted = process.argv[3]?.split(',');
const STATES = ALL_STATES.filter(state => wanted === undefined || wanted.includes(state));

const SURFACE: Readonly<Record<(typeof ALL_STATES)[number], string>> = {
  'create-page': '[data-rule-sheet]',
  'create-totp': '[data-rule-sheet]',
  'create-terminal': '[data-rule-sheet]',
  ineligible: '[data-rule-sheet]',
  suggestion: '[data-rule-suggestion]',
  passkey: '[data-step-up-confirm]',
  machine: '[data-rule-stage]',
  settings: '[data-rule]',
  suspended: '[data-rule]',
  narrow: '[data-rule-narrow-form]',
  'site-panel': '[data-rule]',
  'edit-warning': '[data-rule-edit-warning]',
  fallback: '[data-input-plan-miss]',
  history: '[data-agenda-settled]',
  'device-revoke': '[data-device-rules]',
  replaces: '[data-rule-replaces]',
  filled: '[data-input-plan-filled]',
  widen: '[data-rule-replaces]',
  'rule-card': '[data-rule-widen]',
  'narrow-hours': '[data-rule-narrow-form]',
  'revoke-all': '[data-account-rules-confirm]',
  'passkey-flags': '[data-step-up-confirm]',
  'needs-update': '[data-machine-needs-update]',
  'deep-link-elsewhere': '[data-action-toast]',
};

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/') {
      return new Response(html(url.searchParams.get('theme') ?? 'studio-dark'), {
        headers: { 'content-type': 'text/html' },
      });
    }
    const file = url.pathname.startsWith('/assets/fonts/')
      ? Bun.file(join(packageDir, 'src', url.pathname))
      : Bun.file(join(buildDir, url.pathname));
    return new Response(file);
  },
});

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844, shot: 2_700, touch: true },
  { name: 'desktop', width: 1_440, height: 900, shot: 1_700, touch: false },
] as const;

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });
try {
  for (const viewport of VIEWPORTS) {
    for (const scheme of ['light', 'dark'] as const) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.shot },
        colorScheme: scheme,
        reducedMotion: 'reduce',
        hasTouch: viewport.touch,
        isMobile: viewport.touch,
      });
      try {
        await context.route('**/*', async route => {
          if (new URL(route.request().url()).origin !== server.url.origin) return await route.abort();
          return await route.continue();
        });
        const page = await context.newPage();
        page.on('pageerror', error => process.stderr.write(`page error: ${error.message}\n`));
        for (const state of STATES) {
          await page.goto(`${server.url}?theme=studio-${scheme}&view=${state}`);
          const surface = page.locator(SURFACE[state]);
          if (state === 'passkey' || state === 'passkey-flags') {
            await page.locator('[data-rule-stage]').first().waitFor({ state: 'visible' });
            await page.evaluate(() => (globalThis as { __openGate?: () => void }).__openGate?.());
          }
          if (state === 'create-totp') {
            await page.locator('[data-rule-tick="username"]').waitFor({ state: 'visible' });
            await page.locator('[data-rule-tick="username"]').check();
            await page.locator('[data-rule-tick="password"]').check();
            await page.locator('[data-rule-tick="totp"]').check();
            await page.locator('[data-rule-tick="totp-ack"]').check();
          }
          if (state === 'create-page') {
            await page.locator('[data-rule-tick="username"]').waitFor({ state: 'visible' });
            await page.locator('[data-rule-tick="username"]').check();
            await page.locator('[data-rule-tick="password"]').check();
          }
          if (state === 'create-terminal') {
            await page.locator('[data-rule-tick="password"]').waitFor({ state: 'visible' });
            await page.locator('[data-rule-tick="password"]').check();
          }
          if (state === 'widen') {
            await page.locator('[data-rule-widen]').first().click();
          }
          if (state === 'narrow-hours') {
            await page.locator('[data-rule-narrow]').first().click();
            await page.locator('[data-rule-end-unit]').selectOption('hours');
            await page.locator('[data-rule-end-days]').fill('3');
          }
          if (state === 'revoke-all') {
            await page.locator('[data-account-rules-revoke]').first().click();
          }
          if (state === 'narrow') {
            await page.locator('[data-rule-narrow]').first().click();
          }
          if (state === 'site-panel') {
            await page.locator('[data-rule]').first().waitFor({ state: 'visible' });
          }
          await surface.first().waitFor({ state: 'visible' });
          const where = `${state} at ${viewport.name}/${scheme}`;
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (overflow > 0) fail(`${where} scrolls sideways by ${overflow}px`);
          if (viewport.touch) {
            const scope =
              state === 'passkey' || state === 'passkey-flags'
                ? page.locator('[data-step-up-dialog]')
                : page.locator('#root');
            for (const height of await scope
              .locator('button')
              .evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().height)))
              if (height < 44) fail(`${where}: a button is ${height}px tall, under the 44px floor`);
            for (const box of await scope.locator('input[type="checkbox"]').evaluateAll(boxes =>
              boxes.map(each => {
                const own = each.getBoundingClientRect();
                const label = each.closest('label')?.getBoundingClientRect();
                return {
                  width: Math.max(own.width, label?.width ?? 0),
                  height: Math.max(own.height, label?.height ?? 0),
                };
              }),
            ))
              if (box.width < 44 || box.height < 44)
                fail(`${where}: a checkbox target is ${box.width}x${box.height}px, under the 44px floor`);
          }
          const target = join(outDir, `sign-in-rules-${state}-${viewport.name}-${scheme}.png`);
          await page.screenshot({ path: target, fullPage: true });
          process.stdout.write(`📸 ${target}\n`);
        }
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  server.stop();
}
