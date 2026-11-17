//! Native macOS controls, shown only after an explicit status-item click.
use super::*;
use global_hotkey::hotkey::{HotKey, Modifiers};
use objc2::{
    DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send, rc::Retained, sel,
};
use objc2_app_kit::*;
use objc2_foundation::{NSObject, NSPoint, NSRect, NSRectEdge, NSSize, NSString};

struct TargetState {
    actions: Actions,
    popover: Retained<NSPopover>,
}
define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = TargetState]
    struct ControlTarget;
    impl ControlTarget {
        #[unsafe(method(toggle:))]
        fn toggle(&self,_sender:&NSObject){self.ivars().actions.emit("toggle");self.ivars().popover.close();}
        #[unsafe(method(openTarget:))]
        fn open_target(&self,_sender:&NSObject){self.ivars().actions.emit("open_target");self.ivars().popover.close();}
        #[unsafe(method(openSettings:))]
        fn open_settings(&self,_sender:&NSObject){self.ivars().actions.emit("open_settings");self.ivars().popover.close();}
    }
);
fn rect(x: f64, y: f64, width: f64, height: f64) -> NSRect {
    NSRect::new(NSPoint::new(x, y), NSSize::new(width, height))
}
fn label(
    text: &str,
    frame: NSRect,
    size: f64,
    color: &NSColor,
    mtm: MainThreadMarker,
) -> Retained<NSTextField> {
    let field = NSTextField::labelWithString(&NSString::from_str(text), mtm);
    field.setFrame(frame);
    field.setFont(Some(&NSFont::systemFontOfSize(size)));
    field.setTextColor(Some(color));
    field
}
pub(super) struct Popover {
    view: Retained<NSPopover>,
    state_label: Retained<NSTextField>,
    destination: Retained<NSTextField>,
    location: Retained<NSTextField>,
    primary: Retained<NSButton>,
    open: Retained<NSButton>,
    // Last: target must outlive all retained controls with unretained target/action links.
    _target: Retained<ControlTarget>,
}
impl Popover {
    pub fn new(
        config: &Configuration,
        status: &Status,
        actions: Actions,
        registered_shortcut: Option<&HotKey>,
    ) -> Self {
        let mtm = MainThreadMarker::new().expect("Popover belongs to main UI thread");
        let popover = NSPopover::new(mtm);
        popover.setBehavior(NSPopoverBehavior::Transient);
        popover.setAnimates(false);
        let shortcut_hint = registered_shortcut_hint(registered_shortcut);
        let footer_height = if shortcut_hint.is_some() { 22.0 } else { 0.0 };
        let height = 194.0 + footer_height;
        popover.setContentSize(NSSize::new(336.0, height));
        let target = ControlTarget::alloc(mtm).set_ivars(TargetState {
            actions,
            popover: popover.clone(),
        });
        // SAFETY: NSObject initialization and selectors are defined above; the retained target outlives the controls.
        let target: Retained<ControlTarget> = unsafe { msg_send![super(target), init] };
        let content = NSVisualEffectView::initWithFrame(
            NSVisualEffectView::alloc(mtm),
            rect(0.0, 0.0, 336.0, height),
        );
        content.setMaterial(NSVisualEffectMaterial::Popover);
        content.setBlendingMode(NSVisualEffectBlendingMode::WithinWindow);
        content.setState(NSVisualEffectState::Active);
        // Keep the destination and primary controls unchanged; only a confirmed
        // registration earns an additional footer below them.
        let controls =
            NSView::initWithFrame(NSView::alloc(mtm), rect(0.0, footer_height, 336.0, 194.0));
        content.addSubview(&controls);
        if let Some(hint) = shortcut_hint {
            let footer = label(
                &hint,
                rect(18.0, 25.0, 300.0, 15.0),
                11.0,
                &NSColor::secondaryLabelColor(),
                mtm,
            );
            footer.setLineBreakMode(NSLineBreakMode::ByTruncatingTail);
            footer.setToolTip(Some(&NSString::from_str(&hint)));
            content.addSubview(&footer);
        }
        let title = label(
            "Speech Kit",
            rect(18.0, 151.0, 260.0, 24.0),
            15.0,
            &NSColor::labelColor(),
            mtm,
        );
        title.setFont(Some(&NSFont::boldSystemFontOfSize(15.0)));
        controls.addSubview(&title);
        let settings = symbol_button(
            "gearshape",
            &config.labels.settings,
            sel!(openSettings:),
            &target,
            mtm,
        );
        settings.setFrame(rect(290.0, 148.0, 28.0, 28.0));
        controls.addSubview(&settings);

        if let Some(image) = NSImage::imageWithSystemSymbolName_accessibilityDescription(
            &NSString::from_str("doc.text"),
            None,
        ) {
            let icon = NSImageView::imageViewWithImage(&image, mtm);
            icon.setFrame(rect(18.0, 99.0, 24.0, 30.0));
            controls.addSubview(&icon);
        }
        let (note, folder) = destination_text(config, status);
        let destination = label(
            &note,
            rect(54.0, 113.0, 224.0, 21.0),
            14.0,
            &NSColor::labelColor(),
            mtm,
        );
        destination.setFont(Some(&NSFont::boldSystemFontOfSize(14.0)));
        destination.setLineBreakMode(NSLineBreakMode::ByTruncatingMiddle);
        destination.setToolTip(Some(&NSString::from_str(&status.destination)));
        controls.addSubview(&destination);
        let location = label(
            &folder,
            rect(54.0, 95.0, 224.0, 17.0),
            11.0,
            &NSColor::secondaryLabelColor(),
            mtm,
        );
        location.setLineBreakMode(NSLineBreakMode::ByTruncatingMiddle);
        location.setToolTip(Some(&NSString::from_str(&status.destination)));
        controls.addSubview(&location);
        let open = symbol_button(
            "arrow.up.forward.square",
            &config.labels.open_target,
            sel!(openTarget:),
            &target,
            mtm,
        );
        open.setFrame(rect(290.0, 101.0, 28.0, 28.0));
        open.setEnabled(!status.destination.is_empty());
        controls.addSubview(&open);

        let divider = NSBox::initWithFrame(NSBox::alloc(mtm), rect(18.0, 78.0, 300.0, 1.0));
        divider.setBoxType(NSBoxType::Separator);
        controls.addSubview(&divider);
        let state_label = label(
            "",
            rect(18.0, 31.0, 141.0, 22.0),
            13.0,
            &NSColor::labelColor(),
            mtm,
        );
        state_label.setFont(Some(&NSFont::systemFontOfSize(13.0)));
        controls.addSubview(&state_label);
        let primary = unsafe {
            NSButton::buttonWithTitle_target_action(
                &NSString::new(),
                Some(&target),
                Some(sel!(toggle:)),
                mtm,
            )
        };
        primary.setFrame(rect(166.0, 25.0, 152.0, 32.0));
        primary.setBezelStyle(NSBezelStyle::Push);
        primary.setFont(Some(&NSFont::systemFontOfSize(12.0)));
        primary.setKeyEquivalent(&NSString::from_str("\r"));
        controls.addSubview(&primary);
        let controller = NSViewController::new(mtm);
        controller.setView(&content);
        popover.setContentViewController(Some(&controller));
        let result = Self {
            view: popover,
            _target: target,
            state_label,
            destination,
            location,
            primary,
            open,
        };
        result.update(config, status);
        result
    }
    pub fn update(&self, config: &Configuration, status: &Status) {
        let color = match status.status {
            DesktopState::Recording => NSColor::systemRedColor(),
            DesktopState::Unavailable => NSColor::systemOrangeColor(),
            _ => NSColor::controlAccentColor(),
        };
        self.state_label
            .setStringValue(&NSString::from_str(&format!(
                "●  {}",
                status.status.title(&config.labels)
            )));
        self.state_label.setTextColor(Some(&color));
        let (note, folder) = destination_text(config, status);
        self.destination.setStringValue(&NSString::from_str(&note));
        self.location.setStringValue(&NSString::from_str(&folder));
        self.destination
            .setToolTip(Some(&NSString::from_str(&status.destination)));
        self.location
            .setToolTip(Some(&NSString::from_str(&status.destination)));
        let title = status.status.action_label(&config.labels);
        self.primary.setTitle(&NSString::from_str(title));
        self.primary.setEnabled(status.can_toggle());
        self.open.setEnabled(!status.destination.is_empty());
    }
    pub fn is_shown(&self) -> bool {
        self.view.isShown()
    }
    pub fn close(&self) {
        self.view.close();
    }
    pub fn show(&self, tray: &tray_icon::TrayIcon) {
        let mtm = MainThreadMarker::new().unwrap();
        if let Some(item) = tray.ns_status_item()
            && let Some(button) = item.button(mtm)
        {
            self.view.showRelativeToRect_ofView_preferredEdge(
                button.bounds(),
                &button,
                NSRectEdge::MinY,
            );
        }
    }
}

fn symbol_button(
    symbol: &str,
    title: &str,
    action: objc2::runtime::Sel,
    target: &ControlTarget,
    mtm: MainThreadMarker,
) -> Retained<NSButton> {
    let button = unsafe {
        NSButton::buttonWithTitle_target_action(
            &NSString::from_str(title),
            Some(target),
            Some(action),
            mtm,
        )
    };
    if let Some(image) = NSImage::imageWithSystemSymbolName_accessibilityDescription(
        &NSString::from_str(symbol),
        Some(&NSString::from_str(title)),
    ) {
        button.setImage(Some(&image));
        button.setImagePosition(NSCellImagePosition::ImageOnly);
    }
    button.setBordered(false);
    button.setToolTip(Some(&NSString::from_str(title)));
    button.setAccessibilityLabel(Some(&NSString::from_str(title)));
    button
}

// Configuration text alone is not proof that the OS registered a binding.
fn registered_shortcut_hint(shortcut: Option<&HotKey>) -> Option<String> {
    let shortcut = shortcut?;
    let mut hint = String::new();
    for (modifier, glyph) in [
        (Modifiers::CONTROL, '⌃'),
        (Modifiers::ALT, '⌥'),
        (Modifiers::SHIFT, '⇧'),
        (Modifiers::META, '⌘'),
    ] {
        if shortcut.mods.contains(modifier) {
            hint.push(glyph);
        }
    }
    let code = shortcut.key.to_string();
    hint.push_str(match code.as_str() {
        key if key.starts_with("Key") && key.len() == 4 => &key[3..],
        key if key.starts_with("Digit") && key.len() == 6 => &key[5..],
        "ArrowUp" => "↑",
        "ArrowDown" => "↓",
        "ArrowLeft" => "←",
        "ArrowRight" => "→",
        "Escape" => "⎋",
        "Enter" => "↩",
        "Tab" => "⇥",
        "Backspace" => "⌫",
        "Delete" => "⌦",
        other => other,
    });
    Some(hint)
}

fn destination_text(config: &Configuration, status: &Status) -> (String, String) {
    let prefix = format!("{} / ", config.vault_name);
    let path = status
        .destination
        .strip_prefix(&prefix)
        .unwrap_or(&status.destination);
    let (folder, name) = path.rsplit_once('/').unwrap_or(("", path));
    let note = if name.is_empty() {
        "—"
    } else {
        name.strip_suffix(".md").unwrap_or(name)
    };
    let location = if folder.is_empty() {
        config.vault_name.clone()
    } else {
        format!("{} · {}", config.vault_name, folder)
    };
    (note.to_owned(), location)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn registered_shortcut_uses_mac_modifier_glyphs() {
        let key = "Control+Alt+J".parse().unwrap();
        assert_eq!(registered_shortcut_hint(Some(&key)).as_deref(), Some("⌃⌥J"));
    }
    #[test]
    fn registered_command_shift_and_digit_remain_readable() {
        use global_hotkey::hotkey::{Code, HotKey, Modifiers};
        let key = HotKey::new(Some(Modifiers::META | Modifiers::SHIFT), Code::Digit1);
        assert_eq!(registered_shortcut_hint(Some(&key)).as_deref(), Some("⇧⌘1"));
    }
    #[test]
    fn unregistered_or_unset_shortcuts_have_no_hint() {
        assert_eq!(registered_shortcut_hint(None), None);
    }
    fn config() -> Configuration {
        Configuration {
            request_id: "request".into(),
            generation: "generation".into(),
            shortcut: None,
            show_icon: true,
            vault_name: "Work".into(),
            labels: Box::new(DesktopLabels {
                ready: "Ready".into(),
                starting: "Starting".into(),
                recording: "Recording".into(),
                finishing: "Finishing".into(),
                unavailable: "Unavailable".into(),
                start: "Start".into(),
                stop: "Stop".into(),
                cancel_start: "Cancel start".into(),
                open_target: "Open note".into(),
                settings: "Settings".into(),
            }),
        }
    }
    #[test]
    fn destination_avoids_duplicate_vault_and_retains_note() {
        let status = Status {
            generation: "generation".into(),
            status: DesktopState::Ready,
            destination: "Work / Daily/Monday.md".into(),
            can_start: true,
        };
        assert_eq!(
            destination_text(&config(), &status),
            ("Monday".into(), "Work · Daily".into())
        );
    }
    #[test]
    fn state_controls_share_recording_and_finishing_semantics() {
        let config = config();
        for state in [
            DesktopState::Ready,
            DesktopState::Starting,
            DesktopState::Recording,
            DesktopState::Finishing,
            DesktopState::Unavailable,
        ] {
            let status = Status {
                generation: "generation".into(),
                status: state.clone(),
                destination: String::new(),
                can_start: true,
            };
            assert_eq!(
                status.can_toggle(),
                matches!(
                    state,
                    DesktopState::Ready | DesktopState::Starting | DesktopState::Recording
                )
            );
            let expected = match state {
                DesktopState::Starting => "Cancel start",
                DesktopState::Recording => "Stop",
                _ => "Start",
            };
            assert_eq!(state.action_label(&config.labels), expected);
        }
    }
}
