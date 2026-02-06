/**
 * @file vlm-client.ts - VLM (Vision Language Model) API client
 * @description Client for converting PDF pages to LaTeX using VLM API
 * @depends axios, logger, types, local-config-manager
 */

import axios, { type AxiosInstance } from 'axios';
import { Logger } from '../utils/logger';
import type { PDFPageImage, VLMConfig } from '../types';
import { localConfigManager } from '../utils/local-config-manager';

export class VLMClient {
  private client: AxiosInstance;
  private config: VLMConfig;
  private systemPrompt = `## Role
You are an expert in **document refactoring** and **professional LaTeX typesetting**. You must follow the rules strictly.

## Goal
Convert the provided documentation pages into **clean, well-structured, compilable LaTeX** code for integration into a larger project. The result must be directly compilable with pdflatex or xelatex.

## Output requirements

### 1. Format and scope
- Output only **LaTeX body content**.
- **Do not** include \`\\documentclass\`, \`\\usepackage\`, \`\\begin{document}\`, or \`\\end{document}\`.
- Use \`latex\` to wrap the result in a Markdown code block.
- Do not use unnamed or custom commands. If necessary, use commands that can be imported via macro packages.

### 2. Structure preservation
- Preserve logical hierarchy: \`\\section\`, \`\\subsection\`, \`\\paragraph\`, etc.
- Keep original paragraphs, lists and environments:
  - Lists: \`itemize\`, \`enumerate\`.
  - Images: If images make sense, add descriptions, otherwise don't show images, and don't show image paths and other information directly. For example, .jpg and .png files must not appear in the output.
  - Citations: Use \`\\cite{...}\` where appropriate.

### 3. LaTeX syntax and code quality

#### Math environments
- Inline math: use only \`\\(...\\)\`.
- Display math: use \`\\[...\\]\` for any block formulas.
- **Don't** use \`\\tag\` inside \`\\(...\\)\` — if \`\\tag\` is present, wrap it with \`\\[...\\]\`.
- Multi-line blocks (e.g. \`cases\`, \`aligned\`) must always be inside display math expressions (\`\\[...\\]\`), not inline math expressions.
- Never mix inline math expressions and display math expressions in the same block.
- **Rule for concatenating formulas**: If a series of short and related formulas appear in the same sentence and are separated only by punctuation (e.g., comma \`,\`, semicolon \`;\`), then **you must** enclose the entire sequence of formulas (including punctuation) in a **single** math environment (\`\\(...\\)\`). Do not close and reopen math environments around punctuation.
  - **Example**:
    - **Incorrect**: \`\\(y_k = b - A x_k\\), \\(z_k = M^{-1} y_k\\)\`
    - **Correct**: \`\\(y_k = b - A x_k, \\quad z_k = M^{-1} y_k\\)\`
- Use \`\\begin{array}{cccccc} ... \\end{array}\` to display matrices. Not use \`\\begin{cases} ... \\end{cases}\`

#### Environment Sanitation
- All \`\\begin{...}\` must match \`\\end{...}\`.
- All environments must be **properly nested and closed**, including the use of left and right delimiters.
- All macro packages involved in the used methods must be imported.

#### Special Character Escaping
- Escape all LaTeX sensitive characters: \`\\# \$ \% \& _ \{ \} ~ ^ \\\\\`. Remember that they cannot be used directly in a math environment, including in a \\section.
  - **Example**:
    - **Correct**: \`\\section{\\(LDL^T\\)分解 --- 求解对称不定方程组的解法}\`
    - **Incorrect**: \`\\section{LDL^T分解 --- 求解对称不定方程组的解法}\`

#### Unicode and Math Symbols
- Assume the use of a Unicode engine (XeLaTeX / LuaLaTeX).
- Use math symbols directly: \`\\mathbb{R}\`, \`\\qed\`, etc.
- Avoid frequent nesting of \\( ... \\) math environments and \\[ in the text.
- In Chinese word segmentation, do not open and close multiple math environments in the middle of a sentence.
- When there are multiple math environments in a paragraph, put the entire paragraph in a math environment and don't switch between \\( and \\[ too often.
- **Paired delimiters**: \`\\left\` and \`\\right\` commands must always be used in pairs. Every \`\\left\` must have a corresponding \`\\right\`.

### 4. Semantic fixes
- Minor refactoring to improve clarity and accuracy.
- Mark any ambiguities with comments (e.g., "% ?? undefined symbol").

### 5. If a section title contains a mathematical expression, it must be written in math mode, e.g., \\section{\\(LDL^T\\) decomposition}, not \\section{LDL^T decomposition}.`;

  constructor(baseURL?: string, apiKey?: string, model?: string, options?: Partial<VLMConfig>) {
    const localConfig = localConfigManager.getVLMConfig();
    this.config = {
      baseURL: baseURL || localConfig?.baseURL || 'http://localhost:8000',
      apiKey: apiKey || localConfig?.apiKey,
      model: model || localConfig?.model || 'default',
      maxTokens: options?.maxTokens || localConfig?.maxTokens || 4096,
      temperature: options?.temperature || localConfig?.temperature || 0.3,
      timeout: options?.timeout || localConfig?.timeout || 120000,
      systemPromptOverride: options?.systemPromptOverride || localConfig?.systemPromptOverride,
    };

    if (this.config.systemPromptOverride) {
      this.systemPrompt = this.config.systemPromptOverride;
    }

    this.client = this.createClient();
  }

  private createClient(): AxiosInstance {
    const config: any = {
      baseURL: this.config.baseURL,
      timeout: this.config.timeout,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    if (this.config.apiKey) {
      config.headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    return axios.create(config);
  }

  /**
   * Convert PDF page image to LaTeX
   * @throws Error when conversion fails after all retries
   * @sideeffect Makes API calls to VLM service
   */
  async convertPageToLaTeX(page: PDFPageImage, maxRetries = 2): Promise<string> {
    Logger.info(`Converting page ${page.pageNumber} (model: ${this.config.model})`);

    const base64Image = page.imageBuffer.toString('base64');

    let lastError: any;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          Logger.info(`Retrying page ${page.pageNumber} ${attempt}/${maxRetries}...`);
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        }

        const latex = await this.convertWithOpenAICompatible(base64Image);
        Logger.success(`Page ${page.pageNumber} conversion completed`);
        return latex;
      } catch (error: any) {
        lastError = error;
        const statusCode = error.response?.status;
        const errorData = error.response?.data;

        if (attempt < maxRetries) {
          Logger.warning(
            `Page ${page.pageNumber} conversion failed (${statusCode || 'unknown'}), will retry...`
          );
        } else {
          const detailMsg = errorData?.error?.message || errorData?.message || error.message;
          Logger.error(
            `Page ${page.pageNumber} conversion failed (${statusCode || 'unknown'}): ${detailMsg}`
          );
        }
      }
    }

    throw lastError;
  }

  private async convertWithOpenAICompatible(base64Image: string): Promise<string> {
    try {
      const response = await this.client.post('/chat/completions', {
        model: this.config.model,
        messages: [
          {
            role: 'system',
            content: this.systemPrompt,
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Convert this PDF page to LaTeX:',
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/png;base64,${base64Image}`,
                },
              },
            ],
          },
        ],
        max_tokens: this.config.maxTokens,
        temperature: this.config.temperature,
      });

      const content = response.data.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error('API returned empty content');
      }

      return content;
    } catch (error: any) {
      if (error.response) {
        const errorInfo = {
          status: error.response.status,
          statusText: error.response.statusText,
          data: error.response.data,
        };
        error.message = `Request failed with status code ${error.response.status}`;
        error.details = errorInfo;
      }
      throw error;
    }
  }
}
