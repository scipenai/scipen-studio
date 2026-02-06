// ==========================================
// SciPen Academic Paper Review Report
// Improved Visuals - Strict Compatibility Mode
// ==========================================

// 1. Page Setup
#set page(
  paper: "a4",
  margin: (left: 2.5cm, right: 2.5cm, top: 3cm, bottom: 3cm),
  header: context {
    set text(size: 9pt, fill: gray)
    grid(
      columns: (1fr, 1fr),
      align: (left, right),
      [Scipen AI Review System],
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
#let bg-soft = rgb("#f4f6f8") // Soft gray background for boxes

// Using standard fonts ensuring compatibility with most environments
#set text(font: "New Computer Modern", size: 11pt)
#set par(justify: true, leading: 0.8em)
#set heading(numbering: none)

// 3. Custom Styling Helpers

// Style for Level 1 Headings (Sections)
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

// Style for Level 2 Headings (Subsections)
#show heading.where(level: 2): it => {
  set text(font: "New Computer Modern Sans", size: 12pt, weight: "bold", fill: section-color)
  v(0.5em)
  it.body
  v(0.2em)
}

// Custom List Styling (More compact)
#set list(indent: 1em, marker: ([•], [‣]))
#set enum(indent: 1em)

// ==========================================
// Document Content
// ==========================================

// --- Title Block (Enhanced Visuals, Same Data) ---
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
    #text(size: 14pt, style: "italic", fill: section-color)[Scipen AI Review System]
    #v(0.5cm)
    #line(length: 50%, stroke: 0.5pt + gray)
    #v(0.3cm)
    #text(size: 10pt, fill: gray.darken(20%))[
      Research Area: #strong[{{typst_escape research_area}}] \
      Report ID: {{report_id}} | Date: {{date}}
    ]
  ]
]

#v(1cm)

// ==========================================
// SECTION 1: SUMMARY
// ==========================================
= Summary

// Added a side border to make the summary stand out
#block(stroke: (left: 3pt + gray.lighten(30%)), inset: (left: 1em))[
{{typst_escape executive_summary}}
]

#v(0.5cm)

// ==========================================
// SECTION 1.5: SUB-AGENT EVALUATION SCORES
// ==========================================
#block(
  fill: bg-soft,
  inset: 1em,
  radius: 4pt,
  width: 100%
)[
  #text(weight: "bold", fill: section-color)[Sub-Agent Evaluation Summary]
  #v(0.5em)
  #grid(
    columns: (1fr, 1fr),
    gutter: 1em,
    [
      #text(size: 10pt)[*Experimental Quality:* {{typst_escape sub_agent_scores.experimental_quality}}] \
      #text(size: 10pt)[*Technical Innovation:* {{typst_escape sub_agent_scores.technical_innovation}}]
    ],
    [
      #text(size: 10pt)[*Literature Completeness:* {{typst_escape sub_agent_scores.literature_completeness}}] \
      #text(size: 10pt)[*English Quality:* {{typst_escape sub_agent_scores.english_quality}}]
    ]
  )
]

#v(0.5cm)

// ==========================================
// SECTION 2: STRENGTHS
// ==========================================
= Strengths

// NOTE: Loop logic is identical to original, just added visual styling around title
{{#each strength_categories}}
#block(below: 0.8em, breakable: true)[
  #text(fill: rgb("#2d8a2d"), weight: "bold", font: "New Computer Modern Sans")[{{typst_escape this.title}}]
  {{#each this.items}}
  - {{typst_escape this}}
  {{/each}}
]
{{/each}}

// ==========================================
// SECTION 3: WEAKNESSES
// ==========================================
= Weaknesses

{{#each weakness_categories}}
#block(below: 0.8em, breakable: true)[
  #text(fill: rgb("#cc4400"), weight: "bold", font: "New Computer Modern Sans")[{{typst_escape this.title}}]
  {{#each this.items}}
  - {{typst_escape this}}
  {{/each}}
]
{{/each}}

// ==========================================
// SECTION 4: DETAILED COMMENTS
// ==========================================
= Detailed Comments

== Technical Soundness Evaluation
{{typst_escape technical_soundness_detailed}}

== Experimental Evaluation Assessment
{{typst_escape experimental_evaluation_detailed}}

== Comparison with Related Work
{{typst_escape related_work_comparison}}

== Broader Impact and Significance
{{typst_escape broader_impact_discussion}}

// ==========================================
// SECTION 5: QUESTIONS FOR AUTHORS
// ==========================================
= Questions for Authors

#block(fill: bg-soft, inset: 1em, radius: 4pt)[
{{#each questions_for_authors}}
+ {{typst_escape this}}
{{/each}}
]

#v(0.5cm)

// ==========================================
// SECTION 6: OVERALL ASSESSMENT
// ==========================================
= Overall Assessment

#block(
  fill: accent-color.lighten(90%),
  stroke: (left: 4pt + accent-color),
  inset: 1em,
  radius: (right: 4pt)
)[
  {{typst_escape overall_assessment_paragraph}}
]

// --- Footer Signature ---
#v(1fr)
#align(center)[
  #line(length: 100%, stroke: 0.5pt + gray)
  #v(0.3cm)
  #text(size: 10pt, style: "italic", fill: gray)[
    Review conducted by Scipen AI Review System
  ]
  #linebreak()
  #link("https://scipen.ai/")[
    #text(fill: accent-color)[https://scipen.ai/]
  ]
]