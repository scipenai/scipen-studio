// ==========================================
// SciPen Paper Analysis Report
// Visual Style: Matches Comprehensive Review
// ==========================================

// 1. Page Setup (Identical to reference)
#set page(
  paper: "a4",
  margin: (left: 2.5cm, right: 2.5cm, top: 3cm, bottom: 3cm),
  header: context {
    set text(size: 9pt, fill: gray)
    grid(
      columns: (1fr, 1fr),
      align: (left, right),
      [Scipen AI Paper Analysis Agent],
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
#let bg-soft = rgb("#f4f6f8")
#let complexity-high = rgb("#cc4400")
#let complexity-med = rgb("#e6b800")
#let complexity-low = rgb("#2d8a2d")

#set text(font: "New Computer Modern", size: 11pt)
#set par(justify: true, leading: 0.8em)
#set heading(numbering: none)

// 3. Custom Styling Helpers

// Section Headings
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

// Subsection Headings
#show heading.where(level: 2): it => {
  set text(font: "New Computer Modern Sans", size: 12pt, weight: "bold", fill: section-color)
  v(0.5em)
  it.body
  v(0.2em)
}

// Key Value Box Helper
#let info-box(title, content) = block(
  fill: bg-soft,
  width: 100%,
  inset: 1em,
  radius: 4pt,
  stroke: (left: 3pt + brand-color)
)[
  #text(weight: "bold", fill: brand-color)[#title]: #content
]

#set list(indent: 1em, marker: ([•], [‣]))
#set enum(indent: 1em)

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
    #text(size: 14pt, style: "italic", fill: section-color)[Paper Analysis Report]
    #v(0.5cm)
    #line(length: 50%, stroke: 0.5pt + gray)
    #v(0.3cm)
    #text(size: 10pt, fill: gray.darken(20%))[
      Authors: {{typst_escape authors}} \
      Report ID: {{report_id}} | Date: {{date}}
    ]
  ]
]

#v(1cm)

// ==========================================
// SECTION 1: EXECUTIVE SUMMARY
// ==========================================
= Executive Summary

#block(stroke: (left: 3pt + gray.lighten(30%)), inset: (left: 1em))[
  {{typst_escape content_summary}}
]

#v(0.5cm)

// ==========================================
// SECTION 2: ABSTRACT & KEY FINDINGS
// ==========================================
= Abstract & Key Findings

#info-box("Abstract Summary", [{{typst_escape abstract_summary}}])

#v(0.5em)

#info-box("Key Findings", [{{typst_escape key_findings}}])

#v(0.5cm)

// ==========================================
// SECTION 3: KEY COMPONENT EXTRACTION
// ==========================================
= Key Components Extraction

#grid(
  columns: (1fr, 1fr),
  gutter: 1em,
  info-box("Introduction & Motivation", [{{typst_escape introduction_summary}}]),
  info-box("Research Objective", [{{typst_escape research_objective}}])
)

#v(0.5em)

#grid(
  columns: (1fr, 1fr),
  gutter: 1em,
  info-box("Methodology", [{{typst_escape methodology_summary}}]),
  info-box("Experimental Setup", [{{typst_escape experimental_setup}}])
)

#v(0.5em)

#grid(
  columns: (1fr, 1fr),
  gutter: 1em,
  info-box("Conclusions & Contributions", [{{typst_escape conclusions_contributions}}]),
  info-box("Related Work Overview", [{{typst_escape related_work_overview}}])
)

// ==========================================
// SECTION 4: INNOVATION ANALYSIS
// ==========================================
= Innovation & Contributions

Here we analyze the main innovations, distinguishing between incremental updates and breakthrough advances.

{{#each innovation_points}}
#block(below: 0.8em, breakable: true)[
  #text(fill: accent-color, weight: "bold", font: "New Computer Modern Sans")[‣ {{typst_escape this.type}}]

  {{typst_escape this.description}}
]
{{/each}}

// ==========================================
// SECTION 5: STRUCTURAL ANALYSIS
// ==========================================
= Structural Analysis

#grid(
  columns: (1fr, 1fr),
  gutter: 2em,
  [
    == Flow & Organization
    {{typst_escape structure_flow_analysis}}
  ],
  [
    == Coherence & Quality
    {{typst_escape structure_quality_analysis}}
  ]
)

#v(1em)

== Technical Clarity
{{typst_escape technical_clarity}}

#v(1em)

*Structural Observations:*
{{#each structure_observations}}
- {{typst_escape this}}
{{/each}}

// ==========================================
// SECTION 6: COMPLEXITY ASSESSMENT
// ==========================================
= Complexity Assessment

#block(
  fill: bg-soft,
  inset: 1.5em,
  radius: 4pt,
  width: 100%
)[
  #grid(
    columns: (auto, 1fr),
    gutter: 1em,
    align: (right, left),

    [*Technical Depth:*], [{{typst_escape complexity_technical_depth}}],
    [*Math Complexity:*], [{{typst_escape complexity_math_level}}],
    [*Experimental Sophistication:*], [{{typst_escape experimental_sophistication}}],
    [*Prerequisites:*], [{{typst_escape prerequisites}}]
  )

  #v(0.5em)
  #line(length: 100%, stroke: 0.5pt + gray)
  #v(0.5em)

  *Assessment Reasoning:* \
  {{typst_escape complexity_reasoning}}
]

// ==========================================
// SECTION 7: ANALYSIS CONCLUSION
// ==========================================
= Analysis Conclusion

#block(
  fill: accent-color.lighten(90%),
  stroke: (left: 4pt + accent-color),
  inset: 1em,
  radius: (right: 4pt)
)[
  {{typst_escape analysis_conclusion}}
]

// Section to note missing info
{{#if missing_information.length}}
#v(1em)
#text(size: 10pt, fill: gray)[
  *Note on Limitations:* The following information appeared to be missing or unclear in the source document:
]
{{#each missing_information}}
- {{typst_escape this}}
{{/each}}
{{/if}}

// --- Footer Signature ---
#v(1fr)
#align(center)[
  #line(length: 100%, stroke: 0.5pt + gray)
  #v(0.3cm)
  #text(size: 10pt, style: "italic", fill: gray)[
    Automated Analysis by Scipen AI Paper Analysis Agent
  ]
]
