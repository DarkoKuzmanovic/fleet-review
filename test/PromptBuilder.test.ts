import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';

vi.mock('vscode');

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: vi.fn(() => false) };
});

vi.mock('../src/config', () => ({
  Config: {
    getProjectPrompt: () => undefined,
    getProjectHint: () => undefined,
  },
}));

import { PromptBuilder } from '../src/review/PromptBuilder';
import { PRDetail } from '../src/types';

const makePR = (overrides: Partial<PRDetail> = {}): PRDetail => ({
  number: 1,
  title: 'Add login feature',
  body: 'Implements OAuth2 login',
  author: 'alice',
  createdAt: '2024-01-01T00:00:00Z',
  headRefName: 'feature/login',
  additions: 10,
  deletions: 2,
  files: ['src/auth.ts', 'src/login.ts'],
  ...overrides,
});

describe('PromptBuilder.detectProjectType', () => {
  let builder: PromptBuilder;

  beforeEach(() => {
    vi.clearAllMocks();
    builder = new PromptBuilder();
  });

  it('detects jvm when build.gradle exists', () => {
    const existsSync = vi.mocked(fs.existsSync);
    existsSync.mockImplementation((p) => String(p).endsWith('build.gradle'));
    expect(builder.detectProjectType('/workspace')).toBe('jvm');
  });

  it('detects android when build.gradle and AndroidManifest.xml exist', () => {
    const existsSync = vi.mocked(fs.existsSync);
    existsSync.mockImplementation((p) => {
      const s = String(p);
      return s.endsWith('build.gradle') || s.endsWith('AndroidManifest.xml');
    });
    expect(builder.detectProjectType('/workspace')).toBe('android');
  });

  it('detects android when build.gradle and app/src/main/AndroidManifest.xml exist', () => {
    const existsSync = vi.mocked(fs.existsSync);
    existsSync.mockImplementation((p) => {
      const s = String(p);
      return s.endsWith('build.gradle') || s.includes('app/src/main/AndroidManifest.xml');
    });
    expect(builder.detectProjectType('/workspace')).toBe('android');
  });

  it('detects node when package.json exists', () => {
    const existsSync = vi.mocked(fs.existsSync);
    existsSync.mockImplementation((p) => String(p).endsWith('package.json'));
    expect(builder.detectProjectType('/workspace')).toBe('node');
  });

  it('detects rust when Cargo.toml exists', () => {
    const existsSync = vi.mocked(fs.existsSync);
    existsSync.mockImplementation((p) => String(p).endsWith('Cargo.toml'));
    expect(builder.detectProjectType('/workspace')).toBe('rust');
  });

  it('detects go when go.mod exists', () => {
    const existsSync = vi.mocked(fs.existsSync);
    existsSync.mockImplementation((p) => String(p).endsWith('go.mod'));
    expect(builder.detectProjectType('/workspace')).toBe('go');
  });

  it('detects python when pyproject.toml exists', () => {
    const existsSync = vi.mocked(fs.existsSync);
    existsSync.mockImplementation((p) => String(p).endsWith('pyproject.toml'));
    expect(builder.detectProjectType('/workspace')).toBe('python');
  });

  it('detects python when setup.py exists', () => {
    const existsSync = vi.mocked(fs.existsSync);
    existsSync.mockImplementation((p) => String(p).endsWith('setup.py'));
    expect(builder.detectProjectType('/workspace')).toBe('python');
  });

  it('detects ruby when Gemfile exists', () => {
    const existsSync = vi.mocked(fs.existsSync);
    existsSync.mockImplementation((p) => String(p).endsWith('Gemfile'));
    expect(builder.detectProjectType('/workspace')).toBe('ruby');
  });

  it('returns unknown when no recognized file exists', () => {
    const existsSync = vi.mocked(fs.existsSync);
    existsSync.mockReturnValue(false);
    expect(builder.detectProjectType('/workspace')).toBe('unknown');
  });
});

describe('PromptBuilder.buildAuditPrompt', () => {
  let builder: PromptBuilder;

  beforeEach(() => {
    vi.clearAllMocks();
    builder = new PromptBuilder();
  });

  it('contains PR title, author, and branch', () => {
    const pr = makePR();
    const result = builder.buildAuditPrompt(pr, 'some diff', 'node');
    expect(result).toContain('Add login feature');
    expect(result).toContain('alice');
    expect(result).toContain('feature/login');
  });

  it('wraps diff in backtick fences', () => {
    const pr = makePR();
    const diff = '+ added line\n- removed line';
    const result = builder.buildAuditPrompt(pr, diff, 'node');
    expect(result).toContain('```diff');
    expect(result).toContain(diff);
    expect(result).toMatch(/```\s*$/m);
  });

  it('includes project type context when not unknown', () => {
    const pr = makePR();
    const result = builder.buildAuditPrompt(pr, 'diff', 'node');
    expect(result).toContain('**node**');
  });

  it('omits project type context for unknown', () => {
    const pr = makePR();
    const result = builder.buildAuditPrompt(pr, 'diff', 'unknown');
    expect(result).not.toContain('**unknown**');
  });

  it('uses longer fences when diff contains triple backticks', () => {
    const pr = makePR();
    const diff = 'some diff\n```\ncode block\n```\nmore diff';
    const result = builder.buildAuditPrompt(pr, diff, 'node');
    // fence must be longer than ``` (4 or more backticks)
    expect(result).toMatch(/````+diff/);
  });

  it('includes PR body when present', () => {
    const pr = makePR({ body: 'This fixes the login bug' });
    const result = builder.buildAuditPrompt(pr, 'diff', 'node');
    expect(result).toContain('This fixes the login bug');
  });

  it('lists changed files', () => {
    const pr = makePR({ files: ['src/foo.ts', 'src/bar.ts'] });
    const result = builder.buildAuditPrompt(pr, 'diff', 'node');
    expect(result).toContain('src/foo.ts');
    expect(result).toContain('src/bar.ts');
  });
});

describe('PromptBuilder.buildMergePrompt', () => {
  let builder: PromptBuilder;

  beforeEach(() => {
    vi.clearAllMocks();
    builder = new PromptBuilder();
  });

  it('contains each model audit section', () => {
    const outputs = {
      claude: 'Claude found nothing.',
      gemini: 'Gemini found a bug.',
    };
    const result = builder.buildMergePrompt(outputs, 'diff content');
    expect(result).toContain('## Audit by `claude`');
    expect(result).toContain('## Audit by `gemini`');
    expect(result).toContain('Claude found nothing.');
    expect(result).toContain('Gemini found a bug.');
  });

  it('contains the diff', () => {
    const result = builder.buildMergePrompt({ model1: 'review' }, 'my diff here');
    expect(result).toContain('my diff here');
  });

  it('wraps diff in backtick fences', () => {
    const result = builder.buildMergePrompt({ m: 'review' }, '+ added');
    expect(result).toContain('```diff');
  });

  it('uses longer fences when diff contains triple backticks', () => {
    const diff = 'diff\n```\nblock\n```\nend';
    const result = builder.buildMergePrompt({ m: 'review' }, diff);
    expect(result).toMatch(/````+diff/);
  });
});
