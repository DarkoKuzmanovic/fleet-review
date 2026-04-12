import * as fs from "fs";
import * as path from "path";

import { PRDetail, ProjectType } from "../types";
import { Config } from "../config";

export class PromptBuilder {
  detectProjectType(workspaceRoot: string): ProjectType {
    const exists = (f: string) => fs.existsSync(path.join(workspaceRoot, f));

    if (exists("build.gradle") || exists("build.gradle.kts")) {
      const hasAndroid = exists("AndroidManifest.xml") || exists("app/src/main/AndroidManifest.xml");
      return hasAndroid ? "android" : "jvm";
    }
    if (exists("package.json")) return "node";
    if (exists("Cargo.toml")) return "rust";
    if (exists("go.mod")) return "go";
    if (exists("pyproject.toml") || exists("setup.py")) return "python";
    if (exists("Gemfile")) return "ruby";
    return "unknown";
  }

  buildAuditPrompt(pr: PRDetail, diff: string, projectType: ProjectType): string {
    // Check for user-configured extra hints
    const defaultHint = PROJECT_HINTS[projectType] ?? "";
    const userHint = Config.getProjectHint(projectType) ?? "";
    const combinedHint = [defaultHint, userHint].filter(Boolean).join(" ");
    const contextLine =
      projectType !== "unknown"
        ? `This is a **${projectType}** project.${combinedHint ? " " + combinedHint : ""}\n\n`
        : "";

    // Check for user-configured custom audit prompt.  Always append the
    // output format section so inline-comment parsing and the comparison
    // view keep working regardless of custom prompt content.
    const customPrompt = Config.getProjectPrompt(projectType);
    const auditInstructions = customPrompt
      ? `${customPrompt}\n\n${OUTPUT_FORMAT}`
      : AUDIT_INSTRUCTIONS;

    const diffLines = diff.split("\n").length;
    const fileCount = pr.files.length;
    const sizeLine = `_~${diffLines} diff lines across ${fileCount} file${fileCount !== 1 ? "s" : ""}${diffLines > 300 ? " — focus on high-impact issues" : ""}_\n\n`;

    const maxFiles = 50;
    const displayFiles = pr.files.slice(0, maxFiles);
    const fileList =
      pr.files.length > 0
        ? `### Files Changed\n\n${displayFiles.map((f) => "- `" + f + "`").join("\n")}${pr.files.length > maxFiles ? `\n\n_...and ${pr.files.length - maxFiles} more_` : ""}\n\n`
        : "";

    const maxRun = (diff.match(/`{3,}/g) ?? []).reduce((max, m) => Math.max(max, m.length), 3);
    const fence = '`'.repeat(maxRun + 1);

    return `${contextLine}${auditInstructions}

## PR Under Review

**Title:** ${pr.title}
**Branch:** ${pr.headRefName}
**Author:** ${pr.author}
${sizeLine}
${pr.body ? `### Description\n\n${pr.body}\n\n` : ""}${fileList}### Diff

Lines prefixed with \`+\` are additions, \`-\` are removals. Focus your review on additions and modified logic.
Skip lock files, generated code, and vendored dependencies.

${fence}diff
${diff}
${fence}
`;
  }

  buildMergePrompt(auditOutputs: Record<string, string>, diff: string): string {
    const models = Object.keys(auditOutputs);
    let audits = "";
    for (const [model, output] of Object.entries(auditOutputs)) {
      audits += `---\n## Audit by \`${model}\`\n\n${output}\n\n`;
    }

    const maxRun = (diff.match(/`{3,}/g) ?? []).reduce((max, m) => Math.max(max, m.length), 3);
    const fence = '`'.repeat(maxRun + 1);

    return `${buildMergeInstructions(models)}

## Audit comments from reviewers

${audits}

## PR Diff (for reference)

${fence}diff
${diff}
${fence}
`;
  }
}

const PROJECT_HINTS: Partial<Record<ProjectType, string>> = {
  node: "Watch for unhandled promise rejections, prototype pollution, missing input validation, and dependency-related issues.",
  android:
    "Watch for memory leaks (context/activity references), missing null checks, main-thread blocking, and permission misuse.",
  jvm: "Watch for resource leaks, unchecked casts, thread-safety issues, and exception swallowing.",
  rust: "Watch for unsafe blocks, lifetime issues, unwrap() on fallible paths, and missing error propagation.",
  go: "Watch for unchecked errors, goroutine leaks, nil pointer dereferences, and improper mutex usage.",
  python:
    "Watch for mutable default arguments, bare except clauses, missing type hints on public APIs, and injection via string formatting.",
  ruby: "Watch for mass assignment, N+1 queries, unsafe metaprogramming, and missing strong parameters.",
};

const OUTPUT_FORMAT = `## Output Format

For each finding:

#### [N]. [Short title] — Severity: <critical|high|medium|low>
**Category:** <bugs|security|performance|design|tests>
**File:** \`path/to/file\` L<line>
**Issue:** Description of the problem
**Suggested fix:** What to change (include code if helpful)

---

At the end, provide a summary table:

| # | Issue | Category | Severity | File |
|---|-------|----------|----------|------|

If the PR looks clean, say so — don't invent issues.`;

const AUDIT_INSTRUCTIONS = `You are a senior code reviewer performing an independent audit of a GitHub pull request.

## Review Categories

1. **Bugs** — Logic errors, race conditions, null safety, off-by-one errors, incorrect assumptions
2. **Security** — Injection, unsafe operations, data leaks, auth issues, OWASP top 10
3. **Performance** — Unnecessary allocations, hot-path inefficiencies, missing caching, N+1 queries
4. **Design** — Coupling, naming, abstraction quality, missing error handling, best practices
5. **Tests** — Untested code paths, edge cases, assertion quality

${OUTPUT_FORMAT}`;

function buildMergeInstructions(models: string[]): string {
  const total = models.length;
  const columnHeaders = models.map((m) => ` ${m} `).join('|');
  const columnSeparators = models.map(() => '------').join('|');

  return `You are consolidating code audit results from independent AI reviewers for a single PR.

## Your task

1. **Deduplicate**: Multiple AIs may flag the same issue — merge them into one entry and note which AIs agreed.
2. **Rank by consensus**: Issues flagged by most AIs → top priority. Few AIs → evaluate on merit.
3. **Filter noise**: Drop pure style nits or false positives. If only one AI flagged something and it looks wrong, drop it with a note.
4. **Produce a final report** with:
   - A prioritized action list (what to fix, in order)
   - A "dismissed" section (what was flagged but isn't worth fixing, with rationale)
   - A consensus summary table

## Format

### Action Items (ordered by priority)

#### 1. [Title] — Severity: <critical|high|medium|low>
**Consensus:** Flagged by: <list of models> (N/${total})
**File:** \`path/to/file\` L<line>
**Issue:** Description
**Recommended fix:** What to do

---

### Dismissed Findings

| Finding | Flagged by | Reason for dismissal |
|---------|-----------|---------------------|

### Consensus Summary

| # | Issue |${columnHeaders}| Severity |
|---|-------|${columnSeparators}|----------|`;
}
