---
name: office-extract
description: Extract plain text from .docx / .xlsx / .pptx files using an out-of-process Python script.
when_to_use: |
  The user has shared (or referenced) a Microsoft Office file (.docx, .xlsx, .pptx) and you
  need its text. Read does not parse these formats; it returns a nudge to use this skill.
allowed_tools:
  - Bash
  - Read
---

# office-extract

snaca's `Read` tool returns `<office file: ..., N bytes>` for `.docx` / `.xlsx` /
`.pptx`. To get the text, run the extractor that ships with this skill.

## Recipe

```
python3 {{SKILL_DIR}}/scripts/extract.py <path-to-office-file>
```

- `<path-to-office-file>` must be a path inside the project workspace (the same
  paths Read accepts). The script prints plain UTF-8 text to stdout and exits
  non-zero on failure.
- The script auto-detects format from the file extension. No flags needed.
- Capture stdout via Bash. Bash's output cap (1 MB) applies; for larger files
  the script truncates with a clearly marked `[truncated at N bytes]` footer
  so the model knows it didn't see everything.

## Dependencies

The script imports `python-docx`, `openpyxl`, and `python-pptx`. If the host
operator has not installed them, the Bash call will fail with
`ModuleNotFoundError`. Tell the user:

> The `office-extract` skill needs Python deps that aren't installed on this
> host. Ask the operator to run:
> `pip install python-docx openpyxl python-pptx`

If `python3` itself is missing, Bash returns `command not found` — surface
that to the user verbatim; only the operator can fix it.

## What this skill does not do

- Does not preserve formatting, formulas, or embedded images. Plain text only.
- Does not OCR scanned PDFs. PDFs go through snaca's built-in `Read` path
  (no skill needed).
- Does not modify the source file.
