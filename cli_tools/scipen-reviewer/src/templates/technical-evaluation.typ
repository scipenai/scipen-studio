// ==========================================
// SciPen Technical Evaluation Report
// Module: Technical & Mathematical Rigor
// ==========================================

// 1. Page Setup (Matches Consolidated Report)
#set page(
  paper: "a4",
  margin: (left: 2.5cm, right: 2.5cm, top: 3cm, bottom: 3cm),
  header: context {
    set text(size: 9pt, fill: gray)
    grid(
      columns: (1fr, 1fr),
      align: (left, right),
      [Scipen Technical Evaluation Agent],
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
#let alert-color = rgb("#cc4400") // For flaws
#let success-color = rgb("#2d8a2d") // For innovation/recommendations
#let bg-soft = rgb("#f4f6f8")

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

// Helper for Innovation Level Badge
#let innovation-badge(level) = {
  let bg = if level == "Exceptional" { rgb("#1a5f1a") } else if level == "Strong" { rgb("#2d8a2d") } else if level == "Competent" { rgb("#0066cc") } else if level == "Adequate" { rgb("#cc8800") } else { rgb("#cc4400") }
  box(
    fill: bg,
    radius: 4pt,
    inset: (x: 8pt, y: 4pt),
    outset: 0pt
  )[
    #text(fill: white, weight: "bold", size: 10pt)[Innovation: #level]
  ]
}

// Standard Lists
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
    #text(size: 14pt, style: "italic", fill: section-color)[Technical Evaluation Report]
    #v(0.5cm)
    #line(length: 50%, stroke: 0.5pt + gray)
    #v(0.3cm)
    #text(size: 10pt, fill: gray.darken(20%))[
      Focus: Mathematical Rigor & Methodology \
      Report ID: {{report_id}} | Date: {{date}}
    ]
  ]
]

#v(1cm)

// ==========================================
// 1. EXECUTIVE TECHNICAL SUMMARY
// ==========================================
= Executive Technical Summary

#block(stroke: (left: 3pt + brand-color), inset: (left: 1em))[
  {{typst_escape technical_summary}}
]

#v(0.5cm)

// ==========================================
// 2. MATHEMATICAL CORRECTNESS
// Reference: Agent Prompt "Verify Mathematical Correctness"
// ==========================================
= Mathematical Correctness Verification

// Introduction/Overview of Math Check
{{typst_escape math_correctness_overview}}

// Detailed breakdown if specific issues are found
{{#if math_issues}}
  #v(0.5em)
  #text(weight: "bold", fill: section-color)[Detailed Findings:]
  #block(below: 1em, breakable: true)[
    {{#each math_issues}}
    #block(fill: bg-soft, radius: 2pt, inset: 0.8em, width: 100%, below: 0.8em)[
      #text(weight: "bold", font: "New Computer Modern Sans", fill: brand-color)[{{typst_escape this.issue_title}}] \
      {{typst_escape this.description}}
    ]
    {{/each}}
  ]
{{/if}}

#v(0.5cm)

// ==========================================
// 2.5. THEORETICAL FOUNDATIONS
// Reference: Agent Prompt "Evaluate the rigor of theoretical arguments"
// ==========================================
== Theoretical Foundations Assessment

#block(
  fill: bg-soft,
  inset: 1em,
  radius: 4pt,
  width: 100%
)[
  {{typst_escape theoretical_foundations}}
]

// ==========================================
// 3. METHODOLOGICAL INNOVATION
// Reference: Agent Prompt "Assess Methodological Innovation"
// ==========================================
= Methodological Innovation Assessment

#grid(
  columns: (1fr, auto),
  gutter: 1em,
  align: (left + horizon, right + top),
  [
    The following assessment evaluates the novelty, practicality, and significance of the proposed methods against existing literature.
  ],
  [
    #innovation-badge("{{innovation_level}}")
  ]
)

{{typst_escape methodology_analysis}}

// ==========================================
// 4. IDENTIFIED TECHNICAL FLAWS
// Reference: Agent Prompt "Identify Technical Flaws"
// ==========================================
= Identified Technical Flaws

// Using red accents to highlight flaws as per the agent's critical nature
{{#each technical_flaws}}
#block(below: 1em, breakable: true)[
  #grid(
    columns: (auto, 1fr),
    gutter: 0.8em,
    [#text(fill: alert-color, size: 14pt)[!]], 
    [
      #text(fill: alert-color, weight: "bold", font: "New Computer Modern Sans")[{{typst_escape this.title}}] \
      {{typst_escape this.description}}
    ]
  )
]
{{/each}}

// ==========================================
// 5. CONSTRUCTIVE RECOMMENDATIONS
// Reference: Agent Prompt "Provide Constructive Recommendations"
// ==========================================
= Constructive Recommendations

// Helper for priority badge
#let priority-badge(priority) = {
  let bg = if priority == "High" { rgb("#cc4400").lighten(80%) } else if priority == "Medium" { rgb("#cc8800").lighten(80%) } else { rgb("#888888").lighten(80%) }
  let fg = if priority == "High" { rgb("#cc4400") } else if priority == "Medium" { rgb("#cc8800") } else { rgb("#666666") }
  box(
    fill: bg,
    radius: 3pt,
    inset: (x: 6pt, y: 2pt)
  )[#text(fill: fg, weight: "bold", size: 8pt)[#priority]]
}

// Actionable suggestions with priority indicators
#block(
  fill: bg-soft,
  stroke: (left: 3pt + success-color),
  inset: 1em,
  radius: (right: 4pt)
)[
  {{#each recommendations}}
  #block(below: 0.8em)[
    #grid(
      columns: (auto, 1fr),
      gutter: 0.5em,
      [#priority-badge("{{this.priority}}")],
      [#strong[{{typst_escape this.action_item}}]]
    )
    #v(0.2em)
    {{typst_escape this.details}}
  ]
  {{/each}}
]

// --- Footer Signature ---
#v(1fr)
#align(center)[
  #line(length: 100%, stroke: 0.5pt + gray)
  #v(0.3cm)
  #text(size: 9pt, style: "italic", fill: gray)[
    Evaluation generated by Scipen Technical Evaluation Agent
  ]
]