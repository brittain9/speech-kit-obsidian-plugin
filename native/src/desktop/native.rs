use super::*;
use global_hotkey::{GlobalHotKeyEvent, GlobalHotKeyManager, HotKeyState, hotkey::HotKey};
use tray_icon::{
    Icon, TrayIcon, TrayIconBuilder,
    menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem},
};
use winit::{
    application::ApplicationHandler,
    event::WindowEvent,
    event_loop::{ActiveEventLoop, EventLoop},
    window::WindowId,
};

#[derive(Debug)]
enum UiEvent {
    Message(Message),
    Hotkey(String, u32, bool),
    Menu(String),
    #[cfg(target_os = "macos")]
    Popover(String),
}
struct Ui {
    sink: EventSink,
    manager: Option<GlobalHotKeyManager>,
    shortcut: Option<HotKey>,
    tray: Option<TrayIcon>,
    lock: Option<File>,
    config: Option<Configuration>,
    status: Option<Status>,
    actions: Option<Actions>,
    held: bool,
    #[cfg(target_os = "macos")]
    popover: Option<super::popover::Popover>,
    routing: Arc<std::sync::Mutex<Option<(String, u32)>>>,
}
impl Ui {
    fn configure(&mut self, config: Configuration) {
        #[cfg(target_os = "macos")]
        {
            if let Some(popover) = self.popover.take() {
                popover.close();
            }
        }
        self.tray = None;
        if let (Some(manager), Some(key)) = (&self.manager, self.shortcut.take()) {
            let _ = manager.unregister(key);
        }
        self.actions = None;
        *self.routing.lock().unwrap() = None;
        self.held = false;
        let enabled = config.show_icon || config.shortcut.is_some();
        if !enabled {
            self.lock = None;
        }
        let owner = !enabled
            || self.lock.is_some()
            || match ownership_lock() {
                Ok(lock) => {
                    self.lock = Some(lock);
                    true
                }
                Err(_) => false,
            };
        let mut shortcut_status = if config.shortcut.is_some() {
            "unavailable"
        } else {
            "disabled"
        };
        let mut error = None;
        if owner && enabled {
            self.actions = Some(Actions {
                generation: config.generation.clone(),
                next: Arc::new(AtomicU64::new(1)),
                sink: self.sink.clone(),
            });
            if let Some(value) = &config.shortcut {
                let result = (|| -> anyhow::Result<HotKey> {
                    let key = value.parse::<HotKey>()?;
                    if self.manager.is_none() {
                        self.manager = Some(GlobalHotKeyManager::new()?);
                    }
                    self.manager.as_ref().unwrap().register(key)?;
                    Ok(key)
                })();
                match result {
                    Ok(key) => {
                        self.shortcut = Some(key);
                        shortcut_status = "registered"
                    }
                    Err(e) => error = Some(e.to_string()),
                }
            }
        } else if !owner {
            shortcut_status = "conflict";
            error = Some("Desktop controls belong to another open vault".into());
        }
        if let Some(key) = self.shortcut {
            *self.routing.lock().unwrap() = Some((config.generation.clone(), key.id()));
        }
        self.status = Some(Status {
            generation: config.generation.clone(),
            status: DesktopState::Unavailable,
            destination: String::new(),
            can_start: false,
        });
        self.config = Some(config.clone());
        if owner
            && config.show_icon
            && let Err(e) = self.rebuild_menu()
        {
            error = Some(e.to_string());
        }
        (self.sink)(Event::DesktopStatus {
            request_id: Some(config.request_id),
            generation: config.generation,
            shortcut_status: shortcut_status.into(),
            effective_shortcut: if self.shortcut.is_some() {
                config.shortcut
            } else {
                None
            },
            icon_available: self.tray.is_some(),
            owner,
            error,
        });
    }
    fn rebuild_menu(&mut self) -> anyhow::Result<()> {
        let config = self.config.as_ref().unwrap();
        let state = self.status.as_ref().unwrap();
        let menu = Menu::new();
        let title = MenuItem::new(format!("Speech Kit · {}", config.vault_name), false, None);
        let destination = MenuItem::new(
            format!(
                "{} → {}",
                state.status.title(&config.labels),
                state.destination
            ),
            false,
            None,
        );
        let text = state.status.action_label(&config.labels);
        let enabled = state.can_toggle();
        let toggle =
            MenuItem::with_id(format!("{}:toggle", config.generation), text, enabled, None);
        let open = MenuItem::with_id(
            format!("{}:open_target", config.generation),
            &config.labels.open_target,
            !state.destination.is_empty(),
            None,
        );
        let settings = MenuItem::with_id(
            format!("{}:open_settings", config.generation),
            &config.labels.settings,
            true,
            None,
        );
        menu.append_items(&[
            &title,
            &destination,
            &toggle,
            &open,
            &PredefinedMenuItem::separator(),
            &settings,
        ])?;
        let icon = status_icon(&state.status)?;
        if let Some(tray) = &self.tray {
            tray.set_menu(Some(Box::new(menu)));
            #[cfg(target_os = "macos")]
            tray.set_icon_templated(Some(icon))?;
            #[cfg(target_os = "windows")]
            tray.set_icon(Some(icon))?;
            tray.set_tooltip(Some(state.status.title(&config.labels)))?;
        } else {
            let builder = TrayIconBuilder::new()
                .with_id(config.generation.clone())
                .with_menu(Box::new(menu))
                .with_tooltip("Speech Kit");
            #[cfg(target_os = "macos")]
            let builder = builder
                .with_icon_templated(icon)
                .with_menu_on_left_click(false);
            #[cfg(target_os = "windows")]
            let builder = builder.with_icon(icon);
            self.tray = Some(builder.build()?);
        }
        #[cfg(target_os = "macos")]
        if let Some(actions) = &self.actions {
            if let Some(popover) = &self.popover {
                popover.update(config, state);
            } else {
                self.popover = Some(super::popover::Popover::new(config, state, actions.clone()));
            }
        }
        Ok(())
    }
}
// Render at 3x logical size with analytical supersampling for crisp menu-bar/tray scaling.
fn status_pixels(state: &DesktopState) -> Vec<u8> {
    let mut pixels = vec![0; 64 * 64 * 4];
    for y in 0..64 {
        for x in 0..64 {
            let mut coverage = 0;
            for sy in 0..4 {
                for sx in 0..4 {
                    let px = (x as f64 + (sx as f64 + 0.5) / 4.0) * 24.0 / 64.0 - 12.0;
                    let py = (y as f64 + (sy as f64 + 0.5) / 4.0) * 24.0 / 64.0 - 12.0;
                    let capsule = px.abs() <= 2.65 && (-7.0..=0.5).contains(&py)
                        || px * px + (py + 7.0).powi(2) <= 2.65f64.powi(2) && py < -7.0
                        || px * px + (py - 0.5).powi(2) <= 2.65f64.powi(2) && py > 0.5;
                    let radius = (px * px + (py - 0.5).powi(2)).sqrt();
                    let cradle = (4.35..=5.7).contains(&radius) && py >= 0.5
                        || (4.35..=5.7).contains(&px.abs()) && (-0.6..0.5).contains(&py);
                    let stand = px.abs() < 0.75 && (5.5..=8.6).contains(&py)
                        || px.abs() < 3.1 && (8.0..=9.35).contains(&py);
                    let bx = px - 6.5;
                    let by = py - 6.5;
                    let badge_disk = bx * bx + by * by < 3.5 * 3.5;
                    let badge = match state {
                        DesktopState::Ready => false,
                        DesktopState::Recording => bx * bx + by * by < 2.55 * 2.55,
                        DesktopState::Starting => {
                            (bx.abs() < 0.45 || (bx.abs() - 1.7).abs() < 0.45) && by.abs() < 0.65
                        }
                        DesktopState::Finishing => {
                            (bx.abs() < 1.8 && by.abs() > 1.6 && by.abs() < 2.2)
                                || ((bx.abs() - by.abs()).abs() < 0.65 && by.abs() < 1.8)
                        }
                        DesktopState::Unavailable => {
                            (bx - by).abs() < 0.65 && bx.abs() < 1.9 && by.abs() < 1.9
                                || (bx + by).abs() < 0.65 && bx.abs() < 1.9 && by.abs() < 1.9
                        }
                    };
                    let glyph = capsule || cradle || stand;
                    if if matches!(state, DesktopState::Ready) {
                        glyph
                    } else {
                        glyph && !badge_disk || badge
                    } {
                        coverage += 1;
                    }
                }
            }
            let i = (y * 64 + x) * 4;
            pixels[i..i + 4].copy_from_slice(&[110, 139, 177, (coverage * 255 / 16) as u8]);
        }
    }
    pixels
}
fn status_icon(state: &DesktopState) -> anyhow::Result<Icon> {
    Ok(Icon::from_rgba(status_pixels(state), 64, 64)?)
}
#[cfg(test)]
mod icon_tests {
    use super::*;
    #[test]
    fn microphone_states_are_distinct_and_antialiased() {
        let ready = status_pixels(&DesktopState::Ready);
        assert!(
            ready
                .chunks_exact(4)
                .any(|pixel| pixel[3] > 0 && pixel[3] < 255)
        );
        let states = [
            DesktopState::Ready,
            DesktopState::Starting,
            DesktopState::Recording,
            DesktopState::Finishing,
            DesktopState::Unavailable,
        ];
        for (index, state) in states.iter().enumerate() {
            for other in &states[index + 1..] {
                assert_ne!(status_pixels(state), status_pixels(other));
            }
        }
    }
}
impl ApplicationHandler<UiEvent> for Ui {
    fn resumed(&mut self, _: &ActiveEventLoop) {}
    fn window_event(&mut self, _: &ActiveEventLoop, _: WindowId, _: WindowEvent) {}
    fn user_event(&mut self, event_loop: &ActiveEventLoop, event: UiEvent) {
        match event {
            UiEvent::Message(Message::Quit) => {
                #[cfg(target_os = "macos")]
                if let Some(popover) = &self.popover {
                    popover.close();
                }
                event_loop.exit();
            }
            UiEvent::Message(Message::Configure(config)) => self.configure(config),
            UiEvent::Message(Message::Status(status)) => {
                if self
                    .config
                    .as_ref()
                    .is_some_and(|c| c.generation == status.generation)
                {
                    if self.status.as_ref() == Some(&status) {
                        return;
                    }
                    self.status = Some(status);
                    if self.tray.is_some() {
                        let _ = self.rebuild_menu();
                    }
                }
            }
            UiEvent::Hotkey(generation, id, pressed) => {
                if self
                    .config
                    .as_ref()
                    .is_none_or(|c| c.generation != generation)
                {
                    return;
                }
                if self.shortcut.is_none_or(|key| key.id() != id) {
                    return;
                }
                if pressed
                    && !self.held
                    && let Some(actions) = &self.actions
                {
                    actions.emit("toggle");
                }
                self.held = pressed;
            }
            #[cfg(target_os = "macos")]
            UiEvent::Popover(id) => {
                if let Some(tray) = &self.tray
                    && tray.id().0 == id
                    && let Some(popover) = &self.popover
                {
                    if popover.is_shown() {
                        popover.close();
                    } else {
                        popover.show(tray);
                    }
                }
            }
            UiEvent::Menu(value) => {
                if let Some(actions) = &self.actions
                    && let Some((generation, action)) = value.rsplit_once(':')
                    && generation == actions.generation
                {
                    actions.emit(action);
                }
            }
        }
    }
}
pub fn run(receiver: std::sync::mpsc::Receiver<Message>, sink: EventSink) -> anyhow::Result<()> {
    let first = loop {
        match receiver.recv() {
            Ok(Message::Quit) | Err(_) => return Ok(()),
            Ok(Message::Configure(config)) if config.show_icon || config.shortcut.is_some() => {
                break config;
            }
            Ok(Message::Configure(config)) => (sink)(Event::DesktopStatus {
                request_id: Some(config.request_id),
                generation: config.generation,
                shortcut_status: "disabled".into(),
                effective_shortcut: None,
                icon_available: false,
                owner: true,
                error: None,
            }),
            _ => {}
        }
    };
    let mut builder = EventLoop::<UiEvent>::with_user_event();
    #[cfg(target_os = "macos")]
    {
        use winit::platform::macos::{ActivationPolicy, EventLoopBuilderExtMacOS};
        builder
            .with_activation_policy(ActivationPolicy::Accessory)
            .with_activate_ignoring_other_apps(false);
    }
    let event_loop = match builder.build() {
        Ok(event_loop) => event_loop,
        Err(error) => {
            let mut config = first;
            loop {
                (sink)(Event::DesktopStatus {
                    request_id: Some(config.request_id),
                    generation: config.generation,
                    shortcut_status: if config.shortcut.is_some() {
                        "unavailable"
                    } else {
                        "disabled"
                    }
                    .into(),
                    effective_shortcut: None,
                    icon_available: false,
                    owner: false,
                    error: Some(format!("Desktop UI unavailable: {error}")),
                });
                loop {
                    match receiver.recv() {
                        Ok(Message::Configure(next)) => {
                            config = next;
                            break;
                        }
                        Ok(Message::Quit) | Err(_) => return Ok(()),
                        _ => {}
                    }
                }
            }
        }
    };
    let proxy = event_loop.create_proxy();
    let hotkey_proxy = proxy.clone();
    let menu_proxy = proxy.clone();
    #[cfg(target_os = "macos")]
    {
        let popover_proxy = proxy.clone();
        tray_icon::TrayIconEvent::set_event_handler(Some(move |event| {
            if let tray_icon::TrayIconEvent::Click {
                id,
                button: tray_icon::MouseButton::Left,
                button_state: tray_icon::MouseButtonState::Up,
                ..
            } = event
            {
                let _ = popover_proxy.send_event(UiEvent::Popover(id.0));
            }
        }));
    }
    let routing = Arc::new(std::sync::Mutex::new(None::<(String, u32)>));
    let hotkey_routing = routing.clone();
    GlobalHotKeyEvent::set_event_handler(Some(move |event: GlobalHotKeyEvent| {
        if let Some((generation, id)) = &*hotkey_routing.lock().unwrap()
            && *id == event.id
        {
            let _ = hotkey_proxy.send_event(UiEvent::Hotkey(
                generation.clone(),
                event.id,
                event.state == HotKeyState::Pressed,
            ));
        }
    }));
    MenuEvent::set_event_handler(Some(move |event: MenuEvent| {
        let _ = menu_proxy.send_event(UiEvent::Menu(event.id.0));
    }));
    proxy.send_event(UiEvent::Message(Message::Configure(first)))?;
    std::thread::spawn(move || {
        while let Ok(message) = receiver.recv() {
            if proxy.send_event(UiEvent::Message(message)).is_err() {
                break;
            }
        }
    });
    event_loop.run_app(&mut Ui {
        sink,
        manager: None,
        shortcut: None,
        tray: None,
        lock: None,
        config: None,
        status: None,
        actions: None,
        held: false,
        #[cfg(target_os = "macos")]
        popover: None,
        routing,
    })?;
    Ok(())
}
