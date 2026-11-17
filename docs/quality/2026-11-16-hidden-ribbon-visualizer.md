# Hidden ribbon visualizer

The ribbon visualizer kept its animation loop running while its element was
hidden. A controller-level reproduction drove 20 visible animation frames, then
120 frame opportunities after a simulated nonintersection observation. The
baseline still read the audio bands 120 times while hidden.

One IntersectionObserver now owns visibility tracking. The visualizer waits for
its first visible observation, cancels animation and clears per-bar styles when
offscreen, and resumes only while speech or its existing tail hold is eligible.
There are no per-frame layout reads. Accessibility labels still reflect the real
dictation state while hidden. The existing behavior remains the fallback where
IntersectionObserver is unavailable.

Tests cover hide/reveal, initial hidden state, zero-area edge intersections, the original five-second speech
tail deadline, reduced-motion changes, disposal, and late observer callbacks.
The same 120 hidden frame opportunities now produce zero band reads and no
scheduled animation frame. These callback counts do not measure total CPU use,
wakeups, or battery life; this change makes no battery-life claim.

The [Intersection Observer specification](https://www.w3.org/TR/intersection-observer/)
allows an edge intersection with zero area. Animation therefore requires a
positive intersection rectangle and at least 1% intersection, matching the
observer threshold. Pausing below that threshold also handles zero-area edge
transitions for which no additional browser notification is required. This observes viewport geometry rather than
OS window occlusion or every possible CSS visibility effect.

Native QA should hide and reveal Obsidian's ribbon during dictation and during
the speech tail. Confirm the icon resumes when visible, listening labels remain
accurate, reduced motion stays static, and unloading/reloading the plugin leaves
no animation behind. Browser intersection notifications are simulated in the
automated tests, so native layout behavior remains a separate check.

Fresh review added a regression for a 0.5% intersection followed by a zero-area
edge without another observation, plus post-disposal state changes. Both failed
before the follow-up: hidden animation still read 120 times and a late listening
state recreated a tail timer. Visibility eligibility now matches the notification
threshold, and disposed controllers ignore later setters. All 22 ribbon tests
pass.
