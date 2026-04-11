import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFile } from 'child_process';

vi.mock('../src/config', () => ({
  Config: {
    workspaceRoot: '/mock/workspace',
  },
}));

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

import { GitHubClient } from '../src/github/GitHubClient';

const mockExecFile = vi.mocked(execFile);

const stubOutput = { appendLine: () => {} } as any;

function simulateExecFile(stdout: string, error: Error | null = null, stderr = '') {
  mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, callback: any) => {
    callback(error, stdout, stderr);
    return {} as any;
  });
}

function makeClient(): GitHubClient {
  return new GitHubClient(stubOutput);
}

describe('GitHubClient.detectRepo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns trimmed repo name from gh output', async () => {
    simulateExecFile('  owner/repo\n');
    const client = makeClient();
    const result = await client.detectRepo();
    expect(result).toBe('owner/repo');
  });

  it('throws when gh returns empty output', async () => {
    simulateExecFile('   ');
    const client = makeClient();
    await expect(client.detectRepo()).rejects.toThrow('empty repository name');
  });

  it('throws with gh not found message on ENOENT', async () => {
    const err = Object.assign(new Error('not found'), { code: 'ENOENT' });
    simulateExecFile('', err);
    const client = makeClient();
    await expect(client.detectRepo()).rejects.toThrow('gh command not found');
  });

  it('throws with gh error details on generic error', async () => {
    const err = new Error('authentication failed');
    simulateExecFile('', err, 'authentication required');
    const client = makeClient();
    // GitHubClient formats as: `gh ${args[0]} failed: ...` — args[0] is 'repo'
    await expect(client.detectRepo()).rejects.toThrow('gh repo failed');
  });
});

describe('GitHubClient.listPRs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses JSON array of PRs correctly', async () => {
    const rawPRs = [
      {
        number: 42,
        title: 'Fix login bug',
        author: { login: 'bob' },
        createdAt: '2024-01-01T00:00:00Z',
        headRefName: 'fix/login',
        additions: 10,
        deletions: 3,
      },
    ];
    simulateExecFile(JSON.stringify(rawPRs));
    const client = makeClient();
    const result = await client.listPRs('owner/repo');
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(42);
    expect(result[0].title).toBe('Fix login bug');
    expect(result[0].author).toBe('bob');
    expect(result[0].headRefName).toBe('fix/login');
    expect(result[0].additions).toBe(10);
    expect(result[0].deletions).toBe(3);
  });

  it('throws descriptive error on invalid JSON', async () => {
    simulateExecFile('not valid json at all');
    const client = makeClient();
    await expect(client.listPRs('owner/repo')).rejects.toThrow('Failed to parse GitHub CLI output in listPRs');
  });

  it('throws on empty output', async () => {
    simulateExecFile('');
    const client = makeClient();
    await expect(client.listPRs('owner/repo')).rejects.toThrow('Failed to parse GitHub CLI output in listPRs');
  });
});

describe('GitHubClient.getPRInfo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses PR detail with files', async () => {
    const rawPR = {
      number: 7,
      title: 'Add feature',
      body: 'Some description',
      author: { login: 'carol' },
      createdAt: '2024-02-01T00:00:00Z',
      headRefName: 'feat/new-thing',
      additions: 50,
      deletions: 5,
      files: [{ path: 'src/feature.ts' }, { path: 'src/index.ts' }],
    };
    simulateExecFile(JSON.stringify(rawPR));
    const client = makeClient();
    const result = await client.getPRInfo('owner/repo', 7);
    expect(result.number).toBe(7);
    expect(result.title).toBe('Add feature');
    expect(result.body).toBe('Some description');
    expect(result.author).toBe('carol');
    expect(result.files).toEqual(['src/feature.ts', 'src/index.ts']);
  });

  it('handles missing body as empty string', async () => {
    const rawPR = {
      number: 8,
      title: 'No body PR',
      body: null,
      author: { login: 'dave' },
      createdAt: '2024-02-01T00:00:00Z',
      headRefName: 'fix/something',
      additions: 1,
      deletions: 0,
      files: [],
    };
    simulateExecFile(JSON.stringify(rawPR));
    const client = makeClient();
    const result = await client.getPRInfo('owner/repo', 8);
    expect(result.body).toBe('');
  });

  it('throws on malformed JSON', async () => {
    simulateExecFile('{broken json');
    const client = makeClient();
    await expect(client.getPRInfo('owner/repo', 1)).rejects.toThrow('Failed to parse GitHub CLI output in getPRInfo');
  });
});

describe('GitHubClient.getAuditComments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('extracts model name from audit comment header', async () => {
    const raw = {
      comments: [
        { body: '## Audit by `claude`\n\nSome review text' },
        { body: '## Audit by `gemini`\n\nAnother review' },
      ],
    };
    simulateExecFile(JSON.stringify(raw));
    const client = makeClient();
    const result = await client.getAuditComments('owner/repo', 1);
    expect(result).toHaveLength(2);
    expect(result[0].model).toBe('claude');
    expect(result[0].body).toContain('Some review text');
    expect(result[1].model).toBe('gemini');
  });

  it('skips non-audit comments', async () => {
    const raw = {
      comments: [
        { body: 'LGTM!' },
        { body: '## Audit by `codex`\n\nReview content' },
        { body: 'Just a regular comment' },
      ],
    };
    simulateExecFile(JSON.stringify(raw));
    const client = makeClient();
    const result = await client.getAuditComments('owner/repo', 1);
    expect(result).toHaveLength(1);
    expect(result[0].model).toBe('codex');
  });

  it('returns empty array when there are no comments', async () => {
    simulateExecFile(JSON.stringify({ comments: [] }));
    const client = makeClient();
    const result = await client.getAuditComments('owner/repo', 1);
    expect(result).toEqual([]);
  });

  it('throws on malformed JSON response', async () => {
    simulateExecFile('not json');
    const client = makeClient();
    await expect(client.getAuditComments('owner/repo', 1)).rejects.toThrow(
      'Failed to parse GitHub CLI output in getAuditComments'
    );
  });
});
