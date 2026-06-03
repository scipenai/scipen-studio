//! `Embedder` — produces a fixed-dimension float vector per input text.
//!
//! The trait is stripped down on purpose: real embedders are async-friendly
//! (model inference can take hundreds of ms) but the only state they need
//! to cache is the model itself, so `&self` works. We deliberately accept
//! a slice of texts and return a 2-D matrix in one call so backends like
//! fastembed-rs can batch the ONNX session.
//!
//! ## Backends
//!
//! - [`HashEmbedder`] — deterministic, no external deps, good for tests
//!   and as a stand-in when the production model isn't available. It's
//!   not semantically meaningful — two unrelated strings can be close —
//!   but it satisfies the "stable vector per input" contract.
//! - `FastEmbedEmbedder` (behind the `fastembed` feature, separate chunk)
//!   wraps fastembed-rs for `multilingual-e5-small`.

use async_trait::async_trait;

#[derive(Debug, thiserror::Error)]
pub enum EmbedError {
    #[error("embedder failed: {0}")]
    Backend(String),
}

pub type EmbedResult<T> = Result<T, EmbedError>;

#[async_trait]
pub trait Embedder: Send + Sync {
    /// Stable vector dimensionality. Must match the layout of every
    /// vector this backend ever produces. The vector index relies on
    /// this to validate stored embeddings on retrieval.
    fn dim(&self) -> usize;

    /// Identifier of the underlying model — written alongside each
    /// stored embedding so a config change (e.g. `e5-small` → `e5-base`)
    /// can be detected and the index rebuilt rather than silently
    /// returning bogus rankings.
    fn model_id(&self) -> &str;

    /// Embed a batch of texts. Implementations should return one vector
    /// per input in the same order.
    async fn embed(&self, texts: &[String]) -> EmbedResult<Vec<Vec<f32>>>;
}

/// Cosine similarity between two equal-length vectors. Returns 0 when
/// either side is the zero vector (avoids NaN). Pure helper exposed for
/// retrieval code; lives next to the trait so backends and consumers
/// share one definition.
pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    debug_assert_eq!(a.len(), b.len(), "cosine() needs same-length vectors");
    if a.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0_f32;
    let mut na = 0.0_f32;
    let mut nb = 0.0_f32;
    for (x, y) in a.iter().zip(b.iter()) {
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    if na == 0.0 || nb == 0.0 {
        return 0.0;
    }
    dot / (na.sqrt() * nb.sqrt())
}

/// Deterministic, dependency-free embedder for tests.
///
/// Tokenises on whitespace, hashes each token into one of `dim` buckets
/// via blake3, and accumulates a count vector. The result is L2-normalised
/// so cosine similarity behaves sensibly. Not semantic — "cat" and
/// "feline" land in unrelated dimensions — but two strings that share
/// tokens will show non-zero similarity, which is enough for tests
/// asserting "writes round-trip" and "the right entry ranks first".
pub struct HashEmbedder {
    dim: usize,
}

impl HashEmbedder {
    pub fn new(dim: usize) -> Self {
        assert!(dim > 0 && dim < 65_536, "HashEmbedder dim must be 1..65536");
        Self { dim }
    }
}

impl Default for HashEmbedder {
    fn default() -> Self {
        Self::new(128)
    }
}

#[async_trait]
impl Embedder for HashEmbedder {
    fn dim(&self) -> usize {
        self.dim
    }

    fn model_id(&self) -> &str {
        "hash-embedder/v1"
    }

    async fn embed(&self, texts: &[String]) -> EmbedResult<Vec<Vec<f32>>> {
        let mut out = Vec::with_capacity(texts.len());
        for text in texts {
            let mut v = vec![0.0_f32; self.dim];
            for token in tokenise(text) {
                let h = blake3::hash(token.as_bytes());
                let bytes = h.as_bytes();
                // Take the leading 4 bytes as a u32 index, then the next
                // 4 as a sign bit + magnitude so similar tokens land
                // similarly. Cheap and stable.
                let idx = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
                    as usize
                    % self.dim;
                let sign = if bytes[4] & 1 == 0 { 1.0_f32 } else { -1.0_f32 };
                v[idx] += sign;
            }
            l2_normalise(&mut v);
            out.push(v);
        }
        Ok(out)
    }
}

fn tokenise(text: &str) -> impl Iterator<Item = &str> {
    text.split(|c: char| !(c.is_alphanumeric() || c == '_'))
        .filter(|s| !s.is_empty())
}

fn l2_normalise(v: &mut [f32]) {
    let mag = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if mag == 0.0 {
        return;
    }
    for x in v.iter_mut() {
        *x /= mag;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[tokio::test]
    async fn hash_embedder_returns_one_vec_per_input() {
        let e = HashEmbedder::new(64);
        let v = e
            .embed(&texts(&["alpha beta", "gamma", "delta epsilon zeta"]))
            .await
            .unwrap();
        assert_eq!(v.len(), 3);
        for vec in &v {
            assert_eq!(vec.len(), 64);
        }
    }

    #[tokio::test]
    async fn identical_texts_produce_identical_vecs() {
        let e = HashEmbedder::default();
        let v = e.embed(&texts(&["the quick brown fox"])).await.unwrap();
        let w = e.embed(&texts(&["the quick brown fox"])).await.unwrap();
        assert_eq!(v, w);
    }

    #[tokio::test]
    async fn shared_tokens_yield_higher_similarity_than_disjoint() {
        let e = HashEmbedder::new(256);
        let vs = e
            .embed(&texts(&[
                "rust programming language",
                "rust programming guide",
                "kayaking on lakes",
            ]))
            .await
            .unwrap();
        let close = cosine(&vs[0], &vs[1]);
        let far = cosine(&vs[0], &vs[2]);
        assert!(
            close > far,
            "close={close} should exceed far={far} for shared-token case"
        );
    }

    #[test]
    fn cosine_returns_zero_for_zero_vector() {
        let a = vec![0.0_f32; 8];
        let b = vec![1.0_f32; 8];
        assert_eq!(cosine(&a, &b), 0.0);
    }

    #[test]
    fn cosine_returns_one_for_identical() {
        let v = vec![0.5_f32, 0.5, 0.5, 0.5];
        assert!((cosine(&v, &v) - 1.0).abs() < 1e-6);
    }

    #[tokio::test]
    async fn hash_embedder_normalises_to_unit_length() {
        let e = HashEmbedder::new(64);
        let v = &e.embed(&texts(&["lots of unique tokens here"])).await.unwrap()[0];
        let mag = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!(
            (mag - 1.0).abs() < 1e-5 || mag == 0.0,
            "expected unit-length, got {mag}"
        );
    }
}
