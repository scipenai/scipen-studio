# `office-extract` example skill

Reference skill that gives snaca the ability to read `.docx` / `.xlsx` / `.pptx`
files. snaca core deliberately does **not** parse these formats — see the
plan in `plan.md` for the rationale. This skill bundles a Python script that
does the work out-of-process, invoked from the LLM via the Bash tool.

## Install

This directory is a reference template. Copy it into the tenant skills root
under your snaca data root (`<data_root>/<tenant>/skills/`):

```
cp -r examples/skills/office-extract <data_root>/<tenant>/skills/
```

If you want it scoped to a single project instead, drop it under
`<data_root>/<tenant>/projects/<project>/skills/`.

Install the Python dependencies on the host that runs snaca-server:

```
pip install python-docx openpyxl python-pptx
```

(Using a virtualenv is fine — make sure `python3` on `$PATH` is the one that
sees the packages.)

## Verify

Restart snaca-server, then ask the bot to read or summarise a `.docx` /
`.xlsx` / `.pptx` file inside the project workspace. You should see two
tool calls in the trace:

1. `Skill(name="office-extract")` — returns the recipe with `{{SKILL_DIR}}`
   already expanded to the absolute path of this directory.
2. `Bash(command="python3 /abs/.../office-extract/scripts/extract.py <file>")`
   — produces plain text on stdout, which the model then summarises.

## Layout

```
office-extract/
  SKILL.md            # frontmatter + recipe; the LLM reads this
  scripts/extract.py  # the actual extractor
  README.md           # this file
```

`SKILL.md` is the manifest snaca's skill loader looks for. `scripts/` is a
convention — name it whatever you like and update the path in `SKILL.md`.

## Customising

- **Rename the skill.** Edit `SKILL.md`'s `name:` field. If you do, snaca's
  Read tool will still suggest the conventional name `office-extract` in its
  nudge string, so consider keeping the same name to avoid model confusion.
- **Swap libraries.** The dispatcher in `scripts/extract.py` is intentionally
  small. To switch to `markitdown`, `pandoc`, or a corporate extractor, edit
  the three `extract_*` functions — the dispatch table and stdout contract
  stay the same.
- **Tighten output cap.** Change `MAX_BYTES` in `scripts/extract.py` if your
  deployment uses a non-default Bash output cap.

## Why not parse OOXML in Rust?

The repo used to do this behind a `docx` Cargo feature (`zip` + `quick-xml`).
The skill route gives us xlsx and pptx for free, lets us pick best-of-breed
libraries per format, and pushes a non-trivial supply-chain (font tables,
charset decoders, formula evaluators) out of snaca core into operator
control. PDF stays in core because `pdf-extract` covers it well enough at low
dependency cost.
