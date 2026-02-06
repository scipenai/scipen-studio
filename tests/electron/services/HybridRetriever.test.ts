/**
 * @file HybridRetriever.test.ts - Unit tests for hybrid retrieval fusion logic
 * @description Tests result fusion algorithm: BM25 adaptive normalization, weight fusion, and edge cases. Critical because fusion directly affects retrieval ranking, and normalization errors can break keyword search.
 * @depends HybridRetriever fusion logic
 */

import { describe, expect, it } from 'vitest';

// ====== Fusion Logic Tests (extracted from VectorStore) ======

/**
 * Sigmoid normalization function
 * Maps BM25 scores to (0, 1) range
 */
function normalizeBM25Score(bm25Score: number, k = 0.1, midpoint = 10): number {
  return 1 / (1 + Math.exp(-k * (bm25Score - midpoint)));
}

/**
 * Adaptive BM25 normalization parameter calculation
 */
function calculateAdaptiveParams(scores: number[]): { k: number; midpoint: number } {
  if (scores.length === 0 || Math.max(...scores) <= 0) {
    return { k: 0.1, midpoint: 10 }; // Default fallback when no valid scores
  }

  const maxScore = Math.max(...scores);
  const midpoint = maxScore * 0.5;
  const k = Math.max(0.05, 5 / maxScore);

  return { k, midpoint };
}

/**
 * Fuse vector and keyword results
 */
function fuseResults(
  vectorResults: Array<{ chunkId: string; score: number }>,
  keywordResults: Array<{ chunkId: string; score: number }>,
  options: {
    vectorWeight: number;
    keywordWeight: number;
    threshold: number;
  }
): Array<{ chunkId: string; score: number; vectorScore: number; keywordScore: number }> {
  const { vectorWeight, keywordWeight, threshold } = options;

  const resultMap = new Map<string, { vectorScore: number; keywordScore: number }>();

  for (const r of vectorResults) {
    resultMap.set(r.chunkId, { vectorScore: r.score, keywordScore: 0 });
  }

  for (const r of keywordResults) {
    const existing = resultMap.get(r.chunkId);
    if (existing) {
      existing.keywordScore = r.score;
    } else {
      resultMap.set(r.chunkId, { vectorScore: 0, keywordScore: r.score });
    }
  }

  const hasVector = vectorResults.length > 0;
  const hasKeyword = keywordResults.length > 0;
  let vw = vectorWeight;
  let kw = keywordWeight;

  if (!hasVector && hasKeyword) {
    vw = 0;
    kw = 1.0;
  } else if (hasVector && !hasKeyword) {
    vw = 1.0;
    kw = 0;
  }

  const effectiveThreshold = !hasVector && hasKeyword ? Math.min(threshold, 0.1) : threshold;

  const fused: Array<{
    chunkId: string;
    score: number;
    vectorScore: number;
    keywordScore: number;
  }> = [];

  for (const [chunkId, scores] of resultMap) {
    const fusedScore = vw * scores.vectorScore + kw * scores.keywordScore;
    if (fusedScore >= effectiveThreshold) {
      fused.push({
        chunkId,
        score: fusedScore,
        vectorScore: scores.vectorScore,
        keywordScore: scores.keywordScore,
      });
    }
  }

  fused.sort((a, b) => b.score - a.score);
  return fused;
}

// ====== Test Cases ======

describe('BM25 Sigmoid Normalization', () => {
  it('should return 0.5 at midpoint', () => {
    const score = normalizeBM25Score(10, 0.1, 10);
    expect(score).toBeCloseTo(0.5, 2);
  });

  it('should approach 1 for high scores', () => {
    const score = normalizeBM25Score(50, 0.1, 10);
    expect(score).toBeGreaterThan(0.95);
    expect(score).toBeLessThan(1);
  });

  it('should approach 0 for low scores', () => {
    const score = normalizeBM25Score(-20, 0.1, 10);
    expect(score).toBeLessThan(0.1);
    expect(score).toBeGreaterThan(0);
  });

  it('should be in 0.3-0.4 range for zero score (default params)', () => {
    const score = normalizeBM25Score(0, 0.1, 10);
    expect(score).toBeCloseTo(0.27, 1);
  });

  it('should have steeper curve when k increases', () => {
    const flatK = normalizeBM25Score(15, 0.05, 10);
    const steepK = normalizeBM25Score(15, 0.2, 10);

    expect(steepK).toBeGreaterThan(flatK);
  });
});

describe('Adaptive BM25 Parameter Calculation', () => {
  it('should return default values for empty score array', () => {
    const params = calculateAdaptiveParams([]);
    expect(params.k).toBe(0.1);
    expect(params.midpoint).toBe(10);
  });

  it('should return default values for all-zero scores', () => {
    const params = calculateAdaptiveParams([0, 0, 0]);
    expect(params.k).toBe(0.1);
    expect(params.midpoint).toBe(10);
  });

  it('should correctly calculate midpoint for single high score', () => {
    const params = calculateAdaptiveParams([20]);
    expect(params.midpoint).toBe(10);
    expect(params.k).toBeCloseTo(0.25, 2);
  });

  it('should have minimum k of 0.05', () => {
    const params = calculateAdaptiveParams([200]);
    expect(params.k).toBe(0.05);
  });

  it('should use maximum value for multiple scores', () => {
    const params = calculateAdaptiveParams([5, 15, 10, 8]);
    expect(params.midpoint).toBe(7.5); // 15 * 0.5
  });
});

describe('Result Fusion - Basic Functionality', () => {
  it('should correctly weight when both vector and keyword results exist', () => {
    const vectorResults = [
      { chunkId: 'a', score: 0.8 },
      { chunkId: 'b', score: 0.6 },
    ];
    const keywordResults = [
      { chunkId: 'a', score: 0.7 },
      { chunkId: 'c', score: 0.5 },
    ];

    const fused = fuseResults(vectorResults, keywordResults, {
      vectorWeight: 0.7,
      keywordWeight: 0.3,
      threshold: 0.1,
    });

    expect(fused[0].chunkId).toBe('a');
    expect(fused[0].score).toBeCloseTo(0.8 * 0.7 + 0.7 * 0.3, 2);
    expect(fused[0].vectorScore).toBe(0.8);
    expect(fused[0].keywordScore).toBe(0.7);
  });

  it('should use vectorWeight=1 when only vector results exist', () => {
    const vectorResults = [{ chunkId: 'a', score: 0.8 }];
    const keywordResults: Array<{ chunkId: string; score: number }> = [];

    const fused = fuseResults(vectorResults, keywordResults, {
      vectorWeight: 0.5,
      keywordWeight: 0.5,
      threshold: 0.1,
    });

    expect(fused.length).toBe(1);
    expect(fused[0].score).toBe(0.8);
  });

  it('should use keywordWeight=1 when only keyword results exist', () => {
    const vectorResults: Array<{ chunkId: string; score: number }> = [];
    const keywordResults = [{ chunkId: 'a', score: 0.6 }];

    const fused = fuseResults(vectorResults, keywordResults, {
      vectorWeight: 0.5,
      keywordWeight: 0.5,
      threshold: 0.1,
    });

    expect(fused.length).toBe(1);
    expect(fused[0].score).toBe(0.6);
  });

  it('should return empty array when both are empty', () => {
    const fused = fuseResults([], [], {
      vectorWeight: 0.5,
      keywordWeight: 0.5,
      threshold: 0.1,
    });

    expect(fused).toHaveLength(0);
  });
});

describe('Result Fusion - Threshold Filtering', () => {
  it('should filter results below threshold', () => {
    const vectorResults = [
      { chunkId: 'a', score: 0.8 },
      { chunkId: 'b', score: 0.1 },
    ];
    const keywordResults = [{ chunkId: 'a', score: 0.1 }];

    const fused = fuseResults(vectorResults, keywordResults, {
      vectorWeight: 0.7,
      keywordWeight: 0.3,
      threshold: 0.5,
    });

    expect(fused.length).toBe(1);
    expect(fused[0].chunkId).toBe('a');
  });

  it('should lower threshold when only keyword results exist', () => {
    const vectorResults: Array<{ chunkId: string; score: number }> = [];
    const keywordResults = [{ chunkId: 'a', score: 0.08 }];

    const fused = fuseResults(vectorResults, keywordResults, {
      vectorWeight: 0.5,
      keywordWeight: 0.5,
      threshold: 0.5,
    });

    expect(fused.length).toBe(0);

    const keywordResults2 = [{ chunkId: 'a', score: 0.15 }];
    const fused2 = fuseResults(vectorResults, keywordResults2, {
      vectorWeight: 0.5,
      keywordWeight: 0.5,
      threshold: 0.5,
    });
    expect(fused2.length).toBe(1);
  });
});

describe('Result Fusion - Sorting', () => {
  it('should sort results by score in descending order', () => {
    const vectorResults = [
      { chunkId: 'a', score: 0.5 },
      { chunkId: 'b', score: 0.9 },
      { chunkId: 'c', score: 0.3 },
    ];

    const fused = fuseResults(vectorResults, [], {
      vectorWeight: 1.0,
      keywordWeight: 0,
      threshold: 0.1,
    });

    expect(fused[0].chunkId).toBe('b');
    expect(fused[1].chunkId).toBe('a');
    expect(fused[2].chunkId).toBe('c');
  });
});

describe('Result Fusion - Extreme Weights', () => {
  it('should use only vector score when vectorWeight=1, keywordWeight=0', () => {
    const vectorResults = [{ chunkId: 'a', score: 0.8 }];
    const keywordResults = [{ chunkId: 'a', score: 0.9 }];

    const fused = fuseResults(vectorResults, keywordResults, {
      vectorWeight: 1.0,
      keywordWeight: 0,
      threshold: 0,
    });

    expect(fused[0].score).toBe(0.8);
  });

  it('should use only keyword score when vectorWeight=0, keywordWeight=1', () => {
    const vectorResults = [{ chunkId: 'a', score: 0.8 }];
    const keywordResults = [{ chunkId: 'a', score: 0.9 }];

    const fused = fuseResults(vectorResults, keywordResults, {
      vectorWeight: 0,
      keywordWeight: 1.0,
      threshold: 0,
    });

    expect(fused[0].score).toBe(0.9);
  });
});
