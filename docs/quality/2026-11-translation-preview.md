# Translation preview ownership

A detached translation remains owned by its original note. The preview shows the source path and retains edits across closing and reopening. If the source view moves to another file, the preview offers Copy and Dismiss instead of applying or starting another translation from that view. The user can then invoke translation in the intended note.

In native testing, invoking translation from a different note reopened an earlier preview. Its original editor view had since moved to a third note. The old retry action could translate that third note. The updated controller tracks the original file, checks it again before applying or retrying, and keeps the reviewed output with the active translation. A regression test also covers another file with identical text.

The tests exercise the commands and translation controller with simulated Obsidian views. Native verification is still needed for switching notes, editing and reopening a preview, applying to the original note, and renaming the original note.
