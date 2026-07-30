import type { Probe, ProbeDefinition, ProbeSandboxConfig, ProbeSetupConfig } from './contracts.ts';

type ProbeBody = Omit<Probe, 'kind'>;

type DefinitionOptions = {
  sandbox?: ProbeSandboxConfig;
  setup?: ProbeSetupConfig;
};

type GateOptions = DefinitionOptions & {
  baseline: ProbeBody;
  mutation: ProbeBody;
};

type BaselineOnlyOptions = DefinitionOptions & {
  baseline: ProbeBody;
};

function definition(options: DefinitionOptions, probes: Probe[]): ProbeDefinition {
  return {
    contractVersion: 1,
    ...(options.sandbox ? { sandbox: options.sandbox } : {}),
    ...(options.setup ? { setup: options.setup } : {}),
    probes,
  };
}

export function defineGate(options: GateOptions): ProbeDefinition {
  return definition(options, [
    { ...options.baseline, kind: 'baseline' },
    { ...options.mutation, kind: 'mutation' },
  ]);
}

export function defineSmoke(options: BaselineOnlyOptions): ProbeDefinition {
  return definition(options, [{ ...options.baseline, kind: 'baseline' }]);
}

export function definePresence(options: BaselineOnlyOptions): ProbeDefinition {
  return definition(options, [{ ...options.baseline, kind: 'baseline' }]);
}
