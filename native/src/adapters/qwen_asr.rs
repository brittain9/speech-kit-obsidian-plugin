//! Qwen ASR process boundary: llama.cpp stays out of the Whisper executable.
use std::fs::File;
use std::io::{BufReader, BufWriter, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::LazyLock;
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::asr_helper_protocol::{
    AsrCommand, AsrEvent, MAX_AUDIO_SAMPLES, PROTOCOL_VERSION, language_name, read_frame,
    write_frame,
};
use crate::engine::capabilities::{
    LanguageSupport, ModelFamilyCapabilities, ModelFamilyId, ModelTask, RuntimeId,
};
use crate::engine::traits::{LoadedModel, ModelFamilyAdapter};
use crate::protocol::{TimestampGranularity, TimestampSource, TranscriptSegment};
use crate::transcription::{EngineTranscriptOutput, GpuConfig, TranscriptionError};

const POLL: Duration = Duration::from_millis(10);
const LOAD_TIMEOUT: Duration = Duration::from_secs(60);
const DECODE_TIMEOUT: Duration = Duration::from_secs(120);
static CAPABILITIES: LazyLock<ModelFamilyCapabilities> =
    LazyLock::new(|| ModelFamilyCapabilities {
        task: ModelTask::Stt,
        supports_hardware_acceleration: cfg!(any(feature = "gpu-metal", feature = "gpu-cuda")),
        available_voices: Vec::new(),
        supports_speed_control: false,
        output_sample_rate: None,
        supports_segment_timestamps: false,
        supports_word_timestamps: false,
        supports_initial_prompt: false,
        supports_streaming: false,
        supports_language_selection: true,
        supports_automatic_language_detection: true,
        supported_languages: LanguageSupport::List {
            tags: ["en", "es", "de", "fr", "pt", "it", "nl", "ja"]
                .into_iter()
                .map(str::to_owned)
                .collect(),
        },
        max_audio_duration_secs: Some(35.0),
        produces_punctuation: true,
    });

#[derive(Default)]
pub struct QwenAsrAdapter {
    helper_executable: Option<PathBuf>,
}
impl QwenAsrAdapter {
    /// Explicit dependency injection for native integration tests. Production
    /// registration uses Default and resolves only the exact packaged sibling.
    pub fn with_helper_executable(path: PathBuf) -> Self {
        Self {
            helper_executable: Some(path),
        }
    }
    fn helper_path(&self) -> Result<PathBuf, TranscriptionError> {
        if let Some(path) = &self.helper_executable {
            return Ok(path.clone());
        }
        let executable = std::env::current_exe()
            .map_err(|_| failure("Cannot locate the sidecar executable."))?;
        Ok(executable
            .parent()
            .ok_or_else(|| failure("Sidecar executable directory is unavailable."))?
            .join(if cfg!(windows) {
                "local-dictation-asr-helper.exe"
            } else {
                "local-dictation-asr-helper"
            }))
    }
}
impl ModelFamilyAdapter for QwenAsrAdapter {
    fn runtime_id(&self) -> RuntimeId {
        RuntimeId::LlamaCpp
    }
    fn family_id(&self) -> ModelFamilyId {
        ModelFamilyId::Qwen3Asr
    }
    fn capabilities(&self) -> &ModelFamilyCapabilities {
        &CAPABILITIES
    }
    fn probe_model(&self, path: &Path) -> Result<(), TranscriptionError> {
        validate_pair(path)?;
        let mut helper = HelperProcess::spawn(&self.helper_path()?, &|| false)?;
        helper.load(path, false, &|| false)
    }
    fn load(
        &self,
        path: &Path,
        gpu: GpuConfig,
    ) -> Result<Box<dyn LoadedModel>, TranscriptionError> {
        validate_pair(path)?;
        let executable = self.helper_path()?;
        if !executable.is_file() {
            return Err(missing_helper());
        }
        Ok(Box::new(LoadedQwen {
            model_path: path.to_owned(),
            helper_executable: executable,
            use_gpu: gpu.use_gpu,
            helper: None,
            next_request: 0,
        }))
    }
}
fn missing_helper() -> TranscriptionError {
    failure(
        "The packaged Qwen ASR helper is missing. Install the matching sidecar build, including local-dictation-asr-helper.",
    )
}
fn failure(message: &str) -> TranscriptionError {
    TranscriptionError::transcription_failure("Qwen ASR", message)
}
fn cancelled() -> TranscriptionError {
    TranscriptionError {
        code: "transcription_cancelled",
        message: "Local transcription was cancelled.",
        details: None,
    }
}
fn validate_pair(path: &Path) -> Result<(), TranscriptionError> {
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|name| name.starts_with("Qwen3-ASR-") && name.ends_with(".gguf"))
        .ok_or_else(|| {
            failure("Choose the Qwen3-ASR GGUF model beside its matching mmproj companion.")
        })?;
    for file in [
        path.to_path_buf(),
        path.with_file_name(format!("mmproj-{name}")),
    ] {
        if !file.is_file() {
            return Err(failure(
                "Both Qwen model pair members must be existing regular files.",
            ));
        }
        let mut header = [0; 4];
        File::open(&file)
            .and_then(|mut f| f.read_exact(&mut header))
            .map_err(|_| failure("The Qwen model pair is missing, unreadable, or incomplete."))?;
        if &header != b"GGUF" {
            return Err(failure(
                "The Qwen model pair must contain valid GGUF artifacts.",
            ));
        }
    }
    Ok(())
}

struct HelperProcess {
    child: Child,
    commands: Option<SyncSender<AsrCommand>>,
    events: Option<Receiver<Result<AsrEvent, ()>>>,
    reader: Option<JoinHandle<()>>,
    writer: Option<JoinHandle<()>>,
}
impl HelperProcess {
    fn spawn(path: &Path, should_cancel: &dyn Fn() -> bool) -> Result<Self, TranscriptionError> {
        if !path.is_file() {
            return Err(missing_helper());
        }
        Self::spawn_command(Command::new(path), should_cancel)
    }
    fn spawn_command(
        mut command: Command,
        should_cancel: &dyn Fn() -> bool,
    ) -> Result<Self, TranscriptionError> {
        if should_cancel() {
            return Err(cancelled());
        }
        let mut child = command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|_|failure("Cannot launch the packaged Qwen ASR helper. Reinstall the matching sidecar build."))?;
        let stdin = child.stdin.take().expect("piped child stdin");
        let stdout = child.stdout.take().expect("piped child stdout");
        let (events_tx, events) = mpsc::sync_channel(4);
        let writer_events = events_tx.clone();
        let (commands, command_rx) = mpsc::sync_channel(1);
        let reader = thread::spawn(move || {
            let mut stream = BufReader::new(stdout);
            loop {
                match read_frame::<_, AsrEvent>(&mut stream) {
                    Ok(Some(event)) => {
                        if events_tx.send(Ok(event)).is_err() {
                            break;
                        }
                    }
                    _ => {
                        let _ = events_tx.send(Err(()));
                        break;
                    }
                }
            }
        });
        let writer = thread::spawn(move || {
            let mut stream = BufWriter::new(stdin);
            while let Ok(command) = command_rx.recv() {
                if write_frame(&mut stream, &command).is_err() {
                    let _ = writer_events.send(Err(()));
                    break;
                }
            }
        });
        let mut helper = Self {
            child,
            commands: Some(commands),
            events: Some(events),
            reader: Some(reader),
            writer: Some(writer),
        };
        match helper.wait(Duration::from_secs(5), should_cancel)? {
            AsrEvent::Ready {
                version,
                protocol_version,
            } if version == env!("CARGO_PKG_VERSION") && protocol_version == PROTOCOL_VERSION => {
                Ok(helper)
            }
            _ => Err(failure(
                "Qwen ASR helper version/protocol mismatch. Reinstall the matching sidecar build.",
            )),
        }
    }
    fn send(&self, command: AsrCommand) -> Result<(), TranscriptionError> {
        self.commands
            .as_ref()
            .ok_or_else(|| failure("Qwen ASR helper is closed."))?
            .try_send(command)
            .map_err(|_| failure("Qwen ASR helper is unavailable or busy."))
    }
    fn wait(
        &mut self,
        timeout: Duration,
        should_cancel: &dyn Fn() -> bool,
    ) -> Result<AsrEvent, TranscriptionError> {
        let deadline = Instant::now() + timeout;
        loop {
            if should_cancel() {
                return Err(cancelled());
            }
            if Instant::now() >= deadline {
                return Err(failure("Qwen ASR helper timed out; retry transcription."));
            }
            match self
                .events
                .as_ref()
                .ok_or_else(|| failure("Qwen ASR helper is closed."))?
                .recv_timeout(POLL)
            {
                Ok(Ok(event)) => return Ok(event),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                _ => {
                    return Err(failure(
                        "Qwen ASR helper exited unexpectedly; retry transcription.",
                    ));
                }
            }
        }
    }
    fn load(
        &mut self,
        path: &Path,
        use_gpu: bool,
        should_cancel: &dyn Fn() -> bool,
    ) -> Result<(), TranscriptionError> {
        self.send(AsrCommand::Load {
            model_path: path.to_owned(),
            use_gpu,
        })?;
        match self.wait(LOAD_TIMEOUT, should_cancel)? {
            AsrEvent::Loaded => Ok(()),
            _ => Err(failure(
                "The Qwen model pair could not be validated. Check that both matching artifacts are installed.",
            )),
        }
    }
    fn stop(&mut self) {
        // Closing receivers first also releases bounded-channel writers if a
        // damaged helper produced unsolicited events. Killing closes pipe I/O.
        self.events.take();
        self.commands.take();
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
        if let Some(writer) = self.writer.take() {
            let _ = writer.join();
        }
    }
}
impl Drop for HelperProcess {
    fn drop(&mut self) {
        self.stop();
    }
}

struct LoadedQwen {
    model_path: PathBuf,
    helper_executable: PathBuf,
    use_gpu: bool,
    helper: Option<HelperProcess>,
    next_request: u64,
}
impl LoadedModel for LoadedQwen {
    fn transcribe(
        &mut self,
        request: &crate::transcription::TranscriptionRequest,
    ) -> Result<EngineTranscriptOutput, TranscriptionError> {
        self.transcribe_cancellable(request, &|| false)
    }
    fn transcribe_cancellable(
        &mut self,
        request: &crate::transcription::TranscriptionRequest,
        should_cancel: &dyn Fn() -> bool,
    ) -> Result<EngineTranscriptOutput, TranscriptionError> {
        if request.language != "auto" && language_name(&request.language).is_none() {
            return Err(TranscriptionError::unsupported_language(
                &request.language,
                "Qwen ASR supports en/es/de/fr/pt/it/nl/ja or auto.",
            ));
        }
        if request.audio_samples.is_empty()
            || request.audio_samples.len() > MAX_AUDIO_SAMPLES
            || request
                .audio_samples
                .iter()
                .any(|x| !x.is_finite() || x.abs() > 1.0)
        {
            return Err(failure(
                "Qwen ASR requires bounded finite 16 kHz mono PCM, at most 35 seconds per utterance.",
            ));
        }
        let result = (|| {
            if should_cancel() {
                return Err(cancelled());
            }
            if self.helper.is_none() {
                let mut helper = HelperProcess::spawn(&self.helper_executable, should_cancel)?;
                helper.load(&self.model_path, self.use_gpu, should_cancel)?;
                self.helper = Some(helper);
            }
            self.next_request += 1;
            let id = self.next_request;
            let helper = self.helper.as_mut().unwrap();
            helper.send(AsrCommand::Transcribe {
                request_id: id,
                audio_samples: request.audio_samples.clone(),
                language: request.language.clone(),
            })?;
            match helper.wait(DECODE_TIMEOUT, should_cancel)? {
                AsrEvent::Transcript {
                    request_id,
                    text,
                    detected_language,
                } if request_id == id => {
                    let segments = if text.trim().is_empty() {
                        Vec::new()
                    } else {
                        vec![TranscriptSegment {
                            start_ms: 0,
                            end_ms: request.audio_samples.len() as u64 * 1_000 / 16_000,
                            text,
                            speaker: None,
                            timestamp_source: TimestampSource::None,
                            timestamp_granularity: TimestampGranularity::Utterance,
                            words: Vec::new(),
                        }]
                    };
                    Ok(EngineTranscriptOutput {
                        segments,
                        diagnostics: Vec::new(),
                        detected_language,
                    })
                }
                _ => Err(failure(
                    "Qwen ASR inference did not complete; no truncated transcript was accepted.",
                )),
            }
        })();
        if result.is_err() {
            self.helper.take();
        }
        result
    }
}
