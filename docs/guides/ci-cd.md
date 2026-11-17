# CI and manually approved releases

CI runs on pull requests, main, merge groups, and manual dispatch. It does not
publish a release. Use manual dispatch to run every platform without creating a
tag or release.

## Coverage

| Change                                                       | Frontend | Native + real client | Platform matrix |
| ------------------------------------------------------------ | -------- | -------------------- | --------------- |
| Docs or ordinary UI                                          | Always   | No                   | No              |
| Frontend/native protocol, model management, npm dependencies | Always   | Yes                  | No              |
| Native code/catalog, build scripts, Actions, unknown paths   | Always   | Yes                  | Yes             |
| Manual dispatch or merge group                               | Always   | Yes                  | Yes             |

The planner reads the complete Git diff, including deleted files and both paths
of renames. It does not use GitHub's limited changed-file path filter. Invalid
comparisons fail CI; they never silently reduce coverage. Unknown files receive
the full matrix. Native tests and build checks use the same ordered engine
features, including Metal on macOS.

`frontend-checks` provides early frontend feedback. The existing required
`frontend-quality` check is now the aggregate result. It runs even after a failed
dependency and rejects a missing plan, failed frontend checks, or failed/skipped
native jobs that the plan required. No repository rule needs to be renamed.
This follows GitHub's guidance for
[required checks with conditional jobs](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks).

The platform matrix covers macOS Metal, Windows x64/ARM64 and Linux ARM64; the
portable lane uses the Ubuntu 24.04 Linux x64 release baseline and the production
TypeScript client against the
real sidecar. Native changes receive this coverage before merge, rather than
discovering platform compilation failures only on main. These are build and
correctness checks, not a claim of real microphone/GPU testing on every host.

Real-model accuracy and speed evaluations remain manual diagnostics. Their raw
results inform model tradeoffs; they are not universal model eligibility rules.
See [the criteria audit](../quality/2026-11-17-ci-model-criteria-audit.md).

## Caches and failures

Rust caches remain separated by platform, toolchain and build-affecting native
environment. Cleanup retains live branches and open PR refs, reads all inventory
pages before deleting, and stops on inventory failure. Nothing in CI authorizes
automatic cache deletion outside the existing cleanup workflow.

Stale CI runs are cancelled by ref. Each job has a bounded timeout. A platform
failure fails the aggregate result; `fail-fast: false` preserves other platform
diagnostics. Fix the cause and rerun affected checks. Do not increase an accuracy
budget or suppress a failed check merely to make CI green.

## Release approval

Release preparation is separate from routine CI. A tag may build and stage a
draft, but publication requires the owner's explicit manual action. Workflow
dispatch stays a dry run. See the release runbook for asset validation and the
final approval procedure. Do not run release workflows as part of CI testing.

This redesign does not change repository protection rules, provision credentials,
publish a version, or claim a measured cold-build speedup. Warm validation confirms
consistent native features; longer-term cache and timing comparisons remain
observable in Actions rather than assumed.

## Routine metadata avoids GPU initialization

The newly enabled Metal protocol check exposed a timeout on a hosted macOS
runner. Source inspection and a controlled public-wire regression confirmed
that Whisper's old diagnostic string enumerated backends, creating the Metal
device and compiling its library. The exact hosted-runner stall is not proven,
but routine metadata should not depend on that work.

System information now reports the Whisper version, build CPU flags and compiled
accelerator support without backend discovery. Structured capability fields and
test timeouts are unchanged. The regression injects a slow Metal function only
into its own test child and verifies both fixture loading and absence of device
initialization; it does not modify machine security settings.
