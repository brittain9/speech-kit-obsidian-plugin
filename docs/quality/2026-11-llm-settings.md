# LLM settings and daily controls

Speech Kit settings now contain provider and model configuration, secret references, transform controls, and preset, timing, context, and advanced model settings. The sidebar keeps the daily transform controls and opens settings for configuration. Settings and the sidebar share the same saved choices.

Settings group everyday transform controls separately from provider and model setup. Accessible gear buttons open preset and advanced options beside the related choice. The transform switch is disabled while LLM features are off; the saved transform mode is retained. An explicit successful connection test shows a confirmation and updates the button's accessible label.

Opening configuration does not load a provider's model list. Use the refresh control to request a list. Changing a provider or secret while transformation is disabled does not start a request. Connection tests remain explicit and use a fixed synthetic message. Provider error messages give recovery steps without displaying the provider's raw response.

Tests exercise configuration access before and after provider selection, adjacent actions, disabled-mode rendering and saved-mode preservation, connection feedback, the sidebar shortcut, delayed completion after close, separate model suggestion lists, and setting changes that overlap other edits. They use synthetic providers and no real credentials. Native Obsidian verification is still needed for the settings layout, secret selection, shortcut, preset editing, and switching between settings and the sidebar.
