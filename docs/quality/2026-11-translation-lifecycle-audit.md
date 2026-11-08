# Translation lifecycle audit — 2026-11-08

HY-MT translation now holds a sidecar use lease while a request can use the shared process. This blocks sidecar replacement, restart, and model mutation until the request reaches a terminal event. Firefox translation does not use the sidecar or this lease.

Cancel rejects the translation request immediately. If the command was sent, the lease remains until the matching completion, cancellation, or error event, or until the sidecar exits. If startup is still pending, the lease remains until startup unwinds. A confirmed sidecar shutdown or exit also releases pending translation ownership. If a connection is disposed while its process is still running, ownership remains until that process exits.

A failed cancellation write leaves native ownership uncertain. The request rejects with the write error and the lease remains until a terminal event or confirmed process exit. The current translation view labels the job cancelled after the user presses Cancel, even if the cancellation command could not be sent. If the sidecar remains running without a terminal event, maintenance stays blocked. Close and reopen Obsidian to shut down the shared sidecar before retrying maintenance. This recovery affects other work using the sidecar.

The tests exercise the translation client, lifecycle gate, and framed sidecar connection with a simulated process. In native Obsidian testing, Restart sidecar was blocked while a detached HY-MT translation was at block 4 of 12. The notice described a maintenance operation, so the copy was corrected to describe a busy speech engine. Confirm the revised notice and successful mutation after completion or acknowledged cancellation in a follow-up test.
