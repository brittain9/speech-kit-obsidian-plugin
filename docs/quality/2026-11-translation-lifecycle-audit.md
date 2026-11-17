# Translation lifecycle audit — 2026-11-08

HY-MT translation now holds a sidecar use lease while a request can use the shared process. This blocks sidecar replacement, restart, and model mutation until the request reaches a terminal event. Firefox translation does not use the sidecar or this lease.

Cancel rejects the translation request immediately. If the command was sent, the lease remains until the matching completion, cancellation, or error event, or until the sidecar exits. If startup is still pending, the lease remains until startup unwinds. A confirmed sidecar shutdown or exit also releases pending translation ownership. If a connection is disposed while its process is still running, ownership remains until that process exits.

A failed cancellation write leaves native ownership uncertain. The request rejects with the write error and the lease remains until a terminal event or confirmed process exit. If the sidecar remains running without a terminal event, maintenance stays blocked. Quit and reopen Obsidian to shut down the shared sidecar before retrying maintenance. This recovery affects other work using the sidecar.

The tests exercise the translation client, lifecycle gate, and framed sidecar connection with a simulated process. In native Obsidian testing, Restart sidecar was blocked while a detached HY-MT translation was at block 4 of 12. The notice described a maintenance operation, so the copy was corrected to describe a busy speech engine. Confirm the revised notice and successful mutation after completion or acknowledged cancellation in a follow-up test.

## Cancellation status follow-up — 2026-11-16

The original view always reported cancellation as complete, even when a native
cancellation command failed or remained unacknowledged. Two controller-level
regressions reproduced both cases before implementation.

The job now reports cancelled output separately from pending native termination.
The preview and detached status explain that the engine is still stopping, or
that its stop could not be confirmed. Close detaches the preview while retaining
that status; retry and configuration controls remain unavailable until the keyed
terminal event, startup unwind, or process stop releases backend ownership.
Recovery copy asks the user to stop other speech work before quitting and reopening Obsidian.
No automatic process shutdown affects other work.

Automated coverage exercises cancellation write success and failure, reopening
without duplicate inference, the retained maintenance lock, acknowledged cleanup,
unchanged note text, and detached live announcements. Native QA should translate
a synthetic note with HY-MT, cancel during inference, close/reopen the preview,
and verify that normal cancelled actions return after acknowledgement. A failed
cancellation write and missing acknowledgement remain deterministic simulated
transport checks rather than claimed native observations.
