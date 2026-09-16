# Bundled project templates

Starting points offered by **New from template** on the welcome screen. Each
directory is copied verbatim into the folder the user picks, which then opens
as a normal project.

## Acceptance rule

**Every template must compile offline with the bundled BusyTeX engine and no
remote endpoint.** A template that needs the network would strand a user who
clicked "New from template" on a plane — precisely the case the local
compiler exists for.

Verify after any change:

```bash
node scripts/verify-templates.mjs            # pdfTeX (default)
node scripts/verify-templates.mjs --engine xetex
```

The script compiles each template through the real WASM engine with
`remote_endpoint: ''` and exits non-zero on failure.

## Adding a template

1. Create `resources/templates/<id>/` with a `main.tex` (plus any assets).
2. Add an entry to `manifest.json` — `id` doubles as the i18n key
   (`templates.<id>.name` / `templates.<id>.description` in
   `src/renderer/src/locales/*.json`).
3. Run the verification script above.

No build-script change is needed: `electron-builder.json5` ships the whole
directory.

## Third-party files

`ieee/IEEEtran.cls` (v1.8b, Michael Shell) is redistributed under the LaTeX
Project Public License 1.3, whose terms are stated in the file header. It is
bundled rather than fetched because it is **not** part of the BusyTeX data
packages — only its `.bst` siblings are — so without it the IEEE template
cannot satisfy the offline rule above.
