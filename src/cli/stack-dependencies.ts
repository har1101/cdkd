import {
  inferCrossStackStackDeps,
  type CrossStackScanStack,
} from '../analyzer/cross-stack-deps.js';

/**
 * Minimal shape {@link includeDependencyStacks} needs: the template scan's
 * shape plus CDK's manifest dependency names. `StackInfo` satisfies it.
 */
export interface DependencyScanStack extends CrossStackScanStack {
  dependencyNames: readonly string[];
}

/**
 * Add every stack the selected stacks depend on, recursively, as the AWS CDK
 * CLI's `ExtendedStackSelection.Upstream` does for `cdk deploy` and
 * `cdk diff`. `-e` / `--exclusively` skips this call.
 *
 * Only STRONG edges count: CDK manifest dependencies (`addDependency`) plus
 * `Fn::ImportValue` references inferred from the templates. A weak
 * `Fn::GetStackOutput` reference must not pull an unselected producer in
 * (issue #751), so `cdkd deploy X` / `cdkd diff X` cover the same stacks.
 *
 * Returns a new array: the selected stacks in their original order, then each
 * added dependency in discovery order (depth-first). `onInclude` is called
 * once per added stack.
 */
export function includeDependencyStacks<T extends DependencyScanStack>(
  selected: readonly T[],
  allStacks: readonly T[],
  onInclude?: (dependency: string, requiredBy: string) => void
): T[] {
  const inferredStrong = inferCrossStackStackDeps(allStacks, { kinds: ['ImportValue'] });
  const strongDeps = (stack: T): Set<string> => {
    const union = new Set<string>(stack.dependencyNames);
    for (const producer of inferredStrong.get(stack.stackName) ?? []) union.add(producer);
    return union;
  };

  const result = [...selected];
  const names = new Set(selected.map((s) => s.stackName));
  const byName = new Map(allStacks.map((s) => [s.stackName, s]));

  const addDependencies = (stack: T): void => {
    for (const depName of strongDeps(stack)) {
      if (names.has(depName)) continue;
      const depStack = byName.get(depName);
      if (!depStack) continue;
      names.add(depName);
      result.push(depStack);
      onInclude?.(depName, stack.stackName);
      addDependencies(depStack);
    }
  };

  for (const stack of selected) addDependencies(stack);
  return result;
}
