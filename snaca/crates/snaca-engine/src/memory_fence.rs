//! Fence-based defence against recursive memory pollution.
//!
//! ## Why
//!
//! The system prompt now carries a `<memory-context>` snapshot and
//! the dispatcher inlines an `<attachments>` block in user messages.
//! Both are clearly delimited so the LLM understands "this is data,
//! not instructions". The risk: the LLM may quote one of these
//! blocks back in its assistant text. If we let that quote through,
//! it lands in the transcript and the next-turn extractor reads it
//! as if the user had typed it — re-ingesting our own injected
//! context is the recursion that hermes calls out as a real attack
//! surface.
//!
//! ## Two surfaces
//!
//! - [`sanitize_context`] is the one-shot helper. Hand it any text
//!   (transcript line, full message, etc.) and it returns a copy
//!   with every protected fence removed. Used by the post-turn
//!   `MemoryExtractor` to clean the transcript before the LLM call.
//! - [`StreamingScrubber`] is the incremental version. Feed it
//!   stream chunks one at a time; it returns the safe-to-forward
//!   prefix and buffers any incomplete tag for the next chunk.
//!   Used by the LLM provider layer so a partial `<memory-context`
//!   straddling a chunk boundary isn't naively forwarded as the
//!   start of a real fence.
//!
//! ## Names protected
//!
//! `memory-context` and `attachments`. New fence names get added
//! via [`PROTECTED_FENCES`] — the list is the single source of
//! truth used by both surfaces and by tests.

/// Names of XML-style fences whose contents must never round-trip
/// back into a memory write. Same list drives the one-shot
/// [`sanitize_context`] helper and the [`StreamingScrubber`]
/// incremental state machine.
pub const PROTECTED_FENCES: &[&str] = &["memory-context", "attachments"];

/// One-shot version: strip every `<name ...>...</name>` block whose
/// `name` is in [`PROTECTED_FENCES`]. Unbalanced opens are removed
/// to end-of-input on the assumption that a malformed fence is
/// either an attempt to hide content or a truncated quote — either
/// way, dropping it is safer than echoing it.
///
/// Plain text without any fence is returned as-is (allocation
/// avoided on the hot path).
pub fn sanitize_context(input: &str) -> String {
    if !input.contains('<') {
        return input.to_string();
    }
    let mut out = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'<' {
            if let Some(skip) = strip_protected_block(input, i) {
                i += skip;
                continue;
            }
        }
        // Append one char (UTF-8 safe step).
        let ch_end = next_char_boundary(input, i);
        out.push_str(&input[i..ch_end]);
        i = ch_end;
    }
    out
}

/// If `input[start..]` begins with `<name>` or `<name ...>` for any
/// protected name, scan forward to the matching `</name>` and
/// return the byte length to skip. Unmatched opens consume to
/// end-of-input. Returns `None` when no protected fence opens
/// exactly at `start`.
fn strip_protected_block(input: &str, start: usize) -> Option<usize> {
    let bytes = input.as_bytes();
    debug_assert_eq!(bytes[start], b'<');
    for name in PROTECTED_FENCES {
        let opener = name.as_bytes();
        let after_lt = start + 1;
        if after_lt + opener.len() > bytes.len() {
            continue;
        }
        if !bytes[after_lt..after_lt + opener.len()].eq_ignore_ascii_case(opener) {
            continue;
        }
        // The next byte must be one of `>`, ` `, `\t`, `\n`, `/`
        // — otherwise this is `<memory-contextual` etc., not our
        // fence.
        let after_name = after_lt + opener.len();
        if after_name >= bytes.len() {
            continue;
        }
        let nb = bytes[after_name];
        if !(nb == b'>' || nb == b' ' || nb == b'\t' || nb == b'\n' || nb == b'/') {
            continue;
        }
        // Find the closing `>` of the opening tag.
        let mut j = after_name;
        while j < bytes.len() && bytes[j] != b'>' {
            j += 1;
        }
        if j >= bytes.len() {
            // Unterminated `<memory-context ...` — drop to EOF.
            return Some(bytes.len() - start);
        }
        // Self-closing `<name ... />` — consume the open tag only.
        if j > 0 && bytes[j - 1] == b'/' {
            return Some(j + 1 - start);
        }
        // Find the matching `</name>` (case-insensitive).
        let close_marker = format!("</{name}");
        let close_marker_bytes = close_marker.as_bytes();
        let mut k = j + 1;
        while k + close_marker_bytes.len() <= bytes.len() {
            if bytes[k..k + close_marker_bytes.len()].eq_ignore_ascii_case(close_marker_bytes) {
                // Move past the `>` after `</name`.
                let mut end = k + close_marker_bytes.len();
                while end < bytes.len() && bytes[end] != b'>' {
                    end += 1;
                }
                if end < bytes.len() {
                    end += 1;
                }
                return Some(end - start);
            }
            k += 1;
        }
        // No close tag — drop to EOF.
        return Some(bytes.len() - start);
    }
    None
}

fn next_char_boundary(input: &str, mut i: usize) -> usize {
    i += 1;
    while i < input.len() && !input.is_char_boundary(i) {
        i += 1;
    }
    i
}

/// Incremental scrubber for streaming LLM output. Maintains a
/// little buffer for partial tags that span chunk boundaries; each
/// `push` returns the bytes safe to forward to the user / sink.
///
/// Call `flush` when the stream ends; it emits any held-back text
/// that turned out not to be the start of a protected fence.
#[derive(Debug, Default)]
pub struct StreamingScrubber {
    /// Bytes we haven't decided about yet. Either a partial fence
    /// open like `<memo` (waiting for more bytes to disambiguate)
    /// or already-confirmed inside a protected block (which we
    /// suppress until the close tag arrives).
    held: String,
    /// `Some(name)` while we're inside a confirmed protected
    /// block, waiting for `</name>` to land. `None` otherwise.
    inside: Option<&'static str>,
}

impl StreamingScrubber {
    pub fn new() -> Self {
        Self::default()
    }

    /// Append `chunk` to the scrubber and return the prefix that's
    /// now safe to forward downstream. The returned string may be
    /// empty (everything is currently held pending more bytes); the
    /// scrubber retains state and the next call resumes.
    pub fn push(&mut self, chunk: &str) -> String {
        self.held.push_str(chunk);
        let mut out = String::with_capacity(self.held.len());
        loop {
            // Inside a confirmed block: drop bytes until the
            // closing tag lands, then resume normal scanning.
            if let Some(name) = self.inside {
                let close = format!("</{name}>");
                if let Some(pos) = find_close_tag(&self.held, &close) {
                    let drop_to = pos + close.len();
                    self.held.drain(..drop_to);
                    self.inside = None;
                    continue;
                }
                // Whole buffer is inside the block — discard but
                // keep the tail that might be the start of `</name>`.
                let keep = held_tail_overlap(&self.held, &close);
                let drop_to = self.held.len() - keep;
                self.held.drain(..drop_to);
                return out;
            }
            // Not inside any block. Look for the next `<`.
            let lt = self.held.find('<');
            let lt = match lt {
                Some(p) => p,
                None => {
                    // Pure text — flush everything except a
                    // potential tail that could start a tag in the
                    // next chunk (in practice that's just `<` at
                    // the very end, nothing else needs to be held).
                    let tail = if self.held.ends_with('<') { 1 } else { 0 };
                    let take_to = self.held.len() - tail;
                    out.push_str(&self.held[..take_to]);
                    self.held.drain(..take_to);
                    return out;
                }
            };
            // Flush the safe prefix before the `<`.
            out.push_str(&self.held[..lt]);
            self.held.drain(..lt);
            // Decide what's after the `<`.
            match classify_open(&self.held) {
                OpenClassification::NotProtected => {
                    // It's some other tag (or just stray `<`) —
                    // forward the `<` and keep scanning.
                    out.push('<');
                    self.held.drain(..1);
                }
                OpenClassification::Incomplete => {
                    // Need more bytes to decide; hold and bail.
                    return out;
                }
                OpenClassification::Protected { name, open_len } => {
                    // Consume the opening tag. The remainder is
                    // inside the protected block.
                    self.held.drain(..open_len);
                    self.inside = Some(name);
                }
                OpenClassification::ProtectedSelfClosing { open_len } => {
                    // `<name ... />` — entire fence is the open tag.
                    self.held.drain(..open_len);
                }
            }
        }
    }

    /// Drain remaining held bytes after the upstream stream has
    /// closed. If we're stuck in an unterminated protected block,
    /// the whole tail is dropped — that's the safe call: the LLM
    /// quoted half a fence and there's no close tag coming.
    pub fn flush(&mut self) -> String {
        let mut out = String::new();
        if self.inside.is_some() {
            self.held.clear();
            self.inside = None;
            return out;
        }
        // No confirmed protected open; whatever's held is at most
        // a stray `<` or a partial unrecognised tag — emit it as-is.
        out.push_str(&self.held);
        self.held.clear();
        out
    }
}

enum OpenClassification {
    NotProtected,
    Incomplete,
    Protected { name: &'static str, open_len: usize },
    ProtectedSelfClosing { open_len: usize },
}

fn classify_open(s: &str) -> OpenClassification {
    debug_assert!(s.starts_with('<'));
    let bytes = s.as_bytes();
    if bytes.len() < 2 {
        return OpenClassification::Incomplete;
    }
    // `</...` is a close tag — definitely not the open of one of
    // our fences (close tags are emitted/consumed by the
    // `inside` arm of `push`). Forward the `<` as a not-protected
    // marker so the caller's scrubber loop advances past it.
    if bytes[1] == b'/' {
        return OpenClassification::NotProtected;
    }
    // Try every protected name.
    for name in PROTECTED_FENCES {
        let nb = name.as_bytes();
        let after_lt = 1;
        let need = after_lt + nb.len();
        // `<=` (not `<`): even when the name fully fits we still need
        // one more byte at index `need` for the disambiguator read
        // below. Holding at `bytes.len() == need` avoids an
        // out-of-bounds index on inputs like a bare `<memory-context`
        // that arrive on a token boundary.
        if bytes.len() <= need {
            // Could still grow into a protected open — keep
            // holding only when the prefix matches so far.
            if (bytes[after_lt..]).eq_ignore_ascii_case(&nb[..bytes.len() - after_lt]) {
                return OpenClassification::Incomplete;
            }
            continue;
        }
        if !bytes[after_lt..need].eq_ignore_ascii_case(nb) {
            continue;
        }
        // The byte after the name disambiguates "<memory-context"
        // from "<memory-contextual".
        let nb2 = bytes[need];
        if !(nb2 == b'>' || nb2 == b' ' || nb2 == b'\t' || nb2 == b'\n' || nb2 == b'/') {
            continue;
        }
        // Find the `>` that closes the open tag.
        let mut j = need;
        while j < bytes.len() && bytes[j] != b'>' {
            j += 1;
        }
        if j >= bytes.len() {
            // Open tag not terminated yet — wait for more bytes.
            return OpenClassification::Incomplete;
        }
        let open_len = j + 1;
        if j > 0 && bytes[j - 1] == b'/' {
            return OpenClassification::ProtectedSelfClosing { open_len };
        }
        return OpenClassification::Protected { name, open_len };
    }
    // Not one of our fences. We can confirm this only once enough
    // bytes have arrived to reject every protected prefix.
    let max_name_len = PROTECTED_FENCES.iter().map(|n| n.len()).max().unwrap_or(0);
    let want = 1 + max_name_len + 1;
    if bytes.len() < want {
        // Could still grow into a hit; keep holding.
        return OpenClassification::Incomplete;
    }
    OpenClassification::NotProtected
}

/// Find the byte index of `close` in `haystack` (case-insensitive
/// for the tag name). Falls back to `None` when the close tag
/// isn't present yet.
fn find_close_tag(haystack: &str, close: &str) -> Option<usize> {
    let needle = close.as_bytes();
    let hay = haystack.as_bytes();
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    // Linear search; close tags are short.
    for i in 0..=hay.len() - needle.len() {
        if hay[i..i + needle.len()].eq_ignore_ascii_case(needle) {
            return Some(i);
        }
    }
    None
}

/// How many bytes at the tail of `held` could be the start of
/// `close`? Used to retain the minimal suffix when discarding
/// inside-block bytes — without this the scrubber would discard
/// `</mem` and then never recognise the close tag.
fn held_tail_overlap(held: &str, close: &str) -> usize {
    let close_bytes = close.as_bytes();
    let held_bytes = held.as_bytes();
    let mut max = std::cmp::min(held_bytes.len(), close_bytes.len() - 1);
    while max > 0 {
        let tail = &held_bytes[held_bytes.len() - max..];
        if close_bytes[..max].eq_ignore_ascii_case(tail) {
            return max;
        }
        max -= 1;
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_passes_through_clean_text() {
        let input = "Just some plain text without fences.";
        assert_eq!(sanitize_context(input), input);
    }

    #[test]
    fn sanitize_strips_memory_context_block() {
        let input = "before\n<memory-context source=\"x\">\nleak\n</memory-context>\nafter";
        let out = sanitize_context(input);
        assert!(!out.contains("leak"));
        assert!(!out.contains("memory-context"));
        assert!(out.contains("before"));
        assert!(out.contains("after"));
    }

    #[test]
    fn sanitize_strips_attachments_block() {
        let input = "ok <attachments>\n- file.md\n  <preview>secret</preview>\n</attachments> done";
        let out = sanitize_context(input);
        assert!(!out.contains("secret"));
        assert!(!out.contains("attachments"));
        assert!(out.contains("ok "));
        assert!(out.contains(" done"));
    }

    #[test]
    fn sanitize_drops_unterminated_fence_to_eof() {
        let input = "before <memory-context>leaked content but no close tag";
        let out = sanitize_context(input);
        assert!(!out.contains("leaked"));
        assert!(out.contains("before "));
    }

    #[test]
    fn sanitize_does_not_match_lookalike_names() {
        // `<memory-contextual>` is not the protected name and
        // must round-trip unchanged.
        let input = "kept <memory-contextual>fine</memory-contextual> here";
        let out = sanitize_context(input);
        assert_eq!(out, input);
    }

    #[test]
    fn streaming_passes_clean_text_immediately() {
        let mut s = StreamingScrubber::new();
        let out = s.push("hello world");
        assert_eq!(out, "hello world");
        let out = s.flush();
        assert!(out.is_empty());
    }

    #[test]
    fn streaming_holds_partial_tag_then_recognises_protected_open() {
        let mut s = StreamingScrubber::new();
        // Feed the open tag in two pieces.
        let out1 = s.push("hello <memo");
        // The `<memo` tail should be held back since it could
        // grow into a protected fence.
        assert!(!out1.contains('<'), "got {out1:?}");
        assert_eq!(out1, "hello ");
        let out2 = s.push("ry-context>secret payload</memory-context> bye");
        assert!(!out2.contains("secret"));
        assert!(!out2.contains("memory-context"));
        assert!(out2.contains("bye"));
    }

    #[test]
    fn streaming_drops_unterminated_protected_block_on_flush() {
        let mut s = StreamingScrubber::new();
        let _ = s.push("<memory-context>leak");
        let final_out = s.flush();
        assert!(!final_out.contains("leak"), "got {final_out:?}");
    }

    #[test]
    fn streaming_handles_split_close_tag_across_chunks() {
        let mut s = StreamingScrubber::new();
        let mut all = String::new();
        all.push_str(&s.push("<memory-context>poison"));
        // Close tag straddles a boundary.
        all.push_str(&s.push("</memory-cont"));
        all.push_str(&s.push("ext>after"));
        all.push_str(&s.flush());
        assert!(!all.contains("poison"));
        assert!(all.ends_with("after"));
    }

    #[test]
    fn streaming_passes_through_unrelated_tag() {
        let mut s = StreamingScrubber::new();
        let mut acc = String::new();
        acc.push_str(&s.push("<bold>kept</bold>"));
        acc.push_str(&s.flush());
        assert_eq!(acc, "<bold>kept</bold>");
    }

    #[test]
    fn streaming_holds_exact_name_length_without_panic() {
        // Regression: a chunk boundary landing right after the fence
        // name (`<memory-context` with no following byte) must be held
        // as Incomplete, not index past the buffer end.
        for name in PROTECTED_FENCES {
            let mut s = StreamingScrubber::new();
            let out = s.push(&format!("<{name}"));
            assert!(!out.contains('<'), "name {name}: leaked open, got {out:?}");
            let rest = s.push(">payload");
            let tail = s.flush();
            let all = format!("{out}{rest}{tail}");
            assert!(
                !all.contains("payload"),
                "name {name}: payload leaked, got {all:?}"
            );
        }
    }

    #[test]
    fn streaming_passes_through_lookalike_open() {
        let mut s = StreamingScrubber::new();
        let mut acc = String::new();
        acc.push_str(&s.push("<memory-contextual"));
        acc.push_str(&s.push(">data</memory-contextual>"));
        acc.push_str(&s.flush());
        assert!(acc.contains("memory-contextual"));
        assert!(acc.contains("data"));
    }
}
