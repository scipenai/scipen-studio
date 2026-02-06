// ==========================================
// SciPen Literature Review Assessment Report
// Based on Strict Compatibility Mode
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
#let bg-soft = rgb("#f4f6f8") // Soft gray background
#let score-bg = rgb("#e6f0ff") // Light blue for score

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

// Compact Lists
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
    #text(size: 14pt, style: "italic", fill: section-color)[Literature Review Assessment]
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
// SECTION 0: EXECUTIVE SUMMARY
// ==========================================
= Executive Summary

#block(
  stroke: (left: 3pt + accent-color),
  inset: (left: 1em, top: 0.5em, bottom: 0.5em),
  width: 100%
)[
  {{typst_escape evaluation_summary}}
]

#v(0.8cm)

// ==========================================
// EVALUATION METRICS
// ==========================================
#block(
  fill: bg-soft,
  inset: 1.2em,
  radius: 4pt,
  width: 100%
)[
  #grid(
    columns: (1fr, 1fr, 2fr),
    gutter: 1.5em,
    align: (center, center, left),
    [
      #block(
        fill: score-bg,
        radius: 4pt,
        inset: 1em,
        width: 100%
      )[
        #align(center)[
          #text(size: 9pt, weight: "bold", fill: brand-color)[Overall Rating] \
          #v(0.3em)
          #text(size: 18pt, weight: "bold", fill: accent-color)[{{completeness_rating}}]
        ]
      ]
    ],
    [
      #block(
        fill: white,
        stroke: 1pt + gray.lighten(50%),
        radius: 4pt,
        inset: 1em,
        width: 100%
      )[
        #align(center)[
          #text(size: 9pt, weight: "bold", fill: brand-color)[Completeness Tier] \
          #v(0.3em)
          #text(size: 16pt, weight: "bold", fill: section-color)[{{completeness_tier.tier}} / 5] \
          #v(0.2em)
          #text(size: 8pt, fill: gray.darken(20%))[{{completeness_tier.tier_name}}]
        ]
      ]
    ],
    [
      #text(size: 10pt, weight: "bold", fill: section-color)[Tier Justification:] \
      #v(0.2em)
      #text(size: 9pt)[{{typst_escape completeness_tier.justification}}]
    ]
  )
]

#v(0.5cm)

// ==========================================
// SECTION 1: QUALITY DIMENSIONS ANALYSIS
// ==========================================
= Quality Dimension Analysis

// Structured analysis of the 5 dimensions required by the prompt
#stack(dir: ttb, spacing: 1em,
  // 1. Completeness
  block(width: 100%, breakable: true)[
    #text(weight: "bold", fill: section-color)[1. Completeness (Coverage Breadth)] \
    {{typst_escape quality_completeness}}
  ],
  // 2. Accuracy
  block(width: 100%, breakable: true)[
    #text(weight: "bold", fill: section-color)[2. Accuracy & Attribution] \
    {{typst_escape quality_accuracy}}
  ],
  // 3. Logic
  block(width: 100%, breakable: true)[
    #text(weight: "bold", fill: section-color)[3. Logic & Organization] \
    {{typst_escape quality_logic}}
  ],
  // 4. Positioning
  block(width: 100%, breakable: true)[
    #text(weight: "bold", fill: section-color)[4. Gap Positioning] \
    {{typst_escape quality_positioning}}
  ],
  // 5. Timeliness
  block(width: 100%, breakable: true)[
    #text(weight: "bold", fill: section-color)[5. Timeliness] \
    {{typst_escape quality_timeliness}}
  ]
)

// ==========================================
// SECTION 2: MISSING LITERATURE
// ==========================================
= Critical Missing Literature

// Loop for displaying papers found by AMiner but missing in manuscript
{{#if missing_literature.length}}
_The following highly relevant works were identified via AMiner but appear to be missing from the current draft:_

#v(0.5em)

{{#each missing_literature}}
#block(
  fill: bg-soft,
  inset: 1em,
  radius: 4pt,
  below: 1.2em,
  width: 100%,
  breakable: true
)[
  // Title
  #text(weight: "bold", size: 11pt, fill: brand-color)[{{typst_escape this.title}}]
  #v(0.3em)

  // Authors
  #text(size: 10pt, style: "italic")[{{#each this.authors}}{{this.name}}{{#unless @last}}, {{/unless}}{{/each}} ({{this.year}})]

  {{#if this.venue}}
  #v(0.2em)
  #text(size: 9pt, fill: gray.darken(20%))[*Venue:* {{typst_escape this.venue}}]
  {{/if}}

  {{#if this.citations}}
  #h(1em)
  #text(size: 9pt, fill: accent-color)[*Citations:* {{this.citations}}]
  {{/if}}

  {{#if this.abstract}}
  #v(0.4em)
  #block(
    stroke: (left: 2pt + gray.lighten(50%)),
    inset: (left: 0.8em, top: 0.3em, bottom: 0.3em),
    width: 100%
  )[
    #text(size: 9pt, fill: gray.darken(30%))[{{typst_escape this.abstract}}]
  ]
  {{/if}}

  {{#if this.keywords.length}}
  #v(0.3em)
  #text(size: 8pt, fill: gray)[*Keywords:* {{#each this.keywords}}#box(fill: gray.lighten(80%), inset: 3pt, radius: 2pt)[{{typst_escape this}}]#h(4pt){{/each}}]
  {{/if}}

  #v(0.3em)
  #text(size: 10pt)[*Relevance:* {{typst_escape this.relevance_explanation}}]

  {{#if this.doi}}
  #v(0.2em)
  #text(size: 8pt, fill: accent-color)[DOI: {{this.doi}}]
  {{/if}}
]
{{/each}}

#v(0.5em)
#text(size: 9pt, fill: gray)[*Note:* A full BibTeX file (related-literature.bib) containing these entries has been generated.]
{{else}}
_No critical missing literature identified._
{{/if}}

// ==========================================
// SECTION 3: STRENGTHS & WEAKNESSES
// ==========================================
= Assessment Findings

#grid(
  columns: (1fr, 1fr),
  gutter: 1.5em,
  [
    == Strengths
    {{#each strength_points}}
    - {{typst_escape this}}
    {{/each}}
  ],
  [
    == Weaknesses
    {{#each weakness_points}}
    - {{typst_escape this}}
    {{/each}}
  ]
)

// ==========================================
// SECTION 4: IMPROVEMENT RECOMMENDATIONS
// ==========================================
= Actionable Recommendations

#block(
  fill: accent-color.lighten(90%),
  stroke: (left: 4pt + accent-color),
  inset: 1em,
  radius: (right: 4pt)
)[
  {{#each improvement_recommendations}}
  + {{typst_escape this}}
  {{/each}}
]

// --- Footer Signature ---
#v(1fr)
#align(center)[
  #line(length: 100%, stroke: 0.5pt + gray)
  #v(0.3cm)
  #text(size: 10pt, style: "italic", fill: gray)[
    Literature analysis conducted by Scipen AI Agent via AMiner
  ]
]