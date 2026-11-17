//! Native macOS controls, shown only after an explicit status-item click.
use super::*;
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
    pill: Retained<NSBox>,
    destination: Retained<NSTextField>,
    primary: Retained<NSButton>,
    open: Retained<NSButton>,
    // Last: target must outlive all retained controls with unretained target/action links.
    _target: Retained<ControlTarget>,
}
impl Popover {
    pub fn new(config: &Configuration, status: &Status, actions: Actions) -> Self {
        let mtm = MainThreadMarker::new().expect("Popover belongs to main UI thread");
        let popover = NSPopover::new(mtm);
        popover.setBehavior(NSPopoverBehavior::Transient);
        popover.setAnimates(false);
        popover.setContentSize(NSSize::new(340.0, 252.0));
        let target = ControlTarget::alloc(mtm).set_ivars(TargetState {
            actions,
            popover: popover.clone(),
        });
        // SAFETY: NSObject initialization and target/action selectors are defined above; retained target outlives every button.
        let target: Retained<ControlTarget> = unsafe { msg_send![super(target), init] };
        let content = NSVisualEffectView::initWithFrame(
            NSVisualEffectView::alloc(mtm),
            rect(0.0, 0.0, 340.0, 252.0),
        );
        content.setMaterial(NSVisualEffectMaterial::Popover);
        content.setBlendingMode(NSVisualEffectBlendingMode::WithinWindow);
        content.setState(NSVisualEffectState::Active);
        let title = label(
            "Speech Kit",
            rect(48.0, 210.0, 270.0, 24.0),
            17.0,
            &NSColor::labelColor(),
            mtm,
        );
        title.setFont(Some(&NSFont::boldSystemFontOfSize(17.0)));
        content.addSubview(&title);
        if let Some(image) = NSImage::imageWithSystemSymbolName_accessibilityDescription(
            &NSString::from_str("mic.fill"),
            Some(&NSString::from_str("Speech Kit")),
        ) {
            let icon = NSImageView::imageViewWithImage(&image, mtm);
            icon.setFrame(rect(20.0, 210.0, 20.0, 23.0));
            content.addSubview(&icon);
        }
        let state_title = status.status.title(&config.labels);
        let pill = NSBox::initWithFrame(NSBox::alloc(mtm), rect(20.0, 173.0, 300.0, 26.0));
        pill.setBoxType(NSBoxType::Custom);
        pill.setTitlePosition(NSTitlePosition::NoTitle);
        pill.setCornerRadius(8.0);
        pill.setBorderWidth(0.0);
        let color = match status.status {
            DesktopState::Recording => NSColor::systemRedColor(),
            DesktopState::Unavailable => NSColor::systemOrangeColor(),
            _ => NSColor::controlAccentColor(),
        };
        pill.setFillColor(&color.colorWithAlphaComponent(0.10));
        content.addSubview(&pill);
        let state_label = label(
            &format!("●  {state_title}"),
            rect(30.0, 178.0, 280.0, 16.0),
            11.0,
            &color,
            mtm,
        );
        state_label.setFont(Some(&NSFont::boldSystemFontOfSize(11.0)));
        content.addSubview(&state_label);
        let destination = label(
            &destination_text(config, status),
            rect(20.0, 115.0, 300.0, 44.0),
            12.0,
            &NSColor::secondaryLabelColor(),
            mtm,
        );
        destination.setMaximumNumberOfLines(2);
        destination.setLineBreakMode(NSLineBreakMode::ByTruncatingMiddle);
        content.addSubview(&destination);
        let action_title = status.status.action_label(&config.labels);
        let primary = unsafe {
            NSButton::buttonWithTitle_target_action(
                &NSString::from_str(action_title),
                Some(&target),
                Some(sel!(toggle:)),
                mtm,
            )
        };
        primary.setFrame(rect(20.0, 62.0, 300.0, 36.0));
        primary.setBezelStyle(NSBezelStyle::Push);
        primary.setFont(Some(&NSFont::boldSystemFontOfSize(13.0)));
        primary.setBezelColor(Some(&NSColor::controlAccentColor()));
        primary.setContentTintColor(Some(&NSColor::whiteColor()));
        primary.setKeyEquivalent(&NSString::from_str("\r"));
        primary.setEnabled(status.can_toggle());
        content.addSubview(&primary);
        let open = unsafe {
            NSButton::buttonWithTitle_target_action(
                &NSString::from_str(&config.labels.open_target),
                Some(&target),
                Some(sel!(openTarget:)),
                mtm,
            )
        };
        open.setFrame(rect(20.0, 18.0, 190.0, 28.0));
        open.setBezelStyle(NSBezelStyle::AccessoryBar);
        open.setEnabled(!status.destination.is_empty());
        content.addSubview(&open);
        let settings = unsafe {
            NSButton::buttonWithTitle_target_action(
                &NSString::from_str(&config.labels.settings),
                Some(&target),
                Some(sel!(openSettings:)),
                mtm,
            )
        };
        settings.setFrame(rect(220.0, 18.0, 100.0, 28.0));
        settings.setBezelStyle(NSBezelStyle::AccessoryBar);
        content.addSubview(&settings);
        let controller = NSViewController::new(mtm);
        controller.setView(&content);
        popover.setContentViewController(Some(&controller));
        Self {
            view: popover,
            _target: target,
            state_label,
            pill,
            destination,
            primary,
            open,
        }
    }
    pub fn update(&self, config: &Configuration, status: &Status) {
        let color = match status.status {
            DesktopState::Recording => NSColor::systemRedColor(),
            DesktopState::Unavailable => NSColor::systemOrangeColor(),
            _ => NSColor::controlAccentColor(),
        };
        self.pill.setFillColor(&color.colorWithAlphaComponent(0.10));
        self.state_label
            .setStringValue(&NSString::from_str(&format!(
                "●  {}",
                status.status.title(&config.labels)
            )));
        self.state_label.setTextColor(Some(&color));
        self.destination
            .setStringValue(&NSString::from_str(&destination_text(config, status)));
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

fn destination_text(config: &Configuration, status: &Status) -> String {
    let prefix = format!("{} / ", config.vault_name);
    let path = status
        .destination
        .strip_prefix(&prefix)
        .unwrap_or(&status.destination);
    format!("{}\n{}", config.vault_name, path)
}

#[cfg(test)]
mod tests {
    use super::*;
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
            destination: "Work / Daily / Monday.md".into(),
            can_start: true,
        };
        assert_eq!(
            destination_text(&config(), &status),
            "Work\nDaily / Monday.md"
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
