# Bundled font licenses

The BusyTeX engine data package (`texlive-basic.data`) contains renamed clones
of the following freely licensed fonts, so that documents referencing common
system font names compile and render in the wasm engine:

| Clone family (internal name) | Base font | License | License file |
|---|---|---|---|
| SimSun, 宋体, FangSong, 仿宋, SimHei, 黑体, Microsoft YaHei, 微软雅黑, KaiTi, 楷体 | Fandol Song / Hei / Kai | GPL-3.0 with font embedding exception (statement in `fandol-README.txt`) | `gpl-3.0.txt`, `fandol-README.txt` |
| Times New Roman, Arial, Arial Unicode MS | TeX Gyre Termes / Heros | GUST Font License (GFL) | `texgyre-GFL.txt` |

Notes:

- The clones are renamed derivatives — this satisfies the Fandol reserved-name
  requirement; redistribution obligations are met by shipping the license
  files above (wired into electron-builder `extraResources` as
  `font-licenses/`).
- Rendering intent: CJK text renders with Fandol glyphs; Times-like text with
  TeX Gyre Termes (metrically compatible with Times New Roman).
- These fonts are only used INSIDE the wasm engine's virtual filesystem; the
  host application itself does not install them into the user's system.
