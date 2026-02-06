// ==========================================
// SciPen English Quality Assessment Report
// Visual Style: Strict Compatibility with Main System
// Covers Agent Steps: 1.Grammar, 2.Structure, 3.Vocabulary, 4.Style, 5.Fluency
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
      [Scipen AI English Review System],
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
#let brand-color = rgb("#191970") // Deep Blue (Main Brand)
#let section-color = rgb("#333333")
#let accent-color = rgb("#0066cc")
#let bg-soft = rgb("#f4f6f8") // Soft gray background

// Specialized Colors for Language Differences
#let diff-red-bg = rgb("#fff5f5")
#let diff-green-bg = rgb("#f0fff4")
#let text-red = rgb("#cc0000")
#let text-green = rgb("#008800")

// Fonts
#set text(font: "New Computer Modern", size: 11pt)
#set par(justify: true, leading: 0.8em)
#set heading(numbering: none)

// 3. Custom Styling Helpers

// Heading Level 1
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

// Heading Level 2
#show heading.where(level: 2): it => {
  set text(font: "New Computer Modern Sans", size: 12pt, weight: "bold", fill: section-color)
  v(0.8em)
  it.body
  v(0.3em)
}

// Custom List Styling
#set list(indent: 1em, marker: ([•], [‣]))

// --- UI Components for Language Analysis ---

// Helper: Grammar Correction Item (Cross & Check)
#let grammar-item(original, correction, explanation) = {
  block(below: 1em, breakable: true)[
    #grid(
      columns: (1.5em, 1fr),
      gutter: 0em,
      text(fill: text-red, weight: "bold")[×],
      text(fill: gray.darken(20%))[#strike[#original]]
    )
    #v(-0.3em)
    #grid(
      columns: (1.5em, 1fr),
      gutter: 0em,
      text(fill: text-green, weight: "bold")[✓],
      text(weight: "bold", fill: section-color)[#correction]
    )
    #pad(left: 1.5em, top: 0.3em)[
      #text(size: 9pt, style: "italic", fill: accent-color)[#explanation]
    ]
  ]
}

// Helper: Sentence Comparison Box (Side by Side)
#let comparison-box(original, revised, rationale) = {
  block(breakable: true, below: 1.2em)[
    #grid(
      columns: (1fr, 1fr),
      gutter: 0.8em,
      block(fill: diff-red-bg, inset: 8pt, radius: 4pt, width: 100%)[
        #text(weight: "bold", size: 8pt, fill: text-red)[ORIGINAL] \
        #v(0.2em)
        #text(size: 10pt)[#original]
      ],
      block(fill: diff-green-bg, inset: 8pt, radius: 4pt, width: 100%)[
        #text(weight: "bold", size: 8pt, fill: text-green)[REVISED] \
        #v(0.2em)
        #text(size: 10pt)[#revised]
      ]
    )
    #v(0.4em)
    #text(size: 9pt, fill: gray.darken(40%))[*Rationale:* #rationale]
    #line(length: 100%, stroke: 0.5pt + gray.lighten(70%))
  ]
}

// Helper: Vocabulary Arrow Item
#let vocab-item(original, better, reason) = {
  block(below: 0.6em, fill: bg-soft, inset: 0.6em, radius: 3pt, width: 100%)[
    #grid(
      columns: (auto, auto, 1fr),
      gutter: 0.6em,
      align: horizon,
      text(fill: text-red)[*#original*],
      text(fill: gray)[$arrow.r$],
      text(fill: text-green)[*#better*]
    )
    #v(0.2em)
    #text(size: 9pt, style: "italic", fill: gray.darken(30%))[#reason]
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
    #text(size: 14pt, style: "italic", fill: section-color)[English Quality Assessment Report]
    #v(0.5cm)
    #line(length: 50%, stroke: 0.5pt + gray)
    #v(0.3cm)
    #text(size: 10pt, fill: gray.darken(20%))[
      Report ID: {{report_id}} | Date: {{date}}
    ]
  ]
]

#v(1cm)

// ==========================================
// SECTION 1: EXECUTIVE SUMMARY
// Overview of English quality
// ==========================================
= Executive Summary

#block(stroke: (left: 3pt + brand-color), inset: (left: 1em))[
{{typst_escape executive_summary}}
]

#v(0.5cm)
*Key Areas of Concern:*
{{#each key_areas_of_concern}}
- {{typst_escape this}}
{{/each}}

#v(0.5cm)

// ==========================================
// SECTION 2: GRAMMAR & SYNTAX (Agent Step 1)
// ==========================================
= Grammar & Syntax Corrections

Detailed analysis of grammatical errors, punctuation issues, and subject-verb agreement problems.

#v(0.5em)

{{#each grammar_corrections}}
#grammar-item(
  "{{typst_escape this.original}}",
  "{{typst_escape this.correction}}",
  "{{typst_escape this.explanation}}"
)
{{/each}}

// ==========================================
// SECTION 3: SENTENCE STRUCTURE (Agent Step 2)
// ==========================================
= Sentence Structure Optimization

Refinement of complex sentences to enhance clarity, rhythm, and readability.

#v(0.5em)

{{#each sentence_improvements}}
#comparison-box(
  "{{typst_escape this.original}}",
  "{{typst_escape this.revised}}",
  "{{typst_escape this.rationale}}"
)
{{/each}}

// ==========================================
// SECTION 4: REDUNDANCY & WORDINESS
// ==========================================
= Redundancy & Wordiness

Identification and elimination of redundant phrases and wordy expressions.

#v(0.5em)

{{#each redundancy_issues}}
#comparison-box(
  "{{typst_escape this.original}}",
  "{{typst_escape this.revised}}",
  "{{typst_escape this.explanation}}"
)
{{/each}}

// ==========================================
// SECTION 5: FLUENCY & FLOW (Agent Step 5)
// ==========================================
= Fluency & Flow

Suggestions to improve transitions between paragraphs and the logical flow of ideas.

== Paragraph Organization
{{typst_escape paragraph_organization}}

#v(0.5em)

== Narrative Flow
{{typst_escape narrative_flow}}

#v(0.5em)

== Specific Suggestions
{{#each fluency_suggestions}}
#block(below: 0.8em)[
  *{{typst_escape this.category}}:*
  {{typst_escape this.suggestion}}
]
{{/each}}

// ==========================================
// SECTION 6: STYLE & VOCABULARY (Agent Steps 3 & 4)
// ==========================================
= Academic Style & Vocabulary

== Vocabulary Enhancements
Improvements for precision and academic tone (replacing colloquialisms).

{{#each vocabulary_improvements}}
#vocab-item(
  "{{typst_escape this.original}}",
  "{{typst_escape this.better_term}}",
  "{{typst_escape this.reason}}"
)
{{/each}}

== Terminology Consistency
Ensuring consistent use of technical terms throughout the paper.

{{#each terminology_consistency}}
#block(below: 0.8em, fill: bg-soft, inset: 0.8em, radius: 4pt)[
  *Term:* {{typst_escape this.term}} \
  *Variations Found:* {{typst_escape this.variations_found}} \
  *Recommended:* #text(fill: text-green, weight: "bold")[{{typst_escape this.recommended}}]
]
{{/each}}

== Weak Modifiers
Identification of vague or weak modifiers that should be strengthened.

{{#each weak_modifiers}}
#block(below: 0.8em)[
  #text(size: 10pt, fill: gray.darken(20%))[#emph["{{typst_escape this.original}}"]]
  #v(0.2em)
  *Weak term:* #text(fill: text-red)[{{typst_escape this.weak_term}}] $arrow.r$ *Suggestion:* #text(fill: text-green)[{{typst_escape this.suggestion}}]
]
{{/each}}

== Tone & Style Compliance
Adjustments regarding objectivity, passive voice, and formal conventions.

#block(fill: bg-soft, inset: 1em, radius: 4pt)[
  *Summary:* {{typst_escape style_compliance_summary}}

  #v(0.5em)
  {{#each style_points}}
  - *{{typst_escape this.point}}:* {{typst_escape this.description}}
  {{/each}}
]

// ==========================================
// SECTION 7: CITATION FORMATTING
// ==========================================
= Citation & Reference Formatting

{{typst_escape citation_formatting}}

// --- Footer Signature ---
#v(1fr)
#align(center)[
  #line(length: 100%, stroke: 0.5pt + gray)
  #v(0.3cm)
  #text(size: 10pt, style: "italic", fill: gray)[
    Review conducted by Scipen AI English Review System
  ]
]
