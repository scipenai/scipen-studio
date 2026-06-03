//! PDF text extractor — thin wrapper over the `pdf-extract` crate.
//!
//! `pdf-extract` returns a single `String` of the document's body text
//! with paragraphs preserved as best the source PDF allows. We pass it
//! through with one normalisation step: collapse runs of three or more
//! consecutive blank lines into two, since some PDFs emit one blank
//! line per soft hyphen / column break and the chunker would otherwise
//! treat each blank as a paragraph boundary.

#[derive(Debug, thiserror::Error)]
pub enum PdfError {
    #[error("pdf parse failed: {0}")]
    Parse(String),
}

/// Extract body text from a PDF file's bytes. Returns the raw text;
/// the caller chunks via the standard pipeline.
pub fn extract(bytes: &[u8]) -> Result<String, PdfError> {
    let raw = ::pdf_extract::extract_text_from_mem(bytes)
        .map_err(|e| PdfError::Parse(e.to_string()))?;
    Ok(normalise(&raw))
}

/// Cap consecutive blank lines at two, trim trailing whitespace per
/// line. PDFs often emit one `\n` per visual line *and* one for the
/// paragraph break, leaving 3-4 blanks between real paragraphs that
/// confuse the heading-aware chunker.
fn normalise(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut blanks = 0usize;
    for line in text.lines() {
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            blanks += 1;
            if blanks <= 2 {
                out.push('\n');
            }
        } else {
            blanks = 0;
            out.push_str(trimmed);
            out.push('\n');
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalise_collapses_runs_of_blank_lines() {
        let input = "first\n\n\n\nsecond\n\n\n\n\n\nthird\n";
        let out = normalise(input);
        // After normalisation, at most two BLANK lines may sit between
        // text — that's three consecutive `\n` (one from the prior text
        // line + two blanks). Four `\n` would mean three blank lines.
        assert!(
            !out.contains("\n\n\n\n"),
            "expected at most 2 blank lines; got: {out:?}"
        );
        assert!(out.contains("first\n\n\nsecond") || out.contains("first\n\nsecond"));
    }

    #[test]
    fn normalise_trims_trailing_whitespace() {
        let out = normalise("hello   \nworld\t\n");
        assert_eq!(out, "hello\nworld\n");
    }

    #[test]
    fn extract_rejects_invalid_input() {
        // Random bytes — pdf-extract should bail with an Err. We assert
        // we don't panic and we get our own typed error back.
        let err = extract(b"not a pdf").unwrap_err();
        assert!(matches!(err, PdfError::Parse(_)));
    }
}
