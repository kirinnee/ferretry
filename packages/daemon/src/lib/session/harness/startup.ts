/**
 * The model selection every new harness invocation receives on its launch argv.
 *
 * Both supported harness CLIs accept `--model <id>`. Putting the resolved choice LAST makes the
 * daemon's explicit model decision win over an account default or a carried same-harness flag. The
 * value itself remains owned by the fleet/runtime catalogue; this helper owns only how an already
 * validated choice reaches a new invocation.
 */
export function startupModelArguments(model: string): readonly string[] {
  return ['--model', model];
}
