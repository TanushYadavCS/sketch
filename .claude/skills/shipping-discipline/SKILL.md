---
name: shipping-discipline
description: The judgment layer of shipping — what "done" actually means, how to triage review findings, how to review code, and the release rules that protect production. Use when finishing a feature, handling reviewer feedback, reviewing someone's PR, or preparing a release.
---

# Shipping Discipline

CLAUDE.md has the mechanics (commands, gates, branch rules). This skill is the judgment: what those mechanics are for, and the decisions they do not make for you.

## What "done" means

- **Green gates are the floor, not the definition.** Done means: all quality checks pass, the change is exercised through its REAL entry point, and evidence exists. For UI work that means running the app and clicking through the flow, with full-screen screenshots; component tests alone have repeatedly passed while the actual page was broken.
- **Test the change where it will actually run.** A feature that will run against Postgres in production is not verified by SQLite tests alone. A feature that runs inside a Slack thread is not verified by a unit test of its handler.
- **Evidence over assertion.** "It works" is a claim; a log line, a screenshot, or a before/after number is verification. When you hand work over, hand the evidence with it.

## Reviewing code (yours or anyone's)

- **Read every changed file.** Running the tests and skimming the diff summary is not a review. Bugs we caught by reading, after all gates were green, include a cost-accounting error that would have inflated every tenant's reported bill ~9x. The tests encode the author's assumptions; reading is how you check the assumptions themselves.
- **Review rounds converge; make them.** Re-request review after fixes until a round comes back clean or contains only refuted findings. Stopping after "most things fixed" leaves the sharpest finding, usually found last, unhandled.
- **Statically-identical is not temporally-identical.** Be careful approving removals of "redundant" checks. We nearly removed a post-save assertion that looked identical to a pre-run assertion; it was a race net, checking the same condition at a different TIME. Before deleting a duplicate check, ask what can change between the two points.

## Triaging review findings

Review findings (human, bot, or LLM) are inputs, not orders.

- **Verify blocker claims empirically before fixing.** A fix applied to a false claim is a new bug. When a finding asserts a behavioral fact ("this field double-counts"), reproduce the fact first; the fix direction depends on it.
- **Refute false positives explicitly, with evidence,** and record the refutation where the finding lives. An unrefuted false positive gets re-reported forever.
- **Fix the class, not the instance.** When a finding is real, look for its siblings before closing it. The second instance of a bug pattern is usually two files away.

## Release rules and why they exist

- **Release only from `main`, tags only from `main`.** Main is validated code; a tag from a feature branch produces an artifact nobody reviewed as a whole. Pre-release testing happens on branch builds BEFORE merge, not by releasing branches.
- **Rollback safety is decided at merge time.** If a release includes migrations, the previous image may not run against the new schema. Know the rollback story (usually a flag or env flip, not an image rollback) before shipping, and say it in the PR.
- **Never skip git hooks.** `--no-verify` converts a known local failure into an unknown production one. If the hook fails, the hook found something; fix the cause. This includes "harmless" pushes: branch deletions and pointer updates have hooks too.
- **Small, reviewed PRs beat one large one.** Every large-branch effort we ran was saved at least once by the fact that each slice had been independently reviewed before the whole-branch pass.

## Changing test infrastructure

Test-infra changes (config, isolation, pools, shared fixtures) can pass once and flake forever. Run the full suite MULTIPLE times before committing one, because the failure mode is nondeterministic by nature. Respect the tiering rules in CLAUDE.md; mis-tiering a test (e.g. an integration test in the unit tier) degrades everyone's loop. And when a test flakes, fix the flake properly (real waits, deterministic ordering); a retried flake is a bug with a snooze button.
