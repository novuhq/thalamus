#!/usr/bin/env node
/**
 * Generate a Novu/nx-style conventional changelog section from git history.
 *
 * Usage:
 *   node generate-changelog.mjs --version 0.1.0-alpha.16 --from <git-ref> [--to HEAD] [--repo novuhq/thalamus]
 *
 * Prints markdown for one version section (stdout).
 */

import { execSync } from "node:child_process";

const SECTION_ORDER = [
  ["feat", "### 🚀 Features"],
  ["fix", "### 🩹 Fixes"],
  ["perf", "### ⚡ Performance"],
  ["refactor", "### 🔨 Refactors"],
  ["docs", "### 📄 Documentation"],
  ["chore", "### 🧹 Chores"],
];

/** Types omitted from changelog (noise). */
const SKIP_TYPES = new Set(["test", "ci", "style", "build"]);

function usage(msg) {
  if (msg) console.error(`Error: ${msg}`);
  console.error(
    "Usage: node generate-changelog.mjs --version X.Y.Z[-channel.N] --from <git-ref> [--to HEAD] [--repo owner/repo] [--date YYYY-MM-DD]",
  );
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    version: null,
    from: null,
    to: "HEAD",
    repo: "novuhq/thalamus",
    date: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--version") args.version = argv[++i];
    else if (a === "--from") args.from = argv[++i];
    else if (a === "--to") args.to = argv[++i];
    else if (a === "--repo") args.repo = argv[++i];
    else if (a === "--date") args.date = argv[++i];
    else usage(`unknown argument: ${a}`);
  }
  if (!args.version) usage("--version is required");
  if (!args.from) usage("--from is required");
  if (!args.date) args.date = new Date().toISOString().slice(0, 10);
  return args;
}

function git(cmd) {
  return execSync(`git ${cmd}`, { encoding: "utf8" }).trim();
}

/**
 * Parse: type(scope)!: subject (#123)
 * @returns {{ type: string, scope?: string, breaking: boolean, subject: string, pr?: string } | null}
 */
function parseConventional(subject) {
  const m = subject.match(
    /^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+?)(?:\s*\(#(\d+)\))?\s*$/,
  );
  if (!m) return null;
  return {
    type: m[1].toLowerCase(),
    scope: m[2],
    breaking: Boolean(m[3]) || /breaking change/i.test(subject),
    subject: m[4].replace(/\s*\(fixes?\s+NV-\d+\)\s*$/i, "").trim(),
    pr: m[5],
  };
}

function formatEntry(parsed, repo) {
  const scope = parsed.scope ? `**${parsed.scope}:** ` : "";
  const pr = parsed.pr
    ? ` ([#${parsed.pr}](https://github.com/${repo}/pull/${parsed.pr}))`
    : "";
  return `- ${scope}${parsed.subject}${pr}`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const range = `${args.from}..${args.to}`;
  const raw = git(`log ${range} --pretty=format:%s%x00%an%x00%ae --no-merges`);
  if (!raw) {
    console.error(`No commits in range ${range}`);
    process.exit(1);
  }

  /** @type {Map<string, string[]>} */
  const byType = new Map();
  /** @type {Map<string, string>} email -> name */
  const authors = new Map();
  const breaking = [];

  for (const line of raw.split("\n")) {
    const [subject, name, email] = line.split("\0");
    if (!subject) continue;
    // Skip version-bump-only commits
    if (/^chore:\s*(bump version|release)\b/i.test(subject)) continue;

    const parsed = parseConventional(subject);
    if (!parsed) {
      // Unconventional: park under chores if not skip-noise
      if (!byType.has("chore")) byType.set("chore", []);
      byType.get("chore").push(`- ${subject}`);
      if (name && email) authors.set(email, name);
      continue;
    }

    if (SKIP_TYPES.has(parsed.type)) continue;
    if (name && email) authors.set(email, name);

    if (parsed.breaking) {
      breaking.push(formatEntry(parsed, args.repo));
    }

    const bucket = SECTION_ORDER.some(([t]) => t === parsed.type)
      ? parsed.type
      : "chore";
    if (!byType.has(bucket)) byType.set(bucket, []);
    byType.get(bucket).push(formatEntry(parsed, args.repo));
  }

  const versionLabel = args.version.startsWith("v")
    ? args.version
    : `v${args.version}`;
  const lines = [`## ${versionLabel} (${args.date})`, ""];

  if (breaking.length) {
    lines.push("### ⚠️ Breaking Changes", "", ...breaking, "");
  }

  for (const [type, heading] of SECTION_ORDER) {
    const entries = byType.get(type);
    if (!entries?.length) continue;
    lines.push(heading, "", ...entries, "");
  }

  if (authors.size) {
    lines.push("### ❤️ Thank You", "");
    for (const name of [...authors.values()].sort((a, b) =>
      a.localeCompare(b),
    )) {
      lines.push(`- ${name}`);
    }
    lines.push("");
  }

  process.stdout.write(`${lines.join("\n").replace(/\n+$/, "\n")}`);
}

main();
