# Model store switching

Changing the model store is an explicit Apply action. Typing does not save the path or query the sidecar. The manager checks the new store before saving it, holds the sidecar mutation gate during the switch, clears stale managed-model data, and refreshes the selected speech and read-aloud models in sequence. It preserves model selections and external-file capability snapshots. A failed preflight leaves the old path and list intact.

Managed-model capability snapshots now record the configured store. Older snapshots without a store identity require one fresh probe. This avoids showing a model as ready using capabilities from a different folder.

The three store-scoped sidecar queries now use request IDs. Responses and errors must match the originating request, including after a timeout. The sidecar accepts old requests without IDs and omits the field in their responses. The updated frontend requires a sidecar that echoes the IDs; an older sidecar is rejected with an update message. The frontend and native sidecar must be built and installed together for development testing. A future sidecar-bearing release must update the compatibility pointer under the release process. No release, tag, or version change is included here.

Tests cover explicit Apply, active-work refusal, failed preflight and settings save, stale initialization and probe results, disposal, preserved selections, and out-of-order or late query responses. A locally built sidecar returned matching IDs for two temporary stores, their empty installed lists, and an invalid-path error. It then exited cleanly. Native Obsidian verification is still required for switching between distinct stores and confirming the displayed installed models and selected-model availability.
