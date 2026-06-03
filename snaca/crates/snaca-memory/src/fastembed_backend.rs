//! `FastEmbedEmbedder` — production embedder backed by `fastembed-rs`.
//!
//! Compiled only with `--features fastembed`. Downloads the ONNX model
//! (~50 MB for `multilingual-e5-small`) on first use and caches it
//! under `~/.cache/fastembed` (configurable).
//!
//! `fastembed` is sync internally — its `embed()` runs on the calling
//! thread. We wrap calls in `tokio::task::spawn_blocking` so they don't
//! stall the async runtime when a turn happens to embed during a busy
//! moment.
//!
//! ## Cache location
//!
//! The default cache path lives in the user's home; for sandboxed
//! deployments override via `FASTEMBED_CACHE_PATH` before the first
//! `try_new` call. The wrapper accepts a custom dir via [`FastEmbedConfig`]
//! to keep the operator wiring honest.

use crate::embed::{EmbedError, EmbedResult, Embedder};
use async_trait::async_trait;
use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// Construction-time settings. Cheap to clone; held by the embedder.
#[derive(Debug, Clone)]
pub struct FastEmbedConfig {
    pub model: EmbeddingModel,
    pub cache_dir: Option<PathBuf>,
    pub show_download_progress: bool,
}

impl Default for FastEmbedConfig {
    fn default() -> Self {
        Self {
            // Plan default — 384-dim multilingual model, small enough
            // for laptop-class deployments. Operators on bigger boxes
            // can swap to `MultilingualE5Base` for higher recall.
            model: EmbeddingModel::MultilingualE5Small,
            cache_dir: None,
            show_download_progress: false,
        }
    }
}

/// Production embedder. Internally holds a `Mutex<TextEmbedding>` so
/// concurrent embed calls serialise on the ONNX session — fastembed's
/// session is `!Sync` because it carries mutable inference scratch.
/// This is fine for SNACA's workload: one embed per memory write, plus
/// one per search query, both rare relative to LLM round trips.
pub struct FastEmbedEmbedder {
    inner: Arc<Mutex<TextEmbedding>>,
    dim: usize,
    model_id: String,
}

impl FastEmbedEmbedder {
    /// Initialise the model. Downloads weights on first call when the
    /// cache is cold; subsequent calls are local.
    pub fn try_new(config: FastEmbedConfig) -> EmbedResult<Self> {
        let mut opts = InitOptions::new(config.model.clone())
            .with_show_download_progress(config.show_download_progress);
        if let Some(dir) = config.cache_dir.clone() {
            opts = opts.with_cache_dir(dir);
        }
        let mut model = TextEmbedding::try_new(opts).map_err(|e| {
            EmbedError::Backend(format!("fastembed init failed: {e}"))
        })?;
        // Probe an embedding to learn the output dim. The cheap `&[""]`
        // path returns one zero-ish vector but with the right shape.
        let probe = model
            .embed(vec![String::new()], None)
            .map_err(|e| EmbedError::Backend(format!("fastembed probe failed: {e}")))?;
        let dim = probe.first().map(|v| v.len()).unwrap_or(0);
        if dim == 0 {
            return Err(EmbedError::Backend(
                "fastembed probe returned zero-dim vector".into(),
            ));
        }
        let model_id = format!("fastembed/{:?}", config.model);
        Ok(Self {
            inner: Arc::new(Mutex::new(model)),
            dim,
            model_id,
        })
    }
}

#[async_trait]
impl Embedder for FastEmbedEmbedder {
    fn dim(&self) -> usize {
        self.dim
    }

    fn model_id(&self) -> &str {
        &self.model_id
    }

    async fn embed(&self, texts: &[String]) -> EmbedResult<Vec<Vec<f32>>> {
        // Move the texts into the blocking task; the model lock lives
        // inside the closure so it never crosses an await point.
        let texts = texts.to_vec();
        let inner = self.inner.clone();
        let result = tokio::task::spawn_blocking(move || {
            let mut model = inner
                .lock()
                .map_err(|_| EmbedError::Backend("fastembed mutex poisoned".into()))?;
            model
                .embed(texts, None)
                .map_err(|e| EmbedError::Backend(format!("fastembed embed failed: {e}")))
        })
        .await
        .map_err(|e| EmbedError::Backend(format!("blocking task panic: {e}")))?;
        result
    }
}
