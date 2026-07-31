/**
 * Reading a request well enough to route it.
 *
 * The classifier is deliberately explainable rather than clever: every axis records the literal
 * words that drove it, so a wrong call is visible in the output instead of hiding inside a score.
 */

export type Complexity = 'mechanical' | 'mid' | 'hard';
export const complexities: readonly Complexity[] = ['mechanical', 'mid', 'hard'];

export type TaskKind =
  | 'frontend'
  | 'backend'
  | 'research'
  | 'review'
  | 'migration'
  | 'bulk-chore'
  | 'debugging'
  | 'general';
export const taskKinds: readonly TaskKind[] = [
  'frontend',
  'backend',
  'research',
  'review',
  'migration',
  'bulk-chore',
  'debugging',
  'general',
];

export type TeamRole = 'planner' | 'implementer' | 'researcher' | 'reviewer' | 'fan-out';
export const teamRoles: readonly TeamRole[] = ['planner', 'implementer', 'researcher', 'reviewer', 'fan-out'];

export type Budget = 'cheap' | 'balanced' | 'max';
export type RiskLevel = 'low' | 'normal' | 'critical';
export type TaskSize = 'small' | 'medium' | 'large';
export type Ambiguity = 'low' | 'high';

export interface AxisEvidence {
  readonly axis: 'complexity' | 'kind' | 'risk' | 'size' | 'ambiguity' | 'audience';
  readonly value: string;
  /** The literal words that drove it, so a wrong call is obvious rather than buried. */
  readonly matched: readonly string[];
}

export interface TaskClassification {
  readonly complexity: Complexity;
  readonly kind: TaskKind;
  readonly risk: RiskLevel;
  readonly size: TaskSize;
  readonly ambiguity: Ambiguity;
  readonly productFacing: boolean;
  readonly evidence: readonly AxisEvidence[];
}

const matches = (text: string, pattern: RegExp): readonly string[] => [
  ...new Set((text.match(new RegExp(pattern.source, 'gi')) ?? []).map(word => word.toLowerCase().trim())),
];

/** Narrow, strongly-signalled kinds come first: the first kind with evidence wins. */
const kindPatterns: ReadonlyArray<readonly [TaskKind, RegExp]> = [
  [
    'bulk-chore',
    /\b\d{2,}\s*(files?|packages?|modules?|call ?sites?|tests?|repos?)|every file|each file|bulk|fan.?out/,
  ],
  ['migration', /migrat\w*|upgrade|port(ing)? to|codemod|convert \w+ to|rollout/],
  ['review', /review|critique|proofread|second opinion|sanity.?check/],
  ['research', /research|investigate|inventory|survey|compare|explore|find out|spike|read the docs|understand how/],
  ['debugging', /\bbugs?\b|debug|flaky|crash\w*|regression|broken|failing|stack ?trace|root.?cause|repro\w*/],
  ['frontend', /front.?end|\bui\b|react|css|tailwind|landing|dashboard|svg|screenshot|component|responsive|animation/],
  ['backend', /\bapi\b|server|database|\bsql\b|schema|endpoint|backend|queue|worker|daemon|microservice/],
];

const HARD =
  /hard|complex|complicated|tricky|architect\w*|re-?design|re-?write|from scratch|concurren\w*|distributed|race condition|deadlock|protocol|algorithm|subtle|performance|refactor\w*|root.?cause|end.?to.?end/;
const MECHANICAL =
  /rename|typo|reformat|format\w*|lint|bump|reorder|boilerplate|mechanical|one.?liner|changelog|add a comment|copy.paste|find and replace/;
const CRITICAL =
  /security|auth\w*|credential|secret|token|payment|billing|invoice|production|\bprod\b|data ?loss|outage|compliance|\bpii\b|\bp0\b|critical|irreversible/;
const LARGE =
  /\b\d{2,}\s*(files?|packages?|modules?|call ?sites?|places|repos?)|entire (repo|codebase|service)|whole (repo|codebase)|monorepo|large|big context|across (all|every)/;
const AMBIGUOUS =
  /figure out|decide|design|plan\b|unclear|ambiguous|explore|options|how should|what.s the best|somehow|investigate/;
const PLANNED = /per the plan|following the plan|as specified|spec:|checklist|step.by.step|already decided|the plan is/;
const PRODUCT = /user.?facing|customer|product|marketing|landing|public|end users?/;

/** A request longer than this reads as at least medium scope even with no size words in it. */
const MEDIUM_LENGTH_THRESHOLD = 400;

export function classifyTask(task: string): TaskClassification {
  const text = task.toLowerCase();
  const evidence: AxisEvidence[] = [];

  const hard = matches(text, HARD);
  const mechanical = matches(text, MECHANICAL);
  const critical = matches(text, CRITICAL);
  const large = matches(text, LARGE);
  const ambiguous = matches(text, AMBIGUOUS);
  const planned = matches(text, PLANNED);
  const product = matches(text, PRODUCT);

  const kindMatch = kindPatterns
    .map(([kind, pattern]) => ({ kind, matched: matches(text, pattern) }))
    .find(entry => entry.matched.length > 0);
  const kind: TaskKind = kindMatch?.kind ?? 'general';
  evidence.push({ axis: 'kind', value: kind, matched: kindMatch?.matched ?? [] });

  // Mechanical only wins when nothing says the work is hard: "mechanically rename every call site
  // of a concurrent scheduler" is not mechanical.
  const complexity: Complexity =
    hard.length > 0 ? 'hard' : mechanical.length > 0 || kind === 'bulk-chore' ? 'mechanical' : 'mid';
  evidence.push({ axis: 'complexity', value: complexity, matched: complexity === 'hard' ? hard : mechanical });

  const risk: RiskLevel = critical.length > 0 ? 'critical' : complexity === 'mechanical' ? 'low' : 'normal';
  evidence.push({ axis: 'risk', value: risk, matched: critical });

  const size: TaskSize =
    large.length > 0 || kind === 'bulk-chore' ? 'large' : task.length > MEDIUM_LENGTH_THRESHOLD ? 'medium' : 'small';
  evidence.push({ axis: 'size', value: size, matched: large });

  // A plan already in hand removes the ambiguity a hard task would otherwise carry — that is
  // exactly the condition under which a plan-following implementer is allowed.
  const ambiguity: Ambiguity =
    planned.length > 0
      ? 'low'
      : ambiguous.length > 0 || (complexity === 'hard' && kind !== 'bulk-chore')
        ? 'high'
        : 'low';
  evidence.push({ axis: 'ambiguity', value: ambiguity, matched: planned.length > 0 ? planned : ambiguous });

  const productFacing = product.length > 0 || kind === 'frontend';
  evidence.push({ axis: 'audience', value: productFacing ? 'product-facing' : 'internal', matched: product });

  return { complexity, kind, risk, size, ambiguity, productFacing, evidence };
}

/** One line naming the shape that was read and the words that produced it. */
export function describeClassification(classification: TaskClassification): string {
  const words = classification.evidence
    .filter(item => item.matched.length > 0)
    .map(item => `${item.axis}=${item.value} (${item.matched.slice(0, 3).join(', ')})`);
  const audience = classification.productFacing ? ', product-facing' : '';
  const from = words.length > 0 ? ` — from ${words.join('; ')}` : ' — no strong keyword signal, defaults applied';
  return (
    `Read as ${classification.complexity} ${classification.kind} work, ${classification.risk} risk, ` +
    `${classification.size} scope, ${classification.ambiguity} ambiguity${audience}${from}.`
  );
}
