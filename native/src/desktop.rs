//! Native desktop controls. The protocol thread owns inference; this service owns OS UI.
use crate::protocol::Event;
use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions};
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopLabels {
    pub ready: String,
    pub starting: String,
    pub recording: String,
    pub finishing: String,
    pub unavailable: String,
    pub start: String,
    pub stop: String,
    pub cancel_start: String,
    pub open_target: String,
    pub settings: String,
}
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DesktopState {
    Ready,
    Starting,
    Recording,
    Finishing,
    Unavailable,
}
#[derive(Clone, Debug)]
pub struct Configuration {
    pub request_id: String,
    pub generation: String,
    pub shortcut: Option<String>,
    pub show_icon: bool,
    pub vault_name: String,
    pub labels: Box<DesktopLabels>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Status {
    pub generation: String,
    pub status: DesktopState,
    pub destination: String,
    pub can_start: bool,
}
#[derive(Clone, Debug)]
pub enum Message {
    Configure(Configuration),
    Status(Status),
    Quit,
}
pub type EventSink = Arc<dyn Fn(Event) + Send + Sync>;

#[derive(Clone)]
pub struct Actions {
    generation: String,
    next: Arc<AtomicU64>,
    sink: EventSink,
}
impl Actions {
    fn emit(&self, action: &str) {
        (self.sink)(Event::DesktopAction {
            generation: self.generation.clone(),
            action_id: self.next.fetch_add(1, Ordering::Relaxed),
            action: action.to_string(),
        });
    }
}
fn ownership_lock() -> anyhow::Result<File> {
    let directory = directories::BaseDirs::new()
        .ok_or_else(|| anyhow::anyhow!("No user data directory"))?
        .data_local_dir()
        .join("speech-kit");
    std::fs::create_dir_all(&directory)?;
    lock_file(&directory.join("desktop-controls.lock"))
}
fn lock_file(path: &std::path::Path) -> anyhow::Result<File> {
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)?;
    file.try_lock()?;
    Ok(file)
}
impl DesktopState {
    fn title<'a>(&self, labels: &'a DesktopLabels) -> &'a str {
        match self {
            Self::Ready => &labels.ready,
            Self::Starting => &labels.starting,
            Self::Recording => &labels.recording,
            Self::Finishing => &labels.finishing,
            Self::Unavailable => &labels.unavailable,
        }
    }
}
#[cfg(target_os = "linux")]
mod linux;
#[cfg(any(target_os = "macos", target_os = "windows"))]
mod native;
#[cfg(target_os = "linux")]
pub use linux::run;
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub use native::run;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actions_retain_generation_and_unique_sequence() {
        let events = Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured = events.clone();
        let actions = Actions {
            generation: "connection-2".into(),
            next: Arc::new(AtomicU64::new(1)),
            sink: Arc::new(move |e| captured.lock().unwrap().push(e)),
        };
        actions.emit("toggle");
        actions.emit("open_target");
        let events = events.lock().unwrap();
        assert!(
            matches!(&events[0],Event::DesktopAction{generation,action_id:1,..} if generation=="connection-2")
        );
        assert!(matches!(
            &events[1],
            Event::DesktopAction { action_id: 2, .. }
        ));
    }
    #[test]
    fn ownership_is_exclusive_until_release() {
        let path =
            std::env::temp_dir().join(format!("speech-kit-lock-test-{}", uuid::Uuid::new_v4()));
        let first = lock_file(&path).unwrap();
        assert!(lock_file(&path).is_err());
        drop(first);
        assert!(lock_file(&path).is_ok());
        std::fs::remove_file(path).unwrap();
    }
}

#[cfg(target_os = "macos")]
mod popover;

impl Status {
    fn can_toggle(&self) -> bool {
        matches!(
            self.status,
            DesktopState::Starting | DesktopState::Recording
        ) || matches!(self.status, DesktopState::Ready) && self.can_start
    }
}
impl DesktopState {
    fn action_label<'a>(&self, labels: &'a DesktopLabels) -> &'a str {
        match self {
            Self::Starting => &labels.cancel_start,
            Self::Recording => &labels.stop,
            _ => &labels.start,
        }
    }
}
