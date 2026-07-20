#!/usr/bin/env node
/**
 * Compute the next @novu/thalamus version for a release channel.
 *
 * Usage:
 *   node next-version.mjs <alpha|rc|stable> [--current X.Y.Z[-channel.N]] [--bump patch|minor|major]
 *
 * Prints JSON: { current, next, npmTag, prerelease, gitTag }
 */

const CHANNELS = new Set(["alpha", "rc", "stable"]);
const BUMPS = new Set(["patch", "minor", "major"]);

function usage(msg) {
  if (msg) console.error(`Error: ${msg}`);
  console.error(
    "Usage: node next-version.mjs <alpha|rc|stable> [--current X.Y.Z[-channel.N]] [--bump patch|minor|major]",
  );
  process.exit(1);
}

function parseArgs(argv) {
  const args = { channel: null, current: null, bump: "patch" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--current") {
      args.current = argv[++i];
      if (!args.current) usage("--current requires a value");
    } else if (a === "--bump") {
      args.bump = argv[++i];
      if (!BUMPS.has(args.bump)) usage(`invalid --bump: ${args.bump}`);
    } else if (!a.startsWith("-") && !args.channel) {
      args.channel = a;
    } else {
      usage(`unknown argument: ${a}`);
    }
  }
  if (!CHANNELS.has(args.channel))
    usage(`channel must be one of: alpha, rc, stable`);
  return args;
}

/**
 * @returns {{ major: number, minor: number, patch: number, pre?: { id: string, n: number } }}
 */
function parseVersion(raw) {
  const m = String(raw)
    .trim()
    .match(/^(\d+)\.(\d+)\.(\d+)(?:-(alpha|rc)\.(\d+))?$/);
  if (!m) {
    throw new Error(
      `unsupported version "${raw}" (expected X.Y.Z, X.Y.Z-alpha.N, or X.Y.Z-rc.N)`,
    );
  }
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? { id: m[4], n: Number(m[5]) } : undefined,
  };
}

function formatVersion(v) {
  const base = `${v.major}.${v.minor}.${v.patch}`;
  return v.pre ? `${base}-${v.pre.id}.${v.pre.n}` : base;
}

function bumpBase(v, bump) {
  if (bump === "major") return { major: v.major + 1, minor: 0, patch: 0 };
  if (bump === "minor") return { major: v.major, minor: v.minor + 1, patch: 0 };
  return { major: v.major, minor: v.minor, patch: v.patch + 1 };
}

function nextVersion(currentRaw, channel, bump) {
  const current = parseVersion(currentRaw);

  if (channel === "alpha") {
    if (current.pre?.id === "alpha") {
      return { ...current, pre: { id: "alpha", n: current.pre.n + 1 } };
    }
    if (current.pre?.id === "rc") {
      // Unusual: leaving rc for a new alpha on the next patch line
      const base = bumpBase(current, "patch");
      return { ...base, pre: { id: "alpha", n: 0 } };
    }
    // Stable → next patch alpha
    const base = bumpBase(current, bump);
    return { ...base, pre: { id: "alpha", n: 0 } };
  }

  if (channel === "rc") {
    if (current.pre?.id === "rc") {
      return { ...current, pre: { id: "rc", n: current.pre.n + 1 } };
    }
    if (current.pre?.id === "alpha") {
      // Promote alpha line to rc.0 on the same base
      return {
        major: current.major,
        minor: current.minor,
        patch: current.patch,
        pre: { id: "rc", n: 0 },
      };
    }
    const base = bumpBase(current, bump);
    return { ...base, pre: { id: "rc", n: 0 } };
  }

  // stable
  if (current.pre) {
    // Drop prerelease → base version (0.1.0-alpha.16 → 0.1.0)
    return {
      major: current.major,
      minor: current.minor,
      patch: current.patch,
    };
  }
  return bumpBase(current, bump);
}

function npmTagFor(channel) {
  if (channel === "stable") return "latest";
  return channel;
}

const args = parseArgs(process.argv.slice(2));

let current = args.current;
if (!current) {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const root = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  current = pkg.version;
}

const next = nextVersion(current, args.channel, args.bump);
const nextStr = formatVersion(next);

const out = {
  current,
  next: nextStr,
  channel: args.channel,
  npmTag: npmTagFor(args.channel),
  prerelease: Boolean(next.pre),
  gitTag: `v${nextStr}`,
  bump: args.bump,
};

process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
