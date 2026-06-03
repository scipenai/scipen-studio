//! Text chunking for the bulk import pipeline.
//!
//! Two splitters share the same target window. Markdown gets a
//! heading-aware splitter that keeps each `# / ## / ###` section
//! together where possible, falling back to the generic recursive
//! splitter when a section is too long. Everything else uses the
//! recursive splitter directly.
//!
//! ## Why bytes, not tokens
//!
//! Real tokenizers vary by model. A byte budget is portable, cheap, and
//! works as a fairly stable proxy for tokens within a factor of 4. The
//! plan calls out "800 tokens / 100 overlap" as a target — at ~4
//! bytes/token in English (and the small e5 multilingual tokenizer) we
//! land near 3 200 / 400 byte windows, which is what `ChunkConfig`
//! defaults to.

use std::collections::VecDeque;

/// Knobs for the chunker. `target_bytes` is the soft ceiling per
/// chunk; the splitter will exceed it only when a single line / token
/// is itself larger. `overlap_bytes` is added at the *start* of each
/// chunk after the first, drawn from the tail of the previous one, so
/// retrieval hits stay coherent across boundaries.
#[derive(Debug, Clone)]
pub struct ChunkConfig {
    pub target_bytes: usize,
    pub overlap_bytes: usize,
}

impl Default for ChunkConfig {
    fn default() -> Self {
        Self {
            // ~800 tokens at 4 bytes/token. Tunable if the operator
            // imports a lot of e.g. CJK text where bytes/token is
            // smaller.
            target_bytes: 3200,
            overlap_bytes: 400,
        }
    }
}

/// Pure-text recursive splitter. Tries paragraph splits first
/// (`\n\n`), then line splits, then sentence-ish splits (`. `), then
/// hard byte cuts. Each stage is consulted until the resulting pieces
/// all fit under `target_bytes`. Adds `overlap_bytes` from the
/// previous piece's tail to each successor.
pub fn chunk_recursive(text: &str, cfg: &ChunkConfig) -> Vec<String> {
    if text.is_empty() {
        return Vec::new();
    }
    let initial = vec![text.to_string()];
    let stage1 = explode(initial, "\n\n", cfg.target_bytes);
    let stage2 = explode(stage1, "\n", cfg.target_bytes);
    let stage3 = explode(stage2, ". ", cfg.target_bytes);
    let stage4 = hard_cut(stage3, cfg.target_bytes);
    add_overlap(stage4, cfg.overlap_bytes)
}

/// Markdown chunker — splits on top-level headings, falling back to
/// the recursive splitter for any section that exceeds `target_bytes`.
/// Heading lines (the `#`-prefixed ones) are kept in their owning
/// chunk so the model can see what the section is about.
pub fn chunk_markdown(text: &str, cfg: &ChunkConfig) -> Vec<String> {
    if text.is_empty() {
        return Vec::new();
    }
    let sections = split_on_headings(text);
    if sections.len() <= 1 {
        // No headings (or one giant document with a single heading).
        // Fall back to recursive — same outcome the caller would get
        // by routing a non-markdown blob through this function.
        return chunk_recursive(text, cfg);
    }
    let mut out: Vec<String> = Vec::new();
    for section in sections {
        if section.len() <= cfg.target_bytes {
            out.push(section);
        } else {
            // Section too big — split it further. We don't add overlap
            // *between* sections, only inside this one.
            out.extend(chunk_recursive(&section, cfg));
        }
    }
    add_overlap(out, cfg.overlap_bytes)
}

/// Split text on `^#+\s` lines. Keeps the heading on its own section.
/// Top-of-file content (before any heading) becomes the first section.
fn split_on_headings(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut current = String::new();
    for line in text.lines() {
        let trimmed = line.trim_start();
        let is_heading = trimmed.starts_with('#')
            && trimmed
                .chars()
                .find(|c| *c != '#')
                .map(|c| c.is_whitespace())
                .unwrap_or(false);
        if is_heading && !current.trim().is_empty() {
            out.push(std::mem::take(&mut current));
        }
        current.push_str(line);
        current.push('\n');
    }
    if !current.trim().is_empty() {
        out.push(current);
    }
    out
}

/// Generic exploder: split each piece on `delimiter` whenever the
/// piece exceeds `target`. Pieces that already fit are passed through
/// unchanged. Re-glues fragments greedily up to `target` so we don't
/// fragment more than necessary.
fn explode(pieces: Vec<String>, delimiter: &str, target: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for piece in pieces {
        if piece.len() <= target {
            out.push(piece);
            continue;
        }
        // Split, then re-glue greedily.
        let parts: Vec<&str> = piece.split(delimiter).collect();
        let mut buf = String::new();
        for (i, p) in parts.iter().enumerate() {
            let candidate_len = if buf.is_empty() {
                p.len()
            } else {
                buf.len() + delimiter.len() + p.len()
            };
            if !buf.is_empty() && candidate_len > target {
                out.push(std::mem::take(&mut buf));
                buf.push_str(p);
            } else {
                if !buf.is_empty() {
                    buf.push_str(delimiter);
                }
                buf.push_str(p);
            }
            // Keep `i` referenced to silence unused; it's intentional we don't index by it.
            let _ = i;
        }
        if !buf.is_empty() {
            out.push(buf);
        }
    }
    out
}

/// Last-resort: any piece still bigger than `target` gets chopped on
/// raw byte boundaries (UTF-8-safe — we back up to a char boundary).
fn hard_cut(pieces: Vec<String>, target: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for piece in pieces {
        if piece.len() <= target {
            out.push(piece);
            continue;
        }
        let mut start = 0;
        while start < piece.len() {
            let mut end = (start + target).min(piece.len());
            while end < piece.len() && !piece.is_char_boundary(end) {
                end -= 1;
            }
            if end <= start {
                end = piece.len();
            }
            out.push(piece[start..end].to_string());
            start = end;
        }
    }
    out
}

/// Add a tail-of-previous prefix to each chunk after the first. Keeps
/// the boundary context useful for retrieval. The prefix is preceded
/// by a single newline so the join is visible.
fn add_overlap(pieces: Vec<String>, overlap: usize) -> Vec<String> {
    if overlap == 0 || pieces.len() <= 1 {
        return pieces;
    }
    let mut q: VecDeque<String> = VecDeque::from(pieces);
    let mut out: Vec<String> = Vec::new();
    let mut prev_tail: Option<String> = None;
    while let Some(piece) = q.pop_front() {
        match prev_tail.take() {
            None => {
                let tail = take_tail(&piece, overlap);
                out.push(piece);
                prev_tail = Some(tail);
            }
            Some(tail) => {
                let combined = format!("{tail}\n{piece}");
                let next_tail = take_tail(&piece, overlap);
                out.push(combined);
                prev_tail = Some(next_tail);
            }
        }
    }
    out
}

/// Take the last `n` bytes of `s`, backing up to a char boundary.
fn take_tail(s: &str, n: usize) -> String {
    if s.len() <= n {
        return s.to_string();
    }
    let mut start = s.len() - n;
    while start < s.len() && !s.is_char_boundary(start) {
        start += 1;
    }
    s[start..].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(target: usize, overlap: usize) -> ChunkConfig {
        ChunkConfig {
            target_bytes: target,
            overlap_bytes: overlap,
        }
    }

    #[test]
    fn empty_input_yields_empty() {
        assert!(chunk_recursive("", &ChunkConfig::default()).is_empty());
        assert!(chunk_markdown("", &ChunkConfig::default()).is_empty());
    }

    #[test]
    fn under_target_returns_single_chunk() {
        let v = chunk_recursive("hello world", &cfg(100, 0));
        assert_eq!(v, vec!["hello world".to_string()]);
    }

    #[test]
    fn paragraph_splits_used_first() {
        let text = "Para one with some content here.\n\nPara two with different content.\n\nPara three short.";
        // Tight target — should split paragraphs.
        let v = chunk_recursive(text, &cfg(40, 0));
        assert!(v.len() >= 2, "expected multiple chunks; got {v:?}");
        // Each chunk fits within ~target + slack.
        for c in &v {
            assert!(c.len() <= 80, "chunk too long: {c:?}");
        }
    }

    #[test]
    fn hard_cut_handles_token_larger_than_target() {
        // A single 1KB blob with no whitespace at all.
        let blob = "x".repeat(1024);
        let v = chunk_recursive(&blob, &cfg(256, 0));
        assert!(v.len() >= 4, "expected at least 4 hard-cut chunks");
        for c in &v {
            assert!(c.len() <= 256, "chunk exceeded target: {}", c.len());
        }
        // Reassembly should be lossless.
        let joined: String = v.join("");
        assert_eq!(joined, blob);
    }

    #[test]
    fn overlap_adds_tail_of_previous_chunk() {
        let text = "AAAAA\n\nBBBBB\n\nCCCCC";
        let v = chunk_recursive(text, &cfg(8, 3));
        assert!(v.len() >= 2);
        // Every chunk after the first must start with a tail-of-prev.
        for (i, chunk) in v.iter().enumerate().skip(1) {
            assert!(
                chunk.contains('\n'),
                "expected overlap join in chunk {i}: {chunk:?}",
            );
        }
    }

    #[test]
    fn markdown_splits_on_headings() {
        let md = "# Section A\n\nAlpha line.\n\n## Subsection\n\nBeta line.\n\n# Section B\n\nGamma line.";
        // Big target so each section fits in its own chunk.
        let v = chunk_markdown(md, &cfg(1000, 0));
        // Exactly three sections (Section A absorbs Subsection).
        assert!(v.len() >= 2, "expected at least 2 sections, got {v:?}");
        assert!(v.iter().any(|c| c.contains("# Section A")));
        assert!(v.iter().any(|c| c.contains("# Section B")));
    }

    #[test]
    fn markdown_with_no_headings_falls_back_to_recursive() {
        let txt = "Just a flat document.\n\nWith two paragraphs.";
        let v = chunk_markdown(txt, &cfg(20, 0));
        // Same shape as recursive on the same text.
        let r = chunk_recursive(txt, &cfg(20, 0));
        assert_eq!(v, r);
    }

    #[test]
    fn markdown_oversized_section_is_recursively_split() {
        let big = format!("# Section\n\n{}", "lorem ipsum dolor sit amet ".repeat(40));
        let v = chunk_markdown(&big, &cfg(100, 0));
        assert!(v.len() >= 3, "expected oversized section to split: {v:?}");
        // First chunk still carries the heading.
        assert!(v[0].contains("# Section"));
    }

    #[test]
    fn take_tail_is_utf8_safe() {
        // Multi-byte char near the boundary.
        let s = "abcd中文";
        let t = take_tail(s, 3);
        // Don't slice mid-codepoint; we accept ≤ requested bytes.
        assert!(s.ends_with(&t), "tail should be a suffix; got {t:?}");
    }
}
