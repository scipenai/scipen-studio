//! `IndexedMemoryStore` — `MemoryStore` + a vector index, glued together.
//!
//! Every write goes through both: the entry's Markdown body is persisted
//! to the file tree, then embedded and upserted into the
//! `memory_vectors` SQLite table. Reads can either go through the
//! file-tree paths on `MemoryStore` directly (still available via
//! [`IndexedMemoryStore::store`]) or use [`IndexedMemoryStore::search`]
//! which embeds the query, scores every stored vector with cosine
//! similarity, and returns the top-k matches.
//!
//! ## Why brute-force, why now
//!
//! sqlite-vec is the eventual home for this when entry counts get
//! interesting (tens of thousands per project). For the workloads SNACA
//! actually sees — a few dozen to a few hundred memory entries per
//! project — pulling every vector and dot-producting in Rust is faster
//! than spinning up a vector-search extension. We can swap the impl
//! when the workload demands it; the search API (`query` → top-k) won't
//! change.
//!
//! ## Embedder/model mismatch
//!
//! Each stored vector carries the `model_id` that produced it. Search
//! filters mismatches out so a bad config swap (e.g. `e5-small` →
//! `e5-base`, different dim) doesn't return mathematically meaningless
//! rankings. Operators rebuild the index by calling
//! [`IndexedMemoryStore::reindex`].

use crate::embed::{cosine, Embedder};
use crate::scope::MemoryScope;
use crate::store::{MemoryEntry, MemoryError, MemoryResult, MemoryStore};
use snaca_core::{ProjectId, TenantId};
use snaca_state::Database;
use std::sync::Arc;
use tracing::{debug, warn};

/// One ranked search hit. Carries enough to fetch the entry's body
/// (`scope`, `name`) plus the cosine score for callers that want to
/// filter / threshold.
#[derive(Debug, Clone)]
pub struct SearchHit {
    pub scope: MemoryScope,
    pub name: String,
    pub score: f32,
}

/// Combines a [`MemoryStore`] (file-tree CRUD) with a [`Database`]
/// (vector storage) and an [`Embedder`] (model). Cheap to clone — every
/// field is `Clone` or `Arc`.
#[derive(Clone)]
pub struct IndexedMemoryStore {
    store: MemoryStore,
    db: Database,
    embedder: Arc<dyn Embedder>,
    tenant: TenantId,
    project: ProjectId,
}

impl IndexedMemoryStore {
    pub fn new(
        store: MemoryStore,
        db: Database,
        embedder: Arc<dyn Embedder>,
        tenant: TenantId,
        project: ProjectId,
    ) -> Self {
        Self {
            store,
            db,
            embedder,
            tenant,
            project,
        }
    }

    pub fn store(&self) -> &MemoryStore {
        &self.store
    }

    pub fn embedder(&self) -> &dyn Embedder {
        self.embedder.as_ref()
    }

    /// Write an entry through the file tree and refresh its embedding.
    /// File-tree write happens first — if it fails (IO) we never touch
    /// the vector table. Embedding failures *don't* roll back the file
    /// write: the entry is still readable as-is, just not retrievable
    /// via vector search until the next successful re-embed. Surfaced
    /// as a warning so operators know to investigate.
    pub async fn write(
        &self,
        scope: MemoryScope,
        name: &str,
        content: &str,
    ) -> MemoryResult<MemoryEntry> {
        let entry = self.store.write(scope, name, content).await?;
        let vec = match self
            .embedder
            .embed(&[content.to_string()])
            .await
        {
            Ok(v) => v,
            Err(e) => {
                warn!(
                    scope = scope.as_str(),
                    name = entry.name.as_str(),
                    error = %e,
                    "embedder failed; entry written but not indexed"
                );
                return Ok(entry);
            }
        };
        if vec.len() != 1 || vec[0].len() != self.embedder.dim() {
            warn!(
                scope = scope.as_str(),
                name = entry.name.as_str(),
                got = vec.first().map(|v| v.len()).unwrap_or(0),
                want = self.embedder.dim(),
                "embedder returned wrong shape; skipping index update"
            );
            return Ok(entry);
        }
        if let Err(e) = self
            .db
            .upsert_memory_vector(
                &self.tenant,
                &self.project,
                scope.as_str(),
                &entry.name,
                self.embedder.model_id(),
                &vec[0],
            )
            .await
        {
            warn!(error = %e, "failed to persist memory vector; will retry on next write");
        }
        Ok(entry)
    }

    /// Delete an entry from the file tree and drop its vector. Both
    /// halves are no-ops when absent, so the call is safe to fire from
    /// idempotent paths.
    pub async fn delete(&self, scope: MemoryScope, name: &str) -> MemoryResult<()> {
        self.store.delete(scope, name).await?;
        // delete_memory_vector wants the canonical lowered name. Re-run
        // the sanitiser so the vector table sees the same key the
        // file-tree write used.
        let canonical = crate::store::sanitize_name(name)?;
        if let Err(e) = self
            .db
            .delete_memory_vector(&self.tenant, &self.project, scope.as_str(), &canonical)
            .await
        {
            warn!(error = %e, "failed to drop memory vector");
        }
        Ok(())
    }

    /// Embed `query` and return the top `k` highest-scoring entries by
    /// cosine similarity. Hits whose stored model id doesn't match the
    /// current embedder are silently skipped — they belong to a
    /// previous index generation. Returns an empty Vec when the project
    /// has no entries (or no embedded entries).
    pub async fn search(&self, query: &str, k: usize) -> MemoryResult<Vec<SearchHit>> {
        if k == 0 {
            return Ok(Vec::new());
        }
        let qvec = match self.embedder.embed(&[query.to_string()]).await {
            Ok(v) if v.len() == 1 => v.into_iter().next().unwrap(),
            Ok(_) => {
                warn!("embedder returned wrong batch size on query");
                return Ok(Vec::new());
            }
            Err(e) => {
                warn!(error = %e, "query embedding failed");
                return Ok(Vec::new());
            }
        };
        if qvec.len() != self.embedder.dim() {
            warn!(
                got = qvec.len(),
                want = self.embedder.dim(),
                "query vector dim mismatch; refusing to score"
            );
            return Ok(Vec::new());
        }

        let stored = self
            .db
            .list_memory_vectors(&self.tenant, &self.project)
            .await
            .map_err(|e| MemoryError::Io(std::io::Error::other(e.to_string())))?;
        let model_id = self.embedder.model_id();
        let mut hits: Vec<SearchHit> = Vec::with_capacity(stored.len());
        for row in stored {
            if row.model_id != model_id || row.embedding.len() != qvec.len() {
                debug!(
                    scope = %row.scope,
                    name = %row.name,
                    row_model = %row.model_id,
                    cur_model = model_id,
                    "skipping stale embedding"
                );
                continue;
            }
            let scope = match MemoryScope::from_dir_name(&row.scope) {
                Some(s) => s,
                None => continue,
            };
            let score = cosine(&qvec, &row.embedding);
            hits.push(SearchHit {
                scope,
                name: row.name,
                score,
            });
        }
        // Descending; partial_cmp is fine because cosine is finite for
        // unit-length vectors.
        hits.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        hits.truncate(k);
        Ok(hits)
    }

    /// Catch the vector index up to the file tree without rebuilding
    /// in-sync entries. Walks every file-tree entry, embeds any whose
    /// (scope, name) is missing from the vector table or whose stored
    /// `model_id` no longer matches the current embedder. Returns the
    /// count of entries that were (re)embedded.
    ///
    /// Cheap when everything's already indexed — one DB read, one
    /// `list_all` directory scan, no embed calls. The engine fires this
    /// at the start of every turn so writes through `MemoryStore`
    /// directly (e.g. via `MemoryWriteTool`) get indexed before the
    /// next vector recall.
    pub async fn ensure_indexed(&self) -> MemoryResult<usize> {
        let entries = self.store.list_all().await?;
        if entries.is_empty() {
            return Ok(0);
        }
        let stored = self
            .db
            .list_memory_vectors(&self.tenant, &self.project)
            .await
            .map_err(|e| MemoryError::Io(std::io::Error::other(e.to_string())))?;
        let model_id = self.embedder.model_id();
        let known: std::collections::HashSet<(String, String)> = stored
            .iter()
            .filter(|r| r.model_id == model_id)
            .map(|r| (r.scope.clone(), r.name.clone()))
            .collect();
        let mut needs: Vec<(crate::scope::MemoryScope, String, String)> = Vec::new();
        for (scope, name) in entries {
            if known.contains(&(scope.as_str().to_string(), name.clone())) {
                continue;
            }
            let entry = self.store.read(scope, &name).await?;
            needs.push((scope, name, entry.content));
        }
        if needs.is_empty() {
            return Ok(0);
        }
        let bodies: Vec<String> = needs.iter().map(|(_, _, c)| c.clone()).collect();
        let vectors = self
            .embedder
            .embed(&bodies)
            .await
            .map_err(|e| MemoryError::Io(std::io::Error::other(e.to_string())))?;
        if vectors.len() != needs.len() {
            return Err(MemoryError::Io(std::io::Error::other(
                "embedder returned wrong batch size during ensure_indexed",
            )));
        }
        for ((scope, name, _), vec) in needs.iter().zip(vectors.iter()) {
            if let Err(e) = self
                .db
                .upsert_memory_vector(
                    &self.tenant,
                    &self.project,
                    scope.as_str(),
                    name,
                    self.embedder.model_id(),
                    vec,
                )
                .await
            {
                warn!(error = %e, scope = %scope, name = %name, "ensure_indexed upsert failed");
            }
        }
        Ok(needs.len())
    }

    /// Walk the file tree, re-embed every entry, and replace the vector
    /// table for `(tenant, project)` wholesale. Use after the embedding
    /// model changes, or to recover from partial-write states (e.g. an
    /// embedder timeout left an entry on disk but not indexed).
    pub async fn reindex(&self) -> MemoryResult<usize> {
        let entries = self.store.list_all().await?;
        let mut bodies = Vec::with_capacity(entries.len());
        for (scope, name) in &entries {
            let entry = self.store.read(*scope, name).await?;
            bodies.push(entry.content);
        }
        if bodies.is_empty() {
            return Ok(0);
        }
        let vectors = self
            .embedder
            .embed(&bodies)
            .await
            .map_err(|e| MemoryError::Io(std::io::Error::other(e.to_string())))?;
        if vectors.len() != entries.len() {
            return Err(MemoryError::Io(std::io::Error::other(
                "embedder returned wrong batch size during reindex",
            )));
        }
        for ((scope, name), vec) in entries.iter().zip(vectors.iter()) {
            if let Err(e) = self
                .db
                .upsert_memory_vector(
                    &self.tenant,
                    &self.project,
                    scope.as_str(),
                    name,
                    self.embedder.model_id(),
                    vec,
                )
                .await
            {
                warn!(error = %e, scope = %scope, name = %name, "reindex upsert failed");
            }
        }
        Ok(entries.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::embed::HashEmbedder;

    async fn fixture() -> (tempfile::TempDir, IndexedMemoryStore) {
        let tmp = tempfile::tempdir().unwrap();
        let store = MemoryStore::new(tmp.path().join("memory"));
        let db = Database::open_in_memory().await.unwrap();
        let embedder = Arc::new(HashEmbedder::new(128));
        let tenant = TenantId::new("t");
        let project = ProjectId::from_raw("p");
        let idx = IndexedMemoryStore::new(store, db, embedder, tenant, project);
        (tmp, idx)
    }

    #[tokio::test]
    async fn write_then_search_returns_the_entry() {
        let (_t, idx) = fixture().await;
        idx.write(MemoryScope::User, "tone", "user prefers terse responses")
            .await
            .unwrap();
        let hits = idx.search("terse responses", 5).await.unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].name, "tone");
        assert_eq!(hits[0].scope, MemoryScope::User);
        assert!(hits[0].score > 0.0, "expected positive score");
    }

    #[tokio::test]
    async fn search_ranks_relevant_entry_above_unrelated() {
        let (_t, idx) = fixture().await;
        idx.write(MemoryScope::Reference, "kayak-spots", "Lake Tahoe and Lake Geneva")
            .await
            .unwrap();
        idx.write(
            MemoryScope::Project,
            "rust-conventions",
            "rust programming style guide for this project",
        )
        .await
        .unwrap();
        idx.write(
            MemoryScope::User,
            "tone",
            "user prefers terse rust answers",
        )
        .await
        .unwrap();

        let hits = idx.search("rust style", 3).await.unwrap();
        assert!(!hits.is_empty(), "expected at least one hit");
        // The rust-conventions entry must outrank the kayak entry.
        let rank_kayak = hits
            .iter()
            .position(|h| h.name == "kayak-spots")
            .unwrap_or(usize::MAX);
        let rank_rust = hits
            .iter()
            .position(|h| h.name == "rust-conventions")
            .unwrap_or(usize::MAX);
        assert!(
            rank_rust < rank_kayak,
            "rust-conventions should outrank kayak-spots; got ranks rust={rank_rust} kayak={rank_kayak}"
        );
    }

    #[tokio::test]
    async fn search_top_k_is_honoured() {
        let (_t, idx) = fixture().await;
        for n in 0..5 {
            idx.write(
                MemoryScope::Project,
                &format!("entry-{n}"),
                "rust programming notes",
            )
            .await
            .unwrap();
        }
        let hits = idx.search("rust", 2).await.unwrap();
        assert_eq!(hits.len(), 2);
    }

    #[tokio::test]
    async fn search_with_zero_k_returns_empty() {
        let (_t, idx) = fixture().await;
        idx.write(MemoryScope::User, "x", "anything").await.unwrap();
        assert!(idx.search("anything", 0).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn delete_drops_entry_from_search_results() {
        let (_t, idx) = fixture().await;
        idx.write(MemoryScope::User, "to-be-deleted", "rust programming notes")
            .await
            .unwrap();
        assert_eq!(idx.search("rust", 5).await.unwrap().len(), 1);
        idx.delete(MemoryScope::User, "to-be-deleted").await.unwrap();
        assert!(idx.search("rust", 5).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn search_skips_entries_from_a_different_model() {
        let (tmp, idx) = fixture().await;
        idx.write(MemoryScope::User, "alpha", "rust programming notes")
            .await
            .unwrap();

        // Swap the embedder out under a fresh wrapper while keeping the
        // same DB+files. The pre-existing vector now carries an old
        // model_id from the embedder's POV — so search should ignore it.
        let new_embedder = Arc::new(crate::embed::HashEmbedder::new(64)); // different dim too
        let other = IndexedMemoryStore::new(
            MemoryStore::new(tmp.path().join("memory")),
            idx.db.clone(),
            new_embedder,
            idx.tenant.clone(),
            idx.project.clone(),
        );
        let hits = other.search("rust", 5).await.unwrap();
        assert!(
            hits.is_empty(),
            "stale-model entry must not surface; got {hits:?}"
        );
    }

    #[tokio::test]
    async fn ensure_indexed_only_embeds_missing_entries() {
        let (_t, idx) = fixture().await;
        // Two entries written through the index — both get vectors.
        idx.write(MemoryScope::User, "indexed-a", "rust language alpha")
            .await
            .unwrap();
        idx.write(MemoryScope::User, "indexed-b", "rust language beta")
            .await
            .unwrap();
        // One written through the inner store directly — no vector yet.
        idx.store
            .write(MemoryScope::Project, "orphan", "rust language gamma")
            .await
            .unwrap();

        let n = idx.ensure_indexed().await.unwrap();
        assert_eq!(n, 1, "only the orphan should need embedding");

        // Subsequent call is a no-op.
        let n2 = idx.ensure_indexed().await.unwrap();
        assert_eq!(n2, 0);

        // Search now sees all three.
        let hits = idx.search("rust language", 10).await.unwrap();
        let names: std::collections::HashSet<_> =
            hits.iter().map(|h| h.name.clone()).collect();
        assert!(names.contains("indexed-a"));
        assert!(names.contains("indexed-b"));
        assert!(names.contains("orphan"));
    }

    #[tokio::test]
    async fn reindex_repairs_missing_vectors() {
        let (_t, idx) = fixture().await;
        // Write through the inner store directly — bypasses the
        // embedding hook, so the vector table is empty.
        idx.store
            .write(MemoryScope::Project, "orphan", "rust language notes")
            .await
            .unwrap();
        assert!(
            idx.search("rust", 5).await.unwrap().is_empty(),
            "no vector should exist before reindex"
        );

        let n = idx.reindex().await.unwrap();
        assert_eq!(n, 1);
        let hits = idx.search("rust", 5).await.unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].name, "orphan");
    }
}
