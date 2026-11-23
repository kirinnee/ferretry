import { describe, it } from 'bun:test';
import type { RuntimesApi } from '@ferretry/plugin-runtimes/contract';
import should from 'should';
import { runtimesWardenAgents } from '../../daemon/adapters/index.ts';
import { resolveWardenLogin, wardenConfigWarnings } from '../../daemon/lib/index.ts';
import { DEFAULT_WARDEN_CONFIG } from '../../contract/index.ts';

type Catalog = Awaited<ReturnType<RuntimesApi['catalog']>>;

const runtime = (name: string, extra: { disabled?: boolean } = {}): Catalog[number] =>
  ({
    id: `${name}-id`,
    name,
    wrapper: name,
    ...(extra.disabled === true ? { disabled: { by: 'runtime', reason: 'off' } } : {}),
  }) as unknown as Catalog[number];

const api = (catalog: Catalog, fallback?: string): Pick<RuntimesApi, 'catalog' | 'default'> => ({
  catalog: async () => catalog,
  default: async () => fallback as Awaited<ReturnType<RuntimesApi['default']>>,
});

const CATALOG = [
  runtime('claude-default'),
  runtime('claude-work-fast'),
  runtime('codex-main-agent'),
  runtime('claude-old', { disabled: true }),
];

describe('the logins the Warden offers for an investigation', () => {
  it("should offer this machine's agent runtimes by name, not the ones that are off", async () => {
    const installed = await runtimesWardenAgents(() => api(CATALOG, 'claude-default')).installed();
    should(installed).deepEqual(['claude-default', 'claude-work-fast', 'codex-main-agent']);
  });

  it('should name the machine default runtime for an owner who never chose a login', async () => {
    const agents = runtimesWardenAgents(() => api(CATALOG, 'claude-default'));
    should(await agents.defaultRuntime()).equal('claude-default');
  });

  it('should stand in the default runtime and list every login in the settings view when warden.yaml names none', async () => {
    const agents = runtimesWardenAgents(() => api(CATALOG, 'claude-default'));
    const resolved = resolveWardenLogin(
      { ...DEFAULT_WARDEN_CONFIG, accounts: [] },
      await agents.installed(),
      await agents.defaultRuntime(),
    );
    should(resolved.login.source).equal('machine_default');
    should(resolved.login.available).deepEqual(['claude-default', 'claude-work-fast', 'codex-main-agent']);
    should(resolved.usable).be.true();
    should(
      wardenConfigWarnings(
        { ...DEFAULT_WARDEN_CONFIG, layers: { ...DEFAULT_WARDEN_CONFIG.layers, llm: true } },
        resolved,
      ),
    ).deepEqual([]);
  });

  it('should still list the logins when the machine has no default runtime, so one can be chosen', async () => {
    const agents = runtimesWardenAgents(() => api(CATALOG, undefined));
    const resolved = resolveWardenLogin(
      { ...DEFAULT_WARDEN_CONFIG, accounts: [] },
      await agents.installed(),
      await agents.defaultRuntime(),
    );
    should(resolved.login.source).equal('not_set');
    should(resolved.login.available).deepEqual(['claude-default', 'claude-work-fast', 'codex-main-agent']);
  });

  it('should offer no default when the catalog cannot be read, so no unattended investigator is started on it', async () => {
    const agents = runtimesWardenAgents(() => ({
      catalog: async () => {
        throw new Error('the catalog was refused');
      },
      default: async () => 'claude-default' as Awaited<ReturnType<RuntimesApi['default']>>,
    }));
    should(await agents.defaultRuntime()).be.undefined();
    await agents.installed().then(
      () => {
        throw new Error('an unreadable catalog must not answer');
      },
      () => undefined,
    );
    const resolved = resolveWardenLogin({ ...DEFAULT_WARDEN_CONFIG, accounts: [] }, [], await agents.defaultRuntime());
    should(resolved.login.source).equal('not_set');
    should(resolved.usable).be.false();
  });

  it('should offer no default that is switched off, or unknown to the catalog', async () => {
    const off = [runtime('claude-default'), runtime('claude-old', { disabled: true })];
    should(await runtimesWardenAgents(() => api(off, 'claude-old')).defaultRuntime()).be.undefined();
    should(await runtimesWardenAgents(() => api(CATALOG, 'not-on-this-machine')).defaultRuntime()).be.undefined();
    should(await runtimesWardenAgents(() => api(CATALOG, undefined)).defaultRuntime()).be.undefined();
    const unreadable = runtimesWardenAgents(() => ({
      catalog: async () => CATALOG,
      default: async () => {
        throw new Error('the default could not be read');
      },
    }));
    should(await unreadable.defaultRuntime()).be.undefined();
  });

  it('should answer unreadable, condemning no account, when Runtimes is off', async () => {
    const agents = runtimesWardenAgents(() => undefined);
    should(await agents.installed()).deepEqual([]);
    should(await agents.defaultRuntime()).be.undefined();
  });

  it('should keep a stored name that is already current and follow an id to its name', async () => {
    const agents = runtimesWardenAgents(() => api(CATALOG, 'claude-default'));
    should(await agents.currentName('claude-work-fast')).equal('claude-work-fast');
    should(await agents.currentName('codex-main-agent-id')).equal('codex-main-agent');
    should(await agents.currentName('gone')).be.undefined();
  });
});
