import { describe, it, expect, vi } from 'vite-plus/test';
import {
  includeDependencyStacks,
  type DependencyScanStack,
} from '../../../src/cli/stack-dependencies.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

function stack(
  stackName: string,
  dependencyNames: string[] = [],
  template: CloudFormationTemplate = { Resources: {} }
): DependencyScanStack {
  return { stackName, dependencyNames, template };
}

const names = (stacks: readonly DependencyScanStack[]): string[] => stacks.map((s) => s.stackName);

describe('includeDependencyStacks', () => {
  it('adds manifest dependencies recursively, after the selected stacks', () => {
    const producer = stack('Producer');
    const middle = stack('Middle', ['Producer']);
    const consumer = stack('Consumer', ['Middle']);
    const unrelated = stack('Unrelated');
    const all = [producer, middle, consumer, unrelated];

    expect(names(includeDependencyStacks([consumer], all))).toEqual([
      'Consumer',
      'Middle',
      'Producer',
    ]);
  });

  it('leaves a stack with no dependencies alone', () => {
    const producer = stack('Producer');
    const consumer = stack('Consumer', ['Producer']);

    expect(names(includeDependencyStacks([producer], [producer, consumer]))).toEqual([
      'Producer',
    ]);
  });

  it('adds each stack once when two selected stacks share a dependency', () => {
    const shared = stack('Shared');
    const a = stack('A', ['Shared']);
    const b = stack('B', ['Shared', 'A']);

    expect(names(includeDependencyStacks([a, b], [shared, a, b]))).toEqual(['A', 'B', 'Shared']);
  });

  it('follows a Fn::ImportValue reference that has no manifest dependency', () => {
    const producer = stack('Producer', [], {
      Resources: {},
      Outputs: { Out: { Value: 'v', Export: { Name: 'shared-export' } } },
    });
    const consumer = stack('Consumer', [], {
      Resources: {
        Param: {
          Type: 'AWS::SSM::Parameter',
          Properties: { Type: 'String', Value: { 'Fn::ImportValue': 'shared-export' } },
        },
      },
    });

    expect(names(includeDependencyStacks([consumer], [producer, consumer]))).toEqual([
      'Consumer',
      'Producer',
    ]);
  });

  it('does not follow a weak Fn::GetStackOutput reference (issue #751)', () => {
    const producer = stack('Producer', [], {
      Resources: {},
      Outputs: { Out: { Value: 'v' } },
    });
    const consumer = stack('Consumer', [], {
      Resources: {
        Param: {
          Type: 'AWS::SSM::Parameter',
          Properties: {
            Type: 'String',
            Value: { 'Fn::GetStackOutput': { StackName: 'Producer', OutputName: 'Out' } },
          },
        },
      },
    });

    expect(names(includeDependencyStacks([consumer], [producer, consumer]))).toEqual([
      'Consumer',
    ]);
  });

  it('skips a dependency name that is not a stack of the assembly', () => {
    const consumer = stack('Consumer', ['NotInApp']);

    expect(names(includeDependencyStacks([consumer], [consumer]))).toEqual(['Consumer']);
  });

  it('reports every added stack with the stack that required it', () => {
    const producer = stack('Producer');
    const middle = stack('Middle', ['Producer']);
    const consumer = stack('Consumer', ['Middle']);
    const onInclude = vi.fn();

    includeDependencyStacks([consumer], [producer, middle, consumer], onInclude);

    expect(onInclude.mock.calls).toEqual([
      ['Middle', 'Consumer'],
      ['Producer', 'Middle'],
    ]);
  });

  it('returns a new array and leaves the selection untouched', () => {
    const producer = stack('Producer');
    const consumer = stack('Consumer', ['Producer']);
    const selected = [consumer];

    const result = includeDependencyStacks(selected, [producer, consumer]);

    expect(result).not.toBe(selected);
    expect(names(selected)).toEqual(['Consumer']);
  });
});
