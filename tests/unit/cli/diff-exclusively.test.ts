/**
 * `cdkd diff -e` / `--exclusively`: without the flag `cdkd diff` selects the
 * requested stacks plus the stacks they depend on, as `cdkd deploy` and the
 * AWS CDK CLI's `cdk diff` do; with it, only the requested stacks. Drives the
 * REAL commander command and reads the stacks handed to macro expansion, which
 * receives exactly the stacks the diff then walks.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockLoggerError = vi.hoisted(() => vi.fn());
const mockLoggerInfo = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: mockLoggerInfo,
    warn: vi.fn(),
    error: mockLoggerError,
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

const mockSynthesize = vi.hoisted(() => vi.fn());
const mockExpandMacros = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn().mockImplementation(() => ({
    synthesize: mockSynthesize,
    expandMacrosForStacks: mockExpandMacros,
  })),
  synthesisStatusMessage: (_app: unknown, msg: string) => msg,
}));

vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveApp: vi.fn(() => 'node app.ts'),
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
  resolveUseCdkBootstrapAssets: vi.fn(() => false),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({ s3: {}, destroy: vi.fn() })),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(() => ({ destroy: vi.fn() })),
}));

vi.mock('../../../src/utils/role-arn.js', () => ({
  applyRoleArnIfSet: vi.fn(async () => undefined),
}));

vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    destroyClient: vi.fn(),
    getState: vi.fn(async () => null),
    listStacks: vi.fn(async () => []),
  })),
}));

vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
}));

vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({ getProvider: vi.fn() })),
}));

import { createDiffCommand } from '../../../src/cli/commands/diff.js';
import { createDeployCommand } from '../../../src/cli/commands/deploy.js';

async function runDiff(argv: string[]): Promise<void> {
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('__process_exit__');
  }) as never);
  try {
    await createDiffCommand().parseAsync(argv, { from: 'user' });
  } catch (err) {
    if (!(err instanceof Error) || err.message !== '__process_exit__') throw err;
  } finally {
    exitSpy.mockRestore();
  }
}

function makeStack(stackName: string, dependencyNames: string[] = [], stagePath?: string) {
  return {
    stackName,
    displayName: stagePath ? `${stagePath}/${stackName}` : stackName,
    artifactId: stackName,
    template: { Resources: {} },
    dependencyNames,
    region: 'us-east-1',
    ...(stagePath && { stagePath }),
  };
}

/** The stack names the run diffed (handed to macro expansion), in order. */
function diffedStacks(): string[] {
  expect(mockExpandMacros).toHaveBeenCalledTimes(1);
  const [stacks] = mockExpandMacros.mock.calls[0] as unknown as [{ stackName: string }[]];
  return stacks.map((s) => s.stackName);
}

function infoLog(): string {
  return mockLoggerInfo.mock.calls.map((c) => String(c[0])).join('\n');
}

// Consumer -> Middle -> Producer, plus a stack nothing depends on.
const chain = [
  makeStack('Producer'),
  makeStack('Middle', ['Producer']),
  makeStack('Consumer', ['Middle']),
  makeStack('Unrelated'),
];

describe('cdkd diff --exclusively', () => {
  beforeEach(() => {
    mockSynthesize.mockReset();
    mockLoggerError.mockReset();
    mockLoggerInfo.mockReset();
    mockExpandMacros.mockClear();
    mockSynthesize.mockResolvedValue({ stacks: chain, manifest: {}, assemblyDir: '/tmp/cdk.out' });
  });

  it('diffs the requested stack and every stack it depends on by default', async () => {
    await runDiff(['Consumer']);

    expect(diffedStacks()).toEqual(['Consumer', 'Middle', 'Producer']);
    expect(infoLog()).toContain('Including dependency stack: Middle (required by Consumer)');
    expect(infoLog()).toContain('Including dependency stack: Producer (required by Middle)');
  });

  it('-e diffs only the requested stack', async () => {
    await runDiff(['Consumer', '-e']);

    expect(diffedStacks()).toEqual(['Consumer']);
    expect(infoLog()).not.toContain('Including dependency stack');
  });

  it('--exclusively is the long form of -e', async () => {
    await runDiff(['Consumer', '--exclusively']);

    expect(diffedStacks()).toEqual(['Consumer']);
  });

  it('a stack with no dependencies is diffed alone either way', async () => {
    await runDiff(['Producer']);

    expect(diffedStacks()).toEqual(['Producer']);
  });

  it('--all already selects every top-level stack, so -e changes nothing there', async () => {
    await runDiff(['--all']);
    const all = diffedStacks();
    mockExpandMacros.mockClear();
    await runDiff(['--all', '-e']);

    expect(all).toEqual(['Producer', 'Middle', 'Consumer', 'Unrelated']);
    expect(diffedStacks()).toEqual(all);
  });
});

// As `cdkd deploy --all`: a top-level stack's dependency inside a CDK Stage is
// included, and only the Stage stacks still left out are reported.
describe('cdkd diff --all and a dependency inside a CDK Stage', () => {
  const staged = [makeStack('Top', ['Prod-Db']), makeStack('Prod-Db', [], 'Prod'), makeStack('Prod-Api', [], 'Prod')];

  beforeEach(() => {
    mockSynthesize.mockReset();
    mockLoggerInfo.mockReset();
    mockExpandMacros.mockClear();
    mockSynthesize.mockResolvedValue({ stacks: staged, manifest: {}, assemblyDir: '/tmp/cdk.out' });
  });

  it('includes the Stage dependency and reports only the other Stage stack as left out', async () => {
    await runDiff(['--all']);

    expect(diffedStacks()).toEqual(['Top', 'Prod-Db']);
    expect(infoLog()).toContain('1 stack inside a CDK Stage was left out');
  });

  it('with -e reports both Stage stacks as left out', async () => {
    await runDiff(['--all', '-e']);

    expect(diffedStacks()).toEqual(['Top']);
    expect(infoLog()).toContain('2 stacks inside a CDK Stage were left out');
  });
});

describe('-e / --exclusively is one option shared by deploy and diff', () => {
  it('both commands declare it, worded as the AWS CDK CLI words it', () => {
    const find = (cmd: ReturnType<typeof createDiffCommand>) =>
      cmd.options.find((o) => o.long === '--exclusively');

    const diffOpt = find(createDiffCommand());
    const deployOpt = find(createDeployCommand());

    expect(diffOpt?.short).toBe('-e');
    expect(deployOpt?.short).toBe('-e');
    expect(diffOpt?.defaultValue).toBe(false);
    expect(deployOpt?.defaultValue).toBe(false);
    expect(diffOpt?.description).toBe("Only diff requested stacks, don't include dependencies");
  });
});
