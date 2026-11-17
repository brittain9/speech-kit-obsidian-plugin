# Native desktop dependency review for #555

Review date: 2026-11-17. Exact direct releases are pinned in `native/Cargo.toml`;
transitive versions and registry checksums are locked in `native/Cargo.lock`.
Reviewed published crates.io source and metadata, rather than adopting upstream
Git revisions. This is a scoped integration review, not a complete security audit.

| Dependency                                                   | Pin     | License / minimum Rust | Purpose and review                                                                                                                                                                                                                             |
| ------------------------------------------------------------ | ------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [global-hotkey](https://github.com/tauri-apps/global-hotkey) | 0.10.0  | MIT/Apache-2.0; 1.77   | Windows RegisterHotKey and ordinary macOS Carbon chords. Event callbacks marshal to the owning UI loop. No global key logger or injected typing. Media-key permission paths are not needed for configured ordinary chords.                     |
| [tray-icon](https://github.com/tauri-apps/tray-icon)         | 0.26.1  | MIT/Apache-2.0; 1.90   | Native macOS/Windows menus through muda. Default Linux AppIndicator/GTK features disabled; Linux uses ksni directly.                                                                                                                           |
| [winit](https://github.com/rust-windowing/winit)             | 0.30.13 | Apache-2.0; 1.70       | Supported main-thread macOS/Windows event loop. Default features disabled and dependency restricted to these targets; no Linux window-system dependency introduced through this crate. Initialized only when desktop integration is requested. |
| [ashpd](https://github.com/bilelmoussaoui/ashpd)             | 0.14.0  | MIT; 1.89              | Linux GlobalShortcuts portal over the user session D-Bus. Only Tokio and global_shortcuts features enabled. Effective binding comes from portal approval. Host Registry identity is requested explicitly and failure is reported.              |
| [ksni](https://github.com/iovxw/ksni)                        | 0.3.7   | Unlicense; 1.80        | Linux StatusNotifierItem and menu over session D-Bus, including watcher availability changes. Async handle runs on the desktop service runtime; no GTK library requirement.                                                                    |

All minimum compiler versions are below the repository's pinned Rust 1.94.1.
Native UI dependencies add Objective-C/AppKit and Windows bindings, menu/event
infrastructure, and image/PNG support. The Linux integrations add zbus/zvariant
and procedural macro dependencies. ksni and ashpd currently resolve different
zbus major versions; this is a dependency-size cost of using their published APIs.
No downloaded executable or new runtime network endpoint is introduced. Existing
ORT runtime acquisition is unchanged. winit/tray-icon build scripts select
platform configuration/resources; they do not add a remote executable install.

Cargo resolution raised existing `socket2` 0.6.4 to 0.6.5 and `bitflags` 2.13.0 to
2.13.2. Attempts to retain the old versions were rejected because ashpd's resolved
zbus 6.3.0 requires `socket2 ^0.6.5` and `bitflags ^2.13.2`. These are required
transitive changes, not an unrelated dependency refresh.

The code uses `std::fs::File::try_lock` for exclusive per-user ownership, avoiding
an additional locking crate. The lock file remains on disk but the operating
system releases ownership on process exit.

Runtime certification still requires installed Windows, GNOME Wayland and
Hyprland trials. In particular, portal identity, consent behavior and compositor
bindings must be tested on those actual desktop versions. Compilation alone does
not establish their availability.

## macOS control popover

The native control popover uses a direct exact `objc2-app-kit = 0.3.2` dependency,
already present transitively through the native tray implementation. Published
crate metadata: Rust 1.71 minimum; Zlib OR Apache-2.0 OR MIT; no build script.
Default features are disabled and only the view, visual-effect material, image,
text, button, status-item and popover APIs used by the controls are enabled.
Source reference: [objc2 AppKit bindings](https://docs.rs/objc2-app-kit/0.3.2/objc2_app_kit/).
No HTML renderer, embedded browser or additional GUI application framework is
introduced. Target/action objects are retained for the lifetime of controls;
recording state updates mutate existing views rather than rebuilding open UI.
