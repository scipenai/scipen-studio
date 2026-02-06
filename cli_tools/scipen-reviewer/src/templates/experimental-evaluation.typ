// ==========================================
// SciPen Experimental Evaluation Report
// Module: Experimental Agent
// ==========================================

// 1. Page Setup (Matches Comprehensive Template)
#set page(
  paper: "a4",
  margin: (left: 2.5cm, right: 2.5cm, top: 3cm, bottom: 3cm),
  header: context {
    set text(size: 9pt, fill: gray)
    grid(
      columns: (1fr, 1fr),
      align: (left, right),
      [Scipen AI Experimental Evaluation Agent],
      [Generated: {{date}}]
    )
    v(-8pt)
    line(length: 100%, stroke: 0.5pt + gray.lighten(50%))
  },
  footer: context {
    set text(size: 9pt, fill: gray)
    align(center)[
      #line(length: 100%, stroke: 0.5pt + gray.lighten(50%))
      #v(5pt)
      #counter(page).display() / #context counter(page).final().first()
    ]
  },
)

// 2. Color & Font Definitions
#let brand-color = rgb("#191970") // Deep Blue
#let section-color = rgb("#333333")
#let accent-color = rgb("#0066cc")
#let bg-soft = rgb("#f4f6f8") // Soft gray background
#let score-bg = rgb("#e6f0fa") // Light blue for scores

// Fonts
#set text(font: "New Computer Modern", size: 11pt)
#set par(justify: true, leading: 0.8em)
#set heading(numbering: none)

// 3. Styling Helpers

// Level 1 Headings
#show heading.where(level: 1): it => {
  set text(font: "New Computer Modern Sans", size: 14pt, weight: "bold", fill: brand-color)
  v(1em)
  block(
    stroke: (bottom: 1pt + accent-color),
    width: 100%,
    inset: (bottom: 0.3em),
    below: 0.8em
  )[#upper(it.body)]
}

// Level 2 Headings
#show heading.where(level: 2): it => {
  set text(font: "New Computer Modern Sans", size: 12pt, weight: "bold", fill: section-color)
  v(0.5em)
  it.body
  v(0.2em)
}

// List Styling
#set list(indent: 1em, marker: ([•], [‣]))
#set enum(indent: 1em)

// Helper for Score Badges
#let score-badge(label, value) = {
  block(
    width: 100%,
    inset: 8pt,
    fill: bg-soft,
    radius: 4pt,
    stroke: (left: 3pt + brand-color)
  )[
    #grid(
      columns: (1fr, auto),
      align: (left, right),
      [*#label*],
      [#text(fill: accent-color, weight: "bold")[#value]]
    )
  ]
}

// ==========================================
// Document Content
// ==========================================

// --- Title Block ---
#align(center)[
  #v(0.5cm)
  #block(
    fill: bg-soft,
    radius: 4pt,
    inset: 2em,
    width: 100%
  )[
    #text(size: 18pt, weight: "bold", fill: brand-color)[
      {{typst_escape paper_title}}
    ]
    #v(0.5cm)
    #text(size: 14pt, style: "italic", fill: section-color)[Experimental Evaluation Report]
    #v(0.5cm)
    #line(length: 50%, stroke: 0.5pt + gray)
    #v(0.3cm)
    #text(size: 10pt, fill: gray.darken(20%))[
      Review Focus: Methodology, Data Validity & Reproducibility \
      Report ID: {{report_id}} | Date: {{date}}
    ]
  ]
]

#v(1cm)

// ==========================================
// SECTION 1: QUALITATIVE ASSESSMENT (SCORECARD)
// ==========================================
= Experimental Quality Scorecard

// Grid layout for the scores defined in your Agent Prompt
#grid(
  columns: (1fr, 1fr),
  gutter: 1em,
  score-badge("Experimental Design", "{{score_design}}"),
  score-badge("Results Validity", "{{score_validity}}"),
  score-badge("Data Presentation", "{{score_presentation}}"),
  score-badge("Reproducibility", "{{score_reproducibility}}")
)

#v(0.5em)

// Overall Score Highlight
#block(
  width: 100%,
  inset: 1em,
  fill: brand-color.lighten(90%),
  radius: 4pt,
  stroke: 1pt + brand-color
)[
  #align(center)[
    #text(weight: "bold", size: 12pt, fill: brand-color)[Overall Experimental Quality: {{score_overall}}]
  ]
]

#v(0.5cm)

// ==========================================
// SECTION 2: DETAILED ANALYSIS
// ==========================================
= Detailed Analysis

== 1. Experimental Design Assessment
// Evaluation of methodology logic, completeness, control groups, and bias.
{{typst_escape analysis_design}}

== 2. Procedures & Parameters Completeness
// Analysis of experimental procedures and parameters documentation.
{{typst_escape procedures_completeness}}

== 3. Results Validity Analysis
// Analysis of statistical methods, outlier handling, significance, and confidence intervals.
{{typst_escape analysis_validity}}

== 4. Reproducibility Assessment
// Assessment of reproducibility, code/data availability, and methodology clarity.
{{typst_escape reproducibility_assessment}}

== 5. Data Presentation Quality
// Review of charts, graphs, labeling, and effective communication of findings.
{{typst_escape analysis_presentation}}

== 6. Table Organization & Formatting
// Analysis of table formatting, data organization, and clarity.
{{typst_escape table_organization}}

== 7. Experimental Consistency Evaluation
// Alignment check between experimental design, results, and theoretical claims.
{{typst_escape analysis_consistency}}

#v(0.5cm)

// ==========================================
// SECTION 3: KEY RECOMMENDATIONS
// ==========================================
= Key Recommendations

// Actionable feedback box
#block(
  fill: bg-soft,
  inset: (top: 1em, bottom: 1em, left: 1.5em, right: 1.5em),
  radius: 4pt,
  stroke: (left: 4pt + rgb("#d9534f")) // Reddish accent for 'Action needed'
)[
  {{#each recommendations}}
  + {{typst_escape this}}
  {{/each}}
]

// --- Footer Signature ---
#v(1fr)
#align(center)[
  #line(length: 100%, stroke: 0.5pt + gray)
  #v(0.3cm)
  #text(size: 10pt, style: "italic", fill: gray)[
    Evaluation conducted by Scipen AI Experimental Evaluation Agent
  ]
]
