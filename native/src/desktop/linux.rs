use super::*;
use ashpd::desktop::global_shortcuts::{GlobalShortcuts, NewShortcut};
use futures_util::StreamExt;
use ksni::TrayMethods;
use std::sync::Mutex;

#[derive(Clone)]
struct Tray {
    config: Configuration,
    status: Status,
    actions: Actions,
    report: Arc<Mutex<Event>>,
    sink: EventSink,
}
impl Tray {
    fn availability(&self, available: bool) {
        let mut event = self.report.lock().unwrap();
        if let Event::DesktopStatus { icon_available, .. } = &mut *event {
            *icon_available = available;
        }
        (self.sink)(event.clone());
    }
}
impl ksni::Tray for Tray {
    fn id(&self) -> String {
        "org.speechkit.Desktop".into()
    }
    fn title(&self) -> String {
        format!("Speech Kit · {}", self.config.vault_name)
    }
    fn icon_pixmap(&self) -> Vec<ksni::Icon> {
        vec![ksni::Icon {
            width: super::glyph::SIZE as i32,
            height: super::glyph::SIZE as i32,
            data: super::glyph::argb(&self.status.status),
        }]
    }
    fn watcher_online(&self) {
        self.availability(true);
    }
    fn watcher_offline(&self, _: ksni::OfflineReason) -> bool {
        self.availability(false);
        true
    }
    fn menu(&self) -> Vec<ksni::MenuItem<Self>> {
        use ksni::menu::StandardItem;
        let label = self.status.status.action_label(&self.config.labels);
        vec![
            StandardItem {
                label: format!(
                    "{} → {}",
                    self.status.status.title(&self.config.labels),
                    self.status.destination
                ),
                enabled: false,
                ..Default::default()
            }
            .into(),
            StandardItem {
                label: label.to_string(),
                enabled: self.status.can_toggle(),
                activate: Box::new(|tray: &mut Self| tray.actions.emit("toggle")),
                ..Default::default()
            }
            .into(),
            StandardItem {
                label: self.config.labels.open_target.clone(),
                enabled: !self.status.destination.is_empty(),
                activate: Box::new(|tray: &mut Self| tray.actions.emit("open_target")),
                ..Default::default()
            }
            .into(),
            ksni::MenuItem::Separator,
            StandardItem {
                label: self.config.labels.settings.clone(),
                activate: Box::new(|tray: &mut Self| tray.actions.emit("open_settings")),
                ..Default::default()
            }
            .into(),
        ]
    }
}
fn report_shortcut(
    report: &Arc<Mutex<Event>>,
    sink: &EventSink,
    state: &str,
    effective: Option<String>,
    error: Option<String>,
) {
    let mut event = report.lock().unwrap();
    if let Event::DesktopStatus {
        shortcut_status,
        effective_shortcut,
        error: current,
        ..
    } = &mut *event
    {
        *shortcut_status = state.into();
        *effective_shortcut = effective;
        *current = error;
    }
    (sink)(event.clone());
}
async fn portal(
    shortcut: String,
    actions: Actions,
    report: Arc<Mutex<Event>>,
    sink: EventSink,
    mut stop: tokio::sync::oneshot::Receiver<()>,
) {
    let mut cleanup = None;
    let result = {
        let work = async {
            let applications = directories::BaseDirs::new()
                .ok_or_else(|| anyhow::anyhow!("No user data directory"))?
                .data_dir()
                .join("applications");
            std::fs::create_dir_all(&applications)?;
            let identity = applications.join("org.speechkit.Desktop.desktop");
            if !identity.exists() {
                std::fs::write(
                    identity,
                    "[Desktop Entry]\nType=Application\nName=Speech Kit Desktop Controls\nExec=obsidian\nNoDisplay=true\n",
                )?;
            }
            let connection = ashpd::zbus::Connection::session().await?;
            let registry = ashpd::zbus::Proxy::new(
                &connection,
                "org.freedesktop.portal.Desktop",
                "/org/freedesktop/portal/desktop",
                "org.freedesktop.host.portal.Registry",
            )
            .await?;
            let _: () = registry
                .call(
                    "Register",
                    &(
                        "org.speechkit.Desktop",
                        std::collections::HashMap::<String, ashpd::wire::OwnedVariant>::new(),
                    ),
                )
                .await?;
            let portal = GlobalShortcuts::with_connection(connection).await?;
            cleanup = Some(portal.create_session(Default::default()).await?);
            let session = cleanup.as_ref().unwrap();
            {
                let mut active = portal.receive_activated().await?;
                let mut inactive = portal.receive_deactivated().await?;
                let mut changed = portal.receive_shortcuts_changed().await?;
                let mut closed = session.receive_closed().await?;
                let bound = portal
                    .bind_shortcuts(
                        session,
                        &[
                            NewShortcut::new("dictation", "Speech Kit: toggle dictation")
                                .preferred_trigger(Some(portal_trigger(&shortcut).as_str())),
                        ],
                        None,
                        Default::default(),
                    )
                    .await?
                    .response()?;
                let effective = bound
                    .shortcuts()
                    .iter()
                    .find(|s| s.id() == "dictation")
                    .map(|s| s.trigger_description().to_string())
                    .ok_or_else(|| anyhow::anyhow!("No dictation shortcut was approved"))?;
                report_shortcut(&report, &sink, "registered", Some(effective), None);
                let mut held = false;
                loop {
                    tokio::select! {
                        Some(event)=active.next()=>{if event.shortcut_id()=="dictation"&&!held{held=true;actions.emit("toggle");}},
                        Some(_)=inactive.next()=>held=false,
                        Some(event)=changed.next()=>{let effective=event.shortcuts().iter().find(|s|s.id()=="dictation").map(|s|s.trigger_description().to_string());let state=if effective.is_some(){"registered"}else{"unavailable"};report_shortcut(&report,&sink,state,effective,None);},
                        _=closed.next()=>return Err(anyhow::anyhow!("Desktop shortcut session closed")),
                    }
                }
            };
        };
        tokio::select! { result=work=>result, _=&mut stop=>Ok(()) }
    };
    if let Some(session) = cleanup {
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), session.close()).await;
    }
    if let Err(error) = result {
        report_shortcut(&report, &sink, "unavailable", None, Some(error.to_string()));
    }
}
pub fn run(receiver: std::sync::mpsc::Receiver<Message>, sink: EventSink) -> anyhow::Result<()> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    std::thread::spawn(move || {
        while let Ok(message) = receiver.recv() {
            if tx.send(message).is_err() {
                break;
            }
        }
    });
    runtime.block_on(async {
        let mut lock = None;
        let mut tray: Option<ksni::Handle<Tray>> = None;
        let mut cancellation: Option<tokio::sync::oneshot::Sender<()>> = None;
        let mut portal_task: Option<tokio::task::JoinHandle<()>> = None;
        while let Some(message) = rx.recv().await {
            match message {
                Message::Quit => break,
                Message::Status(status) => {
                    if let Some(tray) = &tray {
                        tray.update(move |tray| {
                            if tray.config.generation == status.generation {
                                tray.status = status;
                            }
                        })
                        .await;
                    }
                }
                Message::Configure(config) => {
                    if let Some(stop) = cancellation.take() {
                        let _ = stop.send(());
                    }
                    if let Some(task) = portal_task.take() {
                        let _ = task.await;
                    }
                    if let Some(old) = tray.take() {
                        old.shutdown().await;
                    }
                    let enabled = config.show_icon || config.shortcut.is_some();
                    if !enabled {
                        lock = None;
                    }
                    let owner = !enabled
                        || lock.is_some()
                        || match ownership_lock() {
                            Ok(acquired) => {
                                lock = Some(acquired);
                                true
                            }
                            Err(_) => false,
                        };
                    let report = Arc::new(Mutex::new(Event::DesktopStatus {
                        request_id: Some(config.request_id.clone()),
                        generation: config.generation.clone(),
                        shortcut_status: if !owner {
                            "conflict"
                        } else if config.shortcut.is_some() {
                            "unavailable"
                        } else {
                            "disabled"
                        }
                        .into(),
                        effective_shortcut: None,
                        icon_available: false,
                        owner,
                        error: if !owner {
                            Some("Desktop controls belong to another open vault".into())
                        } else {
                            None
                        },
                    }));
                    let actions = Actions {
                        generation: config.generation.clone(),
                        next: Arc::new(AtomicU64::new(1)),
                        sink: sink.clone(),
                    };
                    if owner && config.show_icon {
                        let item = Tray {
                            status: Status {
                                generation: config.generation.clone(),
                                status: DesktopState::Unavailable,
                                destination: String::new(),
                                can_start: false,
                            },
                            config: config.clone(),
                            actions: actions.clone(),
                            report: report.clone(),
                            sink: sink.clone(),
                        };
                        match item.spawn().await {
                            Ok(handle) => {
                                if let Event::DesktopStatus { icon_available, .. } =
                                    &mut *report.lock().unwrap()
                                {
                                    *icon_available = true;
                                }
                                tray = Some(handle);
                            }
                            Err(error) => {
                                if let Event::DesktopStatus { error: current, .. } =
                                    &mut *report.lock().unwrap()
                                {
                                    *current = Some(error.to_string());
                                }
                            }
                        }
                    }
                    (sink)(report.lock().unwrap().clone());
                    if owner && let Some(shortcut) = config.shortcut {
                        let (stop, receive) = tokio::sync::oneshot::channel();
                        cancellation = Some(stop);
                        portal_task = Some(tokio::spawn(portal(
                            shortcut,
                            actions,
                            report,
                            sink.clone(),
                            receive,
                        )));
                    }
                }
            }
        }
        if let Some(stop) = cancellation {
            let _ = stop.send(());
        }
        if let Some(task) = portal_task {
            let _ = task.await;
        }
        if let Some(tray) = tray {
            tray.shutdown().await;
        }
        drop(lock);
    });
    Ok(())
}

fn portal_trigger(value: &str) -> String {
    value
        .split('+')
        .map(|part| match part.trim().to_ascii_lowercase().as_str() {
            "commandorcontrol" | "cmdorctrl" | "control" | "ctrl" => "CTRL".into(),
            "shift" => "SHIFT".into(),
            "alt" => "ALT".into(),
            "super" | "meta" => "LOGO".into(),
            _ => part.trim().to_string(),
        })
        .collect::<Vec<_>>()
        .join("+")
}
