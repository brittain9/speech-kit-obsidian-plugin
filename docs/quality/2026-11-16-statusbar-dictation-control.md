# Persistent dictation status control

The existing dictation status-bar item now keeps a compact native capture button
available while idle. It supports starting, cancelling startup, stopping capture,
and retrying after an error through the same controller toggle used by commands
and the ribbon. The ribbon and optional sidebar remain available.

The button is mounted once. Workflow updates change its label and a separate live
status span, preserving button identity and keyboard focus. Older local/provider
work can finish beside a new capture session without changing that session's
Start/Stop action. Disposal removes the click listener before asynchronous plugin
teardown. No new session state owner, inference path, or background animation is
introduced. The merged crash/retry fix preserves single-click retry behavior.

Public renderer tests cover idle visibility, native button semantics, labeled
start/cancel/stop/retry actions, finishing work beside a new capture, focus and
identity retention, and disposal. The existing controller tests exercise startup
cancellation and single-click error retry. The shared native QA owner will compare
this control with the ribbon hidden; that visual and interaction check remains
required before merging this exploratory change. Obsidian can also hide its
status bar, so command/hotkey capture remains available.
