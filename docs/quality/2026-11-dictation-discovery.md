# Dictation discovery, November 16

The original Speech Kit view was a transformation panel, bootstrapped only when
AI features were enabled. There was no command to reopen it after closing it.
The ribbon and existing start/stop commands worked, but a hidden ribbon/sidebar
left the controls difficult to find. This is a source-confirmed discovery gap;
it does not establish the cause of the reported Linux workspace difference.

Retained approach: an explicit **Open Speech Kit** command, a Settings action,
and an optional setup-completion action reveal one existing view or create it.
The view has a start/stop button independently of AI settings. Its label updates
in place as capture changes so focus stays on the same control. The setup action
saves completion and closes the wizard before opening controls; it never starts
microphone capture. Initial sidebar provisioning runs once, and changing AI
settings refreshes the view rather than detaching or reopening it.

Rejected: assigning a default hotkey, forcing a collapsed sidebar open on every
startup, or making dictation depend on AI features. Existing command identifiers
and user-selected shortcuts are preserved.

A missing start button and absent open command were observed failing through
public view/command tests before implementation. Workspace tests cover reusing
and revealing the existing leaf, creating a leaf, and no available leaf. Setup
tests cover successful completion and failed save. Native layout and first-use
results belong in the combined QA report; Mac observations do not close the
Linux-specific report.
