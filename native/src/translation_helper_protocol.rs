use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum HelperCommand {
    Translate {
        translation_id: String,
        model_path: PathBuf,
        source_language: String,
        #[serde(default)]
        style_instruction: Option<String>,
        target_language: String,
        texts: Vec<String>,
        use_gpu: bool,
    },
    Cancel {
        translation_id: String,
    },
    Shutdown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum HelperEvent {
    Ready {
        helper_version: String,
    },
    Started {
        translation_id: String,
        total: usize,
    },
    Progress {
        translation_id: String,
        completed: usize,
        total: usize,
    },
    Complete {
        translation_id: String,
        translations: Vec<String>,
    },
    Cancelled {
        translation_id: String,
    },
    Error {
        translation_id: String,
        code: String,
        message: String,
    },
}

#[cfg(test)]
mod tests {
    use super::HelperCommand;

    #[test]
    fn translate_style_instruction_uses_camel_case_and_stays_optional() {
        let base = serde_json::json!({
            "type": "translate",
            "translationId": "translation-1",
            "modelPath": "/tmp/hy-mt.gguf",
            "sourceLanguage": "en",
            "targetLanguage": "es",
            "texts": ["Hello"],
            "useGpu": false,
        });

        let HelperCommand::Translate {
            style_instruction, ..
        } = serde_json::from_value(base.clone()).expect("omitted style should parse")
        else {
            panic!("expected translate command");
        };
        assert_eq!(style_instruction, None);

        let mut styled = base;
        styled["styleInstruction"] = serde_json::json!("casual");
        let HelperCommand::Translate {
            style_instruction, ..
        } = serde_json::from_value(styled).expect("style should parse")
        else {
            panic!("expected translate command");
        };
        assert_eq!(style_instruction.as_deref(), Some("casual"));
    }
}
