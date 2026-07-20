---
name: release-thalamus
description: >-
  Release @novu/thalamus to npm (stable, alpha, or rc), bump version, update
  CHANGELOG, optionally refresh README/skill docs when the public API deserves
  it, push a git tag, and create a GitHub Release. Use when the user asks to
  release, publish, ship, cut a version, bump alpha/rc/stable, or create an npm
  or GitHub release for thalamus.
---

# Release @novu/thalamus

Agent-driven release for the single package in this repo. Uses local `npm` /
`gh` auth (no repo secrets required).

## Defaults

| Decision | Default |
|---|---|
| Branch | `main` only (override only if user explicitly asks) |
| Stable from prerelease | Drop prerelease → base (`0.1.0-alpha.16` → `0.1.0`) |
| Alpha after stable | Next patch alpha (`0.1.0` → `0.1.1-alpha.0`) |
| Alpha → rc | Same base, `rc.0` (`0.1.0-alpha.16` → `0.1.0-rc.0`) |
| npm dist-tag | `latest` / `alpha` / `rc` |
| GitHub Release | Always; `--prerelease` for alpha/rc |
| Docs/skill | Update only when public surface deserves it (see below) |

## Workflow

Copy and track:

```
Release progress:
- [ ] 1. Inputs + version plan
- [ ] 2. Preconditions (auth, branch, clean tree)
- [ ] 3. Diff since last release → changelog draft
- [ ] 4. Docs/skill verdict (skip | update)
- [ ] 5. Apply docs/skill edits if needed
- [ ] 6. Quality gates
- [ ] 7. User confirmation (or dry-run)
- [ ] 8. Bump package.json + CHANGELOG
- [ ] 9. Commit + tag + push
- [ ] 10. npm publish
- [ ] 11. GitHub Release
- [ ] 12. Summary
```

### 1. Inputs + version plan

Ask if missing:

- **Channel**: `alpha` | `rc` | `stable`
- For **stable** when current is already stable: `--bump patch|minor|major` (default `patch`)
- **Mode**: `publish` (default) or `dry-run`

Compute next version:

```bash
node .cursor/skills/release-thalamus/scripts/next-version.mjs <alpha|rc|stable>
# optional: --current X.Y.Z-alpha.N  --bump patch|minor|major
```

Reconcile with npm (do not blindly trust package.json alone):

```bash
npm view @novu/thalamus versions --json
npm view @novu/thalamus dist-tags --json
```

- Baseline = max of package.json version and highest published version on that prerelease line / stable line.
- If package.json is ahead of npm (unpublished bump), warn and propose publishing that version or bumping past it — ask the user.
- Pass the reconciled baseline via `--current` into the script when needed.

Present plan: `current → next`, npm tag, git tag `v<next>`, prerelease yes/no.

### 2. Preconditions

Abort unless all pass (or user explicitly overrides branch):

```bash
git status --porcelain          # must be empty before release edits begin
git branch --show-current       # expect main
git fetch origin main
git rev-parse HEAD
git rev-parse origin/main       # HEAD should match origin/main
npm whoami                      # must succeed; prefer @novu org access
gh auth status                  # must succeed
```

If tree is dirty with unrelated work: stop. Only proceed when clean, then make release edits yourself.

### 3. Changelog draft

Match Novu packages (`nx release` + conventional commits). Do **not** use Keep a Changelog headings.

Find last release anchor (first that exists):

1. Latest git tag matching `v*`
2. Else latest `chore: bump version` / `chore: release` commit
3. Else ask user for a from-ref

Generate the section:

```bash
node .cursor/skills/release-thalamus/scripts/generate-changelog.mjs \
  --version <next> \
  --from <from-ref>
```

Also skim the diff for missed public-API notes:

```bash
git diff <from>..HEAD --stat -- package.json src/ README.md .cursor/skills/thalamus/
```

Expected shape (same as `novu/packages/*/CHANGELOG.md`):

```markdown
## v0.1.0-alpha.16 (2026-07-20)

### 🚀 Features

- emit non-fatal mcp-server-failure stream part … ([#16](https://github.com/novuhq/thalamus/pull/16))

### 🩹 Fixes

- …

### ❤️ Thank You

- Name
```

Rules:

- Drive entries from conventional commit types (`feat` → Features, `fix` → Fixes, …)
- Keep PR links (`(#N)` → GitHub URL)
- Omit empty subsections; skip noisy `test`/`ci`/`style` commits
- Lightly edit subjects for clarity if needed; do not invent features that are not in the commits/diff
- If `CHANGELOG.md` is missing, create it with `# Changelog\n\n` then the new section

Write GitHub release notes to a temp file (e.g. `/tmp/thalamus-release-notes.md`) — same section body **without** the `# Changelog` title, plus footer:

```markdown
npm: https://www.npmjs.com/package/@novu/thalamus/v/<next>
```

### 4. Docs/skill verdict (do not force)

Inspect the diff for **public surface** impact:

- `package.json` `exports` / peerDependencies
- Exported APIs under `src/` (providers, vault, durable, webhook, errors, logger, stream parts)
- Behavior users rely on that README or `.cursor/skills/thalamus/SKILL.md` describe

**Update** only if at least one is true:

- New/removed/renamed public export or option
- Breaking or surprising behavior change
- New capability the skill should teach
- Existing README/skill examples would be wrong or misleading

**Skip** (state a one-line reason) when changes are:

- Internal refactors, perf, types-only, tests-only
- Bugfixes that restore already-documented behavior
- Dependency bumps with no API impact
- Changelog-worthy but not skill-worthy

When unsure: ask ("API changed but examples still accurate — skip?"). Never invent filler docs for every alpha.

Out-of-scope large rewrites → note follow-up; do not bloat the release.

### 5. Apply docs/skill edits (only if verdict = update)

Surgical edits only:

- `README.md`
- `.cursor/skills/thalamus/SKILL.md`

Match existing tone/structure. Include these edits in the release commit set.

### 6. Quality gates

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Stop on failure.

### 7. Confirmation

Show:

- Version plan
- Changelog draft
- Docs/skill verdict + files touched
- Commands that will run (`publish`, tag, `gh release create`)

Wait for explicit go-ahead unless user already said e.g. "release alpha now" / `--yes`.

Dry-run path:

```bash
pnpm build
npm publish --dry-run --access public --tag <npmTag>
```

Do not commit/tag/publish on dry-run.

### 8. Bump package.json + CHANGELOG

- Set `package.json` `"version"` to `next` (keep other fields intact)
- Create `CHANGELOG.md` if missing (title `# Changelog`, brief intro)
- Prepend the new section under the title

### 9. Commit + tag + push

Follow repo commit style. Typical message:

```text
chore: release v<next>
```

```bash
git add package.json CHANGELOG.md README.md .cursor/skills/thalamus/SKILL.md
# only stage files actually changed for this release
git commit -m "$(cat <<'EOF'
chore: release v<next>

EOF
)"
git tag -a "v<next>" -m "v<next>"
git push origin main
git push origin "v<next>"
```

If commit hooks modify files, amend only when allowed by user git rules; otherwise make a follow-up commit before tagging.

### 10. npm publish

```bash
pnpm build
npm publish --access public --tag <npmTag>
```

- `stable` → `--tag latest`
- `alpha` → `--tag alpha`
- `rc` → `--tag rc`

Verify:

```bash
npm view @novu/thalamus@<next> version
```

### 11. GitHub Release

```bash
# prerelease (alpha / rc):
gh release create "v<next>" --title "v<next>" --notes-file /tmp/thalamus-release-notes.md --prerelease

# stable:
gh release create "v<next>" --title "v<next>" --notes-file /tmp/thalamus-release-notes.md
```

If the release already exists, stop and report; do not overwrite unless the user asks.

### 12. Summary

Return:

- Version + channel + npm tag
- npm URL
- Git tag
- GitHub Release URL
- Docs/skill: updated paths **or** "skipped — \<reason\>"

## Abort conditions

Stop immediately if:

- Not on `main` (unless user override)
- Dirty tree before you start release edits
- `npm whoami` / `gh auth status` fails
- Quality gates fail
- Version already published on npm
- User declines confirmation

## Notes

- Do not add npm tokens to GitHub Actions as part of this skill.
- Do not force-push tags or rewrite published versions.
- Prefer one release commit that includes version, changelog, and any justified docs/skill updates.
