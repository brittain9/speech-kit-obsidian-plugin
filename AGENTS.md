# Releases and deployments

Agents must obtain Alex's explicit approval for the specific release or deployment
before triggering it, including pushing a release tag, running a workflow that
can publish or deploy, or publishing a package or release. Present the prepared version, commit and
validation results before asking for approval. Approval to improve the app, run
CI, or merge PRs is not release or deployment approval.

After approval, the existing release automation may complete publication; no
second manual Publish step is required. Read
[the release runbook](docs/release/cutting-a-release.md) when preparing or carrying
out an approved release. Routine development, testing, artifact-only dry runs and
PR work remain autonomous.
