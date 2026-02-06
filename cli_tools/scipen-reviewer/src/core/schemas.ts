/**
 * @file schemas.ts - JSON Schema definitions
 * @description JSON schemas for SDK structured output
 * @depends None
 */

/**
 * Review report JSON Schema
 */
export const reviewDataSchema = {
  type: 'object',
  properties: {
    paper_title: {
      type: 'string',
      description: 'Exact paper title from the file'
    },
    research_area: {
      type: 'string',
      description: 'Primary research area, e.g., Machine Learning, Computer Vision'
    },
    executive_summary: {
      type: 'string',
      description: '2-3 paragraphs: problem, approach, contributions, results. Example: "The paper introduces X, a Y that... Core contributions are [1]..., [2]..., [3].... Experiments on..."'
    },
    strength_categories: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Category name, e.g., "Technical novelty and innovation", "Experimental rigor and validation"'
          },
          items: {
            type: 'array',
            items: {
              type: 'string',
              description: 'Specific strength with evidence (complete sentence)'
            },
            minItems: 2,
            description: 'List of specific strengths in this category (at least 2 items per category)'
          }
        },
        required: ['title', 'items'],
        additionalProperties: false
      },
      minItems: 3,
      description: '3-4 major categories of strengths, each with at least 2 specific items'
    },
    weakness_categories: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Category name, e.g., "Technical limitations or concerns", "Experimental gaps"'
          },
          items: {
            type: 'array',
            items: {
              type: 'string',
              description: 'Specific weakness with explanation (complete sentence)'
            },
            minItems: 2,
            description: 'List of specific weaknesses in this category (at least 2 items per category)'
          }
        },
        required: ['title', 'items'],
        additionalProperties: false
      },
      minItems: 3,
      description: '3-4 major categories of weaknesses, each with at least 2 specific items'
    },
    technical_soundness_detailed: {
      type: 'string',
      description: '4-6 sentences analyzing mathematical correctness, architectural design, theoretical foundations, innovation'
    },
    experimental_evaluation_detailed: {
      type: 'string',
      description: '4-6 sentences covering experimental design, baselines, statistical validity, reproducibility'
    },
    related_work_comparison: {
      type: 'string',
      description: '4-6 sentences discussing positioning in literature, how work extends/fills gaps, connections to related approaches'
    },
    broader_impact_discussion: {
      type: 'string',
      description: '4-6 sentences addressing potential impact, practical applications, limitations, generalizability, future directions'
    },
    questions_for_authors: {
      type: 'array',
      items: {
        type: 'string'
      },
      description: '6-8 questions seeking clarification, probing decisions, requesting experiments, asking about costs/scalability'
    },
    overall_assessment_paragraph: {
      type: 'string',
      description: '4-6 sentences: summarize strengths, acknowledge limitations, balanced recommendation, significance statement, final decision. Example: "This paper presents a... The work convincingly demonstrates... While..., the contributions are... I recommend..."'
    },
    sub_agent_scores: {
      type: 'object',
      properties: {
        experimental_quality: {
          type: 'string',
          description: 'Overall score from experimental evaluator: Exceptional/Strong/Competent/Adequate/Flawed'
        },
        technical_innovation: {
          type: 'string',
          description: 'Innovation level from technical evaluator: Exceptional/Strong/Competent/Adequate/Flawed'
        },
        literature_completeness: {
          type: 'string',
          description: 'Completeness rating from literature reviewer: Exceptional/Strong/Competent/Adequate/Flawed'
        },
        english_quality: {
          type: 'string',
          description: 'Overall English quality assessment: Good/Acceptable/Needs Improvement'
        }
      },
      required: ['experimental_quality', 'technical_innovation', 'literature_completeness', 'english_quality'],
      additionalProperties: false,
      description: 'Summary of qualitative assessments from sub-agent evaluations'
    },
  },
  required: [
    'paper_title',
    'research_area',
    'executive_summary',
    'strength_categories',
    'weakness_categories',
    'technical_soundness_detailed',
    'experimental_evaluation_detailed',
    'related_work_comparison',
    'broader_impact_discussion',
    'questions_for_authors',
    'overall_assessment_paragraph',
    'sub_agent_scores'
  ],
  additionalProperties: false
} as const;

/**
 * ReviewData type definition
 */
export interface ReviewData {
  paper_title: string;
  research_area: string;
  executive_summary: string;
  strength_categories: Array<{
    title: string;
    items: string[];
  }>;
  weakness_categories: Array<{
    title: string;
    items: string[];
  }>;
  technical_soundness_detailed: string;
  experimental_evaluation_detailed: string;
  related_work_comparison: string;
  broader_impact_discussion: string;
  questions_for_authors: string[];
  overall_assessment_paragraph: string;
  sub_agent_scores: {
    experimental_quality: string;
    technical_innovation: string;
    literature_completeness: string;
    english_quality: string;
  };
}

/**
 * English quality assessment JSON Schema
 * Corresponds to template: english-quality.typ
 */
export const englishQualitySchema = {
  type: 'object',
  properties: {
    paper_title: {
      type: 'string',
      description: 'Exact paper title from the file'
    },
    executive_summary: {
      type: 'string',
      description: '2-3 sentences summarizing the overall English quality of the paper'
    },
    key_areas_of_concern: {
      type: 'array',
      items: { type: 'string' },
      description: 'List of 3-5 key areas that need improvement'
    },
    grammar_corrections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          original: {
            type: 'string',
            description: 'Original text with grammatical error'
          },
          correction: {
            type: 'string',
            description: 'Corrected version of the text'
          },
          explanation: {
            type: 'string',
            description: 'Brief explanation of the grammatical issue'
          }
        },
        required: ['original', 'correction', 'explanation'],
        additionalProperties: false
      },
      description: 'List of 5-10 specific grammar corrections with explanations'
    },
    sentence_improvements: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          original: {
            type: 'string',
            description: 'Original sentence that needs improvement'
          },
          revised: {
            type: 'string',
            description: 'Improved version of the sentence'
          },
          rationale: {
            type: 'string',
            description: 'Explanation of why the revision improves the sentence'
          }
        },
        required: ['original', 'revised', 'rationale'],
        additionalProperties: false
      },
      description: 'List of 5-8 sentence structure improvements'
    },
    redundancy_issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          original: {
            type: 'string',
            description: 'Original redundant or wordy text'
          },
          revised: {
            type: 'string',
            description: 'Concise version'
          },
          explanation: {
            type: 'string',
            description: 'Explanation of the redundancy'
          }
        },
        required: ['original', 'revised', 'explanation'],
        additionalProperties: false
      },
      description: 'List of 3-5 redundancy and wordiness issues with corrections'
    },
    fluency_suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            description: 'Category of fluency issue, e.g., "Transition", "Paragraph Flow", "Logical Connection", "Narrative Flow"'
          },
          suggestion: {
            type: 'string',
            description: 'Specific suggestion for improving fluency'
          }
        },
        required: ['category', 'suggestion'],
        additionalProperties: false
      },
      description: 'List of 4-6 fluency and flow suggestions'
    },
    paragraph_organization: {
      type: 'string',
      description: '2-3 sentences assessing paragraph organization and coherence'
    },
    narrative_flow: {
      type: 'string',
      description: '2-3 sentences assessing the overall narrative flow and story arc of the paper'
    },
    vocabulary_improvements: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          original: {
            type: 'string',
            description: 'Original word or phrase'
          },
          better_term: {
            type: 'string',
            description: 'More appropriate academic term'
          },
          reason: {
            type: 'string',
            description: 'Why the replacement is better'
          }
        },
        required: ['original', 'better_term', 'reason'],
        additionalProperties: false
      },
      description: 'List of 5-8 vocabulary improvements for academic tone'
    },
    terminology_consistency: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          term: {
            type: 'string',
            description: 'The term with inconsistent usage'
          },
          variations_found: {
            type: 'string',
            description: 'Different variations found in the paper'
          },
          recommended: {
            type: 'string',
            description: 'Recommended consistent term to use'
          }
        },
        required: ['term', 'variations_found', 'recommended'],
        additionalProperties: false
      },
      description: 'List of 2-4 terminology consistency issues'
    },
    weak_modifiers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          original: {
            type: 'string',
            description: 'Sentence with weak or vague modifier'
          },
          weak_term: {
            type: 'string',
            description: 'The weak or vague modifier identified'
          },
          suggestion: {
            type: 'string',
            description: 'Suggested stronger or more precise alternative'
          }
        },
        required: ['original', 'weak_term', 'suggestion'],
        additionalProperties: false
      },
      description: 'List of 3-5 weak or vague modifiers with improvements'
    },
    style_compliance_summary: {
      type: 'string',
      description: '2-3 sentences summarizing the paper\'s compliance with academic style conventions'
    },
    style_points: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          point: {
            type: 'string',
            description: 'Style aspect, e.g., "Objectivity", "Passive Voice", "Hedging Language"'
          },
          description: {
            type: 'string',
            description: 'Assessment of this style aspect'
          }
        },
        required: ['point', 'description'],
        additionalProperties: false
      },
      description: 'List of 3-5 style compliance points'
    },
    citation_formatting: {
      type: 'string',
      description: '2-3 sentences assessing citation and reference formatting consistency and correctness'
    }
  },
  required: [
    'paper_title',
    'executive_summary',
    'key_areas_of_concern',
    'grammar_corrections',
    'sentence_improvements',
    'redundancy_issues',
    'fluency_suggestions',
    'paragraph_organization',
    'narrative_flow',
    'vocabulary_improvements',
    'terminology_consistency',
    'weak_modifiers',
    'style_compliance_summary',
    'style_points',
    'citation_formatting'
  ],
  additionalProperties: false
} as const;

/**
 * EnglishQualityData type definition
 */
export interface EnglishQualityData {
  paper_title: string;
  executive_summary: string;
  key_areas_of_concern: string[];
  grammar_corrections: Array<{
    original: string;
    correction: string;
    explanation: string;
  }>;
  sentence_improvements: Array<{
    original: string;
    revised: string;
    rationale: string;
  }>;
  redundancy_issues: Array<{
    original: string;
    revised: string;
    explanation: string;
  }>;
  fluency_suggestions: Array<{
    category: string;
    suggestion: string;
  }>;
  paragraph_organization: string;
  narrative_flow: string;
  vocabulary_improvements: Array<{
    original: string;
    better_term: string;
    reason: string;
  }>;
  terminology_consistency: Array<{
    term: string;
    variations_found: string;
    recommended: string;
  }>;
  weak_modifiers: Array<{
    original: string;
    weak_term: string;
    suggestion: string;
  }>;
  style_compliance_summary: string;
  style_points: Array<{
    point: string;
    description: string;
  }>;
  citation_formatting: string;
}

// ============================================
// Paper Analysis Agent Schema
// Corresponding template: paper-analysis.typ
// ============================================
export const paperAnalysisSchema = {
  type: 'object',
  properties: {
    paper_title: {
      type: 'string',
      description: 'Exact paper title from the file'
    },
    authors: {
      type: 'string',
      description: 'List of authors'
    },
    abstract_summary: {
      type: 'string',
      description: '2-3 sentences summarizing the abstract and key findings'
    },
    content_summary: {
      type: 'string',
      description: '2-3 paragraphs summarizing the paper content, problem, approach, and main findings'
    },
    introduction_summary: {
      type: 'string',
      description: '2-3 sentences summarizing the introduction and research motivation'
    },
    research_objective: {
      type: 'string',
      description: '2-3 sentences describing the main research objective'
    },
    methodology_summary: {
      type: 'string',
      description: '2-3 sentences summarizing the methodology used'
    },
    experimental_setup: {
      type: 'string',
      description: '3-4 sentences describing the experimental setup, datasets, and evaluation metrics'
    },
    key_findings: {
      type: 'string',
      description: '3-4 sentences describing the key findings and results'
    },
    conclusions_contributions: {
      type: 'string',
      description: '2-3 sentences summarizing the conclusions and main contributions'
    },
    related_work_overview: {
      type: 'string',
      description: '2-3 sentences providing an overview of the related work section'
    },
    innovation_points: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            description: 'Type of innovation, e.g., "Methodological Novelty", "Theoretical Breakthrough", "Incremental Improvement"'
          },
          description: {
            type: 'string',
            description: 'Detailed description of the innovation'
          }
        },
        required: ['type', 'description'],
        additionalProperties: false
      },
      description: 'List of 3-5 innovation points'
    },
    structure_flow_analysis: {
      type: 'string',
      description: '3-4 sentences analyzing the logical flow and organization of the paper'
    },
    structure_quality_analysis: {
      type: 'string',
      description: '3-4 sentences analyzing the coherence and quality of the paper structure'
    },
    technical_clarity: {
      type: 'string',
      description: '2-3 sentences assessing the clarity of technical explanations'
    },
    structure_observations: {
      type: 'array',
      items: { type: 'string' },
      description: 'List of 3-5 specific structural observations'
    },
    complexity_technical_depth: {
      type: 'string',
      description: 'Assessment of technical depth, e.g., "High", "Medium", "Low" with brief explanation'
    },
    complexity_math_level: {
      type: 'string',
      description: 'Assessment of mathematical complexity, e.g., "Advanced", "Intermediate", "Basic"'
    },
    experimental_sophistication: {
      type: 'string',
      description: 'Assessment of experimental sophistication, e.g., "Comprehensive", "Moderate", "Basic"'
    },
    prerequisites: {
      type: 'string',
      description: 'Required background knowledge to understand the paper'
    },
    complexity_reasoning: {
      type: 'string',
      description: '2-3 sentences explaining the complexity assessment reasoning'
    },
    analysis_conclusion: {
      type: 'string',
      description: '3-4 sentences providing the overall analysis conclusion'
    },
    missing_information: {
      type: 'array',
      items: { type: 'string' },
      description: 'List of missing or unclear information in the paper (optional)'
    }
  },
  required: [
    'paper_title',
    'authors',
    'abstract_summary',
    'content_summary',
    'introduction_summary',
    'research_objective',
    'methodology_summary',
    'experimental_setup',
    'key_findings',
    'conclusions_contributions',
    'related_work_overview',
    'innovation_points',
    'structure_flow_analysis',
    'structure_quality_analysis',
    'technical_clarity',
    'structure_observations',
    'complexity_technical_depth',
    'complexity_math_level',
    'experimental_sophistication',
    'prerequisites',
    'complexity_reasoning',
    'analysis_conclusion'
  ],
  additionalProperties: false
} as const;

export interface PaperAnalysisData {
  paper_title: string;
  authors: string;
  abstract_summary: string;
  content_summary: string;
  introduction_summary: string;
  research_objective: string;
  methodology_summary: string;
  experimental_setup: string;
  key_findings: string;
  conclusions_contributions: string;
  related_work_overview: string;
  innovation_points: Array<{
    type: string;
    description: string;
  }>;
  structure_flow_analysis: string;
  structure_quality_analysis: string;
  technical_clarity: string;
  structure_observations: string[];
  complexity_technical_depth: string;
  complexity_math_level: string;
  experimental_sophistication: string;
  prerequisites: string;
  complexity_reasoning: string;
  analysis_conclusion: string;
  missing_information?: string[];
}

// ============================================
// Experimental Evaluation Agent Schema
// Corresponding template: experimental-evaluation.typ
// ============================================
export const experimentalEvaluationSchema = {
  type: 'object',
  properties: {
    paper_title: {
      type: 'string',
      description: 'Exact paper title from the file'
    },
    score_design: {
      type: 'string',
      description: 'Experimental Design score: Exceptional/Strong/Competent/Adequate/Flawed'
    },
    score_validity: {
      type: 'string',
      description: 'Results Validity score: Exceptional/Strong/Competent/Adequate/Flawed'
    },
    score_presentation: {
      type: 'string',
      description: 'Data Presentation score: Exceptional/Strong/Competent/Adequate/Flawed'
    },
    score_reproducibility: {
      type: 'string',
      description: 'Reproducibility score: Exceptional/Strong/Competent/Adequate/Flawed'
    },
    score_overall: {
      type: 'string',
      description: 'Overall Experimental Quality score: Exceptional/Strong/Competent/Adequate/Flawed'
    },
    analysis_design: {
      type: 'string',
      description: '4-6 sentences analyzing experimental design methodology, completeness, control groups, and bias'
    },
    procedures_completeness: {
      type: 'string',
      description: '3-4 sentences analyzing completeness of experimental procedures and parameters documentation'
    },
    analysis_validity: {
      type: 'string',
      description: '4-6 sentences analyzing statistical methods, outlier handling, significance, and confidence intervals'
    },
    reproducibility_assessment: {
      type: 'string',
      description: '3-4 sentences assessing the reproducibility of results, including code/data availability and methodology clarity'
    },
    analysis_presentation: {
      type: 'string',
      description: '4-6 sentences analyzing charts, graphs, labeling, and effective communication of findings'
    },
    table_organization: {
      type: 'string',
      description: '2-3 sentences analyzing table formatting, data organization, and clarity of tabular presentations'
    },
    analysis_consistency: {
      type: 'string',
      description: '4-6 sentences analyzing alignment between experimental design, results, and theoretical claims'
    },
    recommendations: {
      type: 'array',
      items: { type: 'string' },
      description: 'List of 4-6 actionable recommendations for improving experimental quality'
    }
  },
  required: [
    'paper_title',
    'score_design',
    'score_validity',
    'score_presentation',
    'score_reproducibility',
    'score_overall',
    'analysis_design',
    'procedures_completeness',
    'analysis_validity',
    'reproducibility_assessment',
    'analysis_presentation',
    'table_organization',
    'analysis_consistency',
    'recommendations'
  ],
  additionalProperties: false
} as const;

export interface ExperimentalEvaluationData {
  paper_title: string;
  score_design: string;
  score_validity: string;
  score_presentation: string;
  score_reproducibility: string;
  score_overall: string;
  analysis_design: string;
  procedures_completeness: string;
  analysis_validity: string;
  reproducibility_assessment: string;
  analysis_presentation: string;
  table_organization: string;
  analysis_consistency: string;
  recommendations: string[];
}

// ============================================
// Technical Evaluation Agent Schema
// Corresponding template: technical-evaluation.typ
// ============================================
export const technicalEvaluationSchema = {
  type: 'object',
  properties: {
    paper_title: {
      type: 'string',
      description: 'Exact paper title from the file'
    },
    technical_summary: {
      type: 'string',
      description: '3-4 sentences providing executive technical summary'
    },
    math_correctness_overview: {
      type: 'string',
      description: '3-4 sentences providing overview of mathematical correctness verification'
    },
    theoretical_foundations: {
      type: 'string',
      description: '3-4 sentences evaluating the rigor of theoretical arguments, foundational assumptions, and their justifications'
    },
    math_issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          issue_title: {
            type: 'string',
            description: 'Title of the mathematical issue'
          },
          description: {
            type: 'string',
            description: 'Detailed description of the issue'
          }
        },
        required: ['issue_title', 'description'],
        additionalProperties: false
      },
      description: 'List of specific mathematical issues found (can be empty if none)'
    },
    innovation_level: {
      type: 'string',
      enum: ['Exceptional', 'Strong', 'Competent', 'Adequate', 'Flawed'],
      description: 'Qualitative innovation assessment: Exceptional (groundbreaking contribution), Strong (significant novelty), Competent (solid incremental work), Adequate (minor improvements), Flawed (lacks novelty or has issues)'
    },
    methodology_analysis: {
      type: 'string',
      description: '4-6 sentences analyzing novelty, practicality, and significance of proposed methods'
    },
    technical_flaws: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Title of the technical flaw'
          },
          description: {
            type: 'string',
            description: 'Detailed description of the flaw and its implications'
          }
        },
        required: ['title', 'description'],
        additionalProperties: false
      },
      description: 'List of 2-5 identified technical flaws'
    },
    recommendations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          action_item: {
            type: 'string',
            description: 'Specific action to take'
          },
          details: {
            type: 'string',
            description: 'Detailed explanation of the recommendation'
          },
          priority: {
            type: 'string',
            enum: ['High', 'Medium', 'Low'],
            description: 'Priority level based on impact and feasibility: High (critical for acceptance), Medium (would strengthen paper), Low (nice to have)'
          }
        },
        required: ['action_item', 'details', 'priority'],
        additionalProperties: false
      },
      description: 'List of 3-5 constructive recommendations prioritized by impact and feasibility'
    }
  },
  required: [
    'paper_title',
    'technical_summary',
    'math_correctness_overview',
    'theoretical_foundations',
    'innovation_level',
    'methodology_analysis',
    'technical_flaws',
    'recommendations'
  ],
  additionalProperties: false
} as const;

export interface TechnicalEvaluationData {
  paper_title: string;
  technical_summary: string;
  math_correctness_overview: string;
  theoretical_foundations: string;
  math_issues?: Array<{
    issue_title: string;
    description: string;
  }>;
  innovation_level: 'Exceptional' | 'Strong' | 'Competent' | 'Adequate' | 'Flawed';
  methodology_analysis: string;
  technical_flaws: Array<{
    title: string;
    description: string;
  }>;
  recommendations: Array<{
    action_item: string;
    details: string;
    priority: 'High' | 'Medium' | 'Low';
  }>;
}

// ============================================
// Literature Review Evaluation Agent Schema
// Corresponding template: literature-review.typ
// ============================================
export const literatureReviewSchema = {
  type: 'object',
  properties: {
    paper_title: {
      type: 'string',
      description: 'Exact paper title from the file'
    },
    research_area: {
      type: 'string',
      description: 'Primary research area of the paper'
    },
    completeness_rating: {
      type: 'string',
      description: 'Overall rating: Exceptional / Strong / Competent / Adequate / Flawed'
    },
    completeness_tier: {
      type: 'object',
      properties: {
        tier: {
          type: 'number',
          minimum: 1,
          maximum: 5,
          description: 'Tier number from 1-5 (1=lowest, 5=highest)'
        },
        tier_name: {
          type: 'string',
          enum: ['Severely Incomplete', 'Notably Lacking', 'Moderately Complete', 'Substantially Complete', 'Comprehensive'],
          description: 'Tier name describing completeness level'
        },
        justification: {
          type: 'string',
          description: '2-3 sentences explaining why this tier was assigned'
        }
      },
      required: ['tier', 'tier_name', 'justification'],
      additionalProperties: false,
      description: 'Qualitative completeness assessment using 5-tier scale: Tier 1 (Severely Incomplete) - missing most foundational works; Tier 2 (Notably Lacking) - missing several important works; Tier 3 (Moderately Complete) - covers basics but gaps exist; Tier 4 (Substantially Complete) - good coverage with minor gaps; Tier 5 (Comprehensive) - excellent coverage of relevant literature'
    },
    evaluation_summary: {
      type: 'string',
      description: '3-4 sentences providing executive summary of literature review quality'
    },
    quality_completeness: {
      type: 'string',
      description: '3-4 sentences analyzing coverage breadth of the literature review'
    },
    quality_accuracy: {
      type: 'string',
      description: '3-4 sentences analyzing citation accuracy and proper attribution'
    },
    quality_logic: {
      type: 'string',
      description: '3-4 sentences analyzing logic and organization of the literature review'
    },
    quality_positioning: {
      type: 'string',
      description: '3-4 sentences analyzing how well the paper positions itself and identifies gaps'
    },
    quality_timeliness: {
      type: 'string',
      description: '3-4 sentences analyzing inclusion of recent relevant research'
    },
    missing_literature: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Title of the missing paper'
          },
          authors: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Author name' },
                org: { type: 'string', description: 'Author organization (can be null)' }
              },
              required: ['name'],
              additionalProperties: false
            },
            description: 'List of authors with names and organizations'
          },
          venue: {
            type: 'string',
            description: 'Publication venue/journal name'
          },
          year: {
            type: 'number',
            description: 'Publication year'
          },
          citations: {
            type: 'number',
            description: 'Number of citations'
          },
          abstract: {
            type: 'string',
            description: 'Paper abstract'
          },
          doi: {
            type: 'string',
            description: 'DOI identifier'
          },
          url: {
            type: 'string',
            description: 'URL to the paper'
          },
          keywords: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of keywords'
          },
          relevance_explanation: {
            type: 'string',
            description: 'Why this paper is relevant and should be cited'
          }
        },
        required: ['title', 'authors', 'year', 'relevance_explanation'],
        additionalProperties: false
      },
      description: 'List of important missing literature found via AMiner'
    },
    strength_points: {
      type: 'array',
      items: { type: 'string' },
      description: 'List of 3-5 strengths of the literature review'
    },
    weakness_points: {
      type: 'array',
      items: { type: 'string' },
      description: 'List of 3-5 weaknesses of the literature review'
    },
    improvement_recommendations: {
      type: 'array',
      items: { type: 'string' },
      description: 'List of 4-6 actionable improvement recommendations'
    }
  },
  required: [
    'paper_title',
    'research_area',
    'completeness_rating',
    'completeness_tier',
    'evaluation_summary',
    'quality_completeness',
    'quality_accuracy',
    'quality_logic',
    'quality_positioning',
    'quality_timeliness',
    'missing_literature',
    'strength_points',
    'weakness_points',
    'improvement_recommendations'
  ],
  additionalProperties: false
} as const;

export interface LiteratureReviewData {
  paper_title: string;
  research_area: string;
  completeness_rating: string;
  completeness_tier: {
    tier: number;
    tier_name: 'Severely Incomplete' | 'Notably Lacking' | 'Moderately Complete' | 'Substantially Complete' | 'Comprehensive';
    justification: string;
  };
  evaluation_summary: string;
  quality_completeness: string;
  quality_accuracy: string;
  quality_logic: string;
  quality_positioning: string;
  quality_timeliness: string;
  missing_literature: Array<{
    title: string;
    authors: Array<{
      name: string;
      org?: string | null;
    }>;
    venue?: string;
    year: number;
    citations?: number;
    abstract?: string;
    doi?: string;
    url?: string;
    keywords?: string[];
    relevance_explanation: string;
  }>;
  strength_points: string[];
  weakness_points: string[];
  improvement_recommendations: string[];
}