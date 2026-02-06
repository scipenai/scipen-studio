/**
 * @file Literature Search Types
 * @description Type definitions for Semantic Scholar API integration
 * @depends None (pure type definitions)
 * @see https://api.semanticscholar.org/api-docs/graph
 */

// ====== Search Parameters ======

export interface SearchLiteratureParams {
  /** Search query (supports boolean syntax: + | - " * ~N) */
  query: string;
  /** Search mode: paper for metadata, snippet for full-text */
  mode: 'paper' | 'snippet';
  year?: string;
  fieldsOfStudy?: string[];
  minCitationCount?: number;
  openAccessOnly?: boolean;
  limit?: number;
  offset?: number;
  sort?: 'relevance' | 'citationCount' | 'publicationDate';
}

export interface GetPaperDetailsParams {
  paperId: string;
  includeBibtex?: boolean;
  includePdf?: boolean;
  includeAbstract?: boolean;
  includeTldr?: boolean;
}

export interface ExploreConnectionsParams {
  paperId: string;
  type: 'citations' | 'references' | 'recommendations';
  limit?: number;
  offset?: number;
  filters?: {
    year?: string;
    minCitationCount?: number;
    fieldsOfStudy?: string[];
  };
}

// ====== Result Types ======

export interface PaperAuthor {
  authorId: string | null;
  name: string;
  url?: string;
}

export interface ExternalId {
  type: 'DOI' | 'ArXiv' | 'PubMed' | 'MAG' | 'ACL' | 'DBLP' | 'CorpusId';
  value: string;
}

export interface PaperTldr {
  model: string;
  text: string;
}

export interface OpenAccessPdf {
  url: string;
  status: 'GREEN' | 'GOLD' | 'HYBRID' | 'BRONZE' | null;
}

export interface PaperCard {
  paperId: string;
  title: string;
  year: number | null;
  citationCount: number;
  authors: PaperAuthor[];
  venue?: string;
  isOpenAccess: boolean;
  pdfUrl?: string;
  bibtex?: string;
  tldr?: string;
  abstract?: string;
  externalIds?: ExternalId[];
  actions: PaperAction[];
}

export type PaperAction =
  | 'cite'
  | 'download'
  | 'expand_citations'
  | 'expand_references'
  | 'use_as_seed'
  | 'view_details'
  | 'copy_bibtex';

export interface SnippetResult {
  paperId: string;
  title: string;
  snippet: string;
  score: number;
  authors: PaperAuthor[];
  year: number | null;
}

export interface PaperSearchResult {
  total: number;
  offset: number;
  hasMore: boolean;
  papers: PaperCard[];
}

export interface SnippetSearchResult {
  total: number;
  snippets: SnippetResult[];
}

export interface PaperDetailsResult extends PaperCard {
  referenceCount: number;
  citationCount: number;
  influentialCitationCount?: number;
  publicationDate?: string;
  journalOrVenue?: string;
  pages?: string;
  volume?: string;
}

export interface ConnectionsResult {
  sourcePaperId: string;
  type: 'citations' | 'references' | 'recommendations';
  total: number;
  offset: number;
  hasMore: boolean;
  papers: PaperCard[];
}
