import { execFile } from "child_process";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

import { PR, PRDetail } from "../types";
import { Config } from "../config";

export class GitHubClient {
  constructor(private readonly output: vscode.OutputChannel) {}

  private get workspaceRoot(): string | undefined {
    return Config.workspaceRoot;
  }

  private log(message: string): void {
    this.output.appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  async detectRepo(): Promise<string> {
    this.log(`Detecting repository (cwd: ${this.workspaceRoot ?? "extension host cwd"})`);
    const result = await this.gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);
    const repo = result.trim();

    if (!repo) {
      throw new Error("gh repo view returned an empty repository name");
    }

    this.log(`Detected repository ${repo}`);
    return repo;
  }

  async listPRs(repo: string): Promise<PR[]> {
    const json = await this.gh([
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--json",
      "number,title,author,createdAt,headRefName,additions,deletions",
      "--limit",
      "30",
    ]);
    let raw: Array<{
      number: number;
      title: string;
      author: { login: string };
      createdAt: string;
      headRefName: string;
      additions: number;
      deletions: number;
    }>;
    try {
      raw = JSON.parse(json);
    } catch (e) {
      const preview = json.length === 0 ? '<empty>' : json.slice(0, 200);
      throw new Error(`Failed to parse GitHub CLI output in listPRs: ${preview}`, { cause: e });
    }
    const prs = raw.map((pr) => ({
      number: pr.number,
      title: pr.title,
      author: pr.author.login,
      createdAt: pr.createdAt,
      headRefName: pr.headRefName,
      additions: pr.additions,
      deletions: pr.deletions,
    }));

    this.log(`Loaded ${prs.length} open PR(s) for ${repo}`);
    return prs;
  }

  async getPRDiff(repo: string, pr: number): Promise<string> {
    return this.gh(["pr", "diff", String(pr), "--repo", repo]);
  }

  async getPRInfo(repo: string, pr: number): Promise<PRDetail> {
    const json = await this.gh([
      "pr",
      "view",
      String(pr),
      "--repo",
      repo,
      "--json",
      "number,title,body,author,createdAt,headRefName,additions,deletions,files",
    ]);
    let raw: any;
    try {
      raw = JSON.parse(json);
    } catch (e) {
      const preview = json.length === 0 ? '<empty>' : json.slice(0, 200);
      throw new Error(`Failed to parse GitHub CLI output in getPRInfo: ${preview}`, { cause: e });
    }
    return {
      number: raw.number,
      title: raw.title,
      body: raw.body ?? "",
      author: raw.author.login,
      createdAt: raw.createdAt,
      headRefName: raw.headRefName,
      additions: raw.additions,
      deletions: raw.deletions,
      files: (raw.files ?? []).map((f: { path: string }) => f.path),
    };
  }

  async postComment(repo: string, pr: number, body: string): Promise<void> {
    const tmpFile = path.join(os.tmpdir(), `fleet-review-comment-${randomUUID()}.md`);
    try {
      await fs.promises.writeFile(tmpFile, body, { mode: 0o600 });
      await this.gh(["pr", "comment", String(pr), "--repo", repo, "--body-file", tmpFile]);
    } finally {
      try {
        await fs.promises.unlink(tmpFile);
      } catch {
        // ignore cleanup errors
      }
    }
  }

  async postInlineComments(
    repo: string,
    pr: number,
    comments: Array<{ path: string; line: number; body: string }>,
  ): Promise<number> {
    if (comments.length === 0) return 0;

    // Post each comment as an individual single-comment review so one
    // invalid line number doesn't cause the entire batch to fail (the
    // GitHub API rejects the whole request if any comment targets a
    // line that isn't part of the diff).
    let posted = 0;
    for (const c of comments) {
      const reviewBody = JSON.stringify({
        body: '',
        event: 'COMMENT',
        comments: [{ path: c.path, line: c.line, side: 'RIGHT', body: c.body }],
      });

      const tmpFile = path.join(os.tmpdir(), `fleet-review-review-${randomUUID()}.json`);
      try {
        await fs.promises.writeFile(tmpFile, reviewBody, { mode: 0o600 });
        await this.gh([
          'api',
          '--method', 'POST',
          `/repos/${repo}/pulls/${pr}/reviews`,
          '--input', tmpFile,
        ]);
        posted++;
      } catch (err) {
        this.log(`Skipped inline comment on ${c.path}:${c.line}: ${err instanceof Error ? err.message : err}`);
      } finally {
        try { await fs.promises.unlink(tmpFile); } catch { /* ignore */ }
      }
    }

    this.log(`Posted ${posted}/${comments.length} inline comment(s) to PR #${pr}`);
    return posted;
  }

  async getAuditComments(repo: string, pr: number): Promise<Array<{ model: string; body: string }>> {
    const json = await this.gh(["pr", "view", String(pr), "--repo", repo, "--json", "comments"]);
    let raw: any;
    try {
      raw = JSON.parse(json);
    } catch (e) {
      const preview = json.length === 0 ? '<empty>' : json.slice(0, 200);
      throw new Error(`Failed to parse GitHub CLI output in getAuditComments: ${preview}`, { cause: e });
    }
    const comments: Array<{ model: string; body: string }> = [];
    for (const c of raw.comments ?? []) {
      const body = typeof c.body === 'string' ? c.body : '';
      const match = body.match(/^## Audit by `([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})`/);
      if (match) {
        comments.push({ model: match[1], body });
      }
    }
    return comments;
  }

  private gh(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const cwd = this.workspaceRoot;
      this.log(`Running gh ${args.join(" ")}${cwd ? ` (cwd: ${cwd})` : ""}`);

      execFile(
        "gh",
        args,
        {
          cwd,
          env: {
            ...process.env,
            GH_PAGER: "",
            GH_PROMPT_DISABLED: "1",
            NO_COLOR: "1",
            PAGER: "",
          },
          maxBuffer: 10 * 1024 * 1024,
          timeout: 30_000,
        },
        (error, stdout, stderr) => {
          const durationMs = Date.now() - startedAt;
          const stderrText = stderr.trim();

          if (error) {
            const code = (error as NodeJS.ErrnoException).code;
            const detail = stderrText || error.message;
            this.log(`gh ${args[0]} failed after ${durationMs}ms: ${detail}`);

            if (code === "ENOENT") {
              reject(new Error("gh command not found. Install GitHub CLI and ensure it is on PATH."));
              return;
            }

            reject(new Error(`gh ${args[0]} failed: ${detail}`));
            return;
          }

          this.log(
            stderrText
              ? `gh ${args[0]} completed in ${durationMs}ms with stderr: ${stderrText}`
              : `gh ${args[0]} completed in ${durationMs}ms`,
          );
          resolve(stdout);
        },
      );
    });
  }
}
