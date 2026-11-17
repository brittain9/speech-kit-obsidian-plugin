# Popout media picker compatibility

Local media transcription created its file input in Obsidian's main document
even when the command was invoked from a popout. A public picker regression
reproduced the wrong owner: the main document received the hidden input while
the active popout received none.

The default owner is now Obsidian's `activeDocument`, resolved for each picker
request. Explicit document injection remains available, and selection/cancel/
abort cleanup still removes the input from its owning document. The ribbon also
uses `window.cancelAnimationFrame` to match its existing window-owned scheduler.

Native QA should move a synthetic note to a popout, invoke local file
transcription, select a public audio fixture, and verify progress/output remain
with that note. Cancel and repeat from the main window. The document-owner
regression and existing picker/ribbon tests are automated; they do not claim
native file-dialog or popout focus behavior was exercised.
