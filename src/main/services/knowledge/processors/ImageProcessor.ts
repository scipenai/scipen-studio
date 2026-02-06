/**
 * @file ImageProcessor - Image Processor
 * @description Uses GPT-4o/Vision API for OCR text extraction and image description generation
 * @depends BaseProcessor, fsCompat
 */

import * as path from 'path';
import type {
  ChunkData,
  DocumentMetadata,
  ImageProcessOptions,
  ImageProcessResult,
  ProcessorResult,
} from '../types';
import fs from '../utils/fsCompat';
import { BaseProcessor, type ProcessorContext } from './BaseProcessor';

/** OpenAI Vision API 响应类型 */
interface VisionAPIResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

export interface ImageProcessorConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  captionPrompt?: string;
}

const DEFAULT_CAPTION_PROMPT = `You are analyzing an academic/research image. Please provide:
1. A detailed description of what the image shows
2. Any text visible in the image (OCR)
3. Key insights or data points if it's a chart/graph
4. Technical terms and concepts depicted

Format your response as:
DESCRIPTION: [detailed description]
TEXT_CONTENT: [any visible text]
KEY_POINTS: [bullet points of key insights]`;

export class ImageProcessor extends BaseProcessor {
  private apiConfig: ImageProcessorConfig;

  constructor(config: ImageProcessorConfig) {
    super();
    this.apiConfig = {
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      captionPrompt: DEFAULT_CAPTION_PROMPT,
      ...config,
    };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<ImageProcessorConfig>): void {
    this.apiConfig = { ...this.apiConfig, ...config };
  }

  getSupportedExtensions(): string[] {
    return ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
  }

  async process(context: ProcessorContext): Promise<ProcessorResult> {
    try {
      const { filePath, filename, options } = context;
      const imageOptions = options as ImageProcessOptions;

      // Check API Key
      if (!this.apiConfig.apiKey) {
        throw new Error('OpenAI API key is required for image processing');
      }

      // Read image and convert to base64
      const imageBuffer = await fs.readFile(filePath);
      const base64Image = imageBuffer.toString('base64');
      const mimeType = this.getMimeType(path.extname(filename));

      // Get image dimensions (simplified version, no external library dependency)
      const dimensions = this.getImageDimensions(imageBuffer);

      // Call Vision API
      const result = await this.analyzeImage(base64Image, mimeType, imageOptions);

      // Create chunks
      const chunks = this.createImageChunks(result, filePath, imageOptions);

      // Metadata
      const metadata: DocumentMetadata = {
        title: path.basename(filename, path.extname(filename)),
        width: dimensions?.width,
        height: dimensions?.height,
        format: path.extname(filename).slice(1).toUpperCase(),
      };

      return {
        success: true,
        chunks,
        metadata,
      };
    } catch (error) {
      return {
        success: false,
        chunks: [],
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Call GPT-4 Vision API to analyze image
   */
  private async analyzeImage(
    base64Image: string,
    mimeType: string,
    options?: ImageProcessOptions
  ): Promise<ImageProcessResult> {
    const { apiKey, baseUrl, model, captionPrompt } = this.apiConfig;

    const prompt = options?.captionPrompt || captionPrompt || DEFAULT_CAPTION_PROMPT;

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: options?.vlmModel || model,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: prompt,
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:${mimeType};base64,${base64Image}`,
                  detail: 'high',
                },
              },
            ],
          },
        ],
        max_tokens: 1500,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Vision API error: ${response.status} - ${errorText}`);
    }

    const data = (await response.json()) as VisionAPIResponse;
    const content = data.choices?.[0]?.message?.content || '';

    // Parse response
    return this.parseVisionResponse(content);
  }

  /**
   * Parse Vision API response
   */
  private parseVisionResponse(content: string): ImageProcessResult {
    const result: ImageProcessResult = {
      caption: content,
    };

    // Try to extract structured content
    const descMatch = content.match(/DESCRIPTION:\s*([\s\S]*?)(?=TEXT_CONTENT:|KEY_POINTS:|$)/i);
    const textMatch = content.match(/TEXT_CONTENT:\s*([\s\S]*?)(?=KEY_POINTS:|$)/i);
    const keyPointsMatch = content.match(/KEY_POINTS:\s*([\s\S]*?)$/i);

    if (descMatch) {
      result.caption = descMatch[1].trim();
    }

    if (textMatch) {
      result.ocrText = textMatch[1].trim();
    }

    // If key points exist, append to description
    if (keyPointsMatch) {
      const keyPoints = keyPointsMatch[1].trim();
      if (keyPoints) {
        result.caption += `\n\nKey Points:\n${keyPoints}`;
      }
    }

    return result;
  }

  /**
   * Create image chunks
   */
  private createImageChunks(
    result: ImageProcessResult,
    imagePath: string,
    _options?: ImageProcessOptions
  ): ChunkData[] {
    const chunks: ChunkData[] = [];

    // Main description chunk
    if (result.caption) {
      chunks.push({
        content: result.caption,
        chunkType: 'image_caption',
        metadata: {
          imagePath,
          sourceType: 'image',
          hasCaption: true,
        },
      });
    }

    // OCR text chunk (if exists and differs from description)
    if (result.ocrText && result.ocrText !== result.caption) {
      chunks.push({
        content: result.ocrText,
        chunkType: 'image_ocr',
        metadata: {
          imagePath,
          sourceType: 'image',
          isOCR: true,
        },
      });
    }

    // If no content, create a basic description
    if (chunks.length === 0) {
      chunks.push({
        content: `[Image: ${path.basename(imagePath)}]`,
        chunkType: 'image_caption',
        metadata: {
          imagePath,
          sourceType: 'image',
          isEmpty: true,
        },
      });
    }

    return chunks;
  }

  /**
   * Get MIME type
   */
  private getMimeType(ext: string): string {
    const mimeTypes: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.bmp': 'image/bmp',
    };
    return mimeTypes[ext.toLowerCase()] || 'image/jpeg';
  }

  /**
   * Simple PNG/JPEG image dimension extraction
   */
  private getImageDimensions(buffer: Buffer): { width: number; height: number } | null {
    try {
      // PNG
      if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
        return {
          width: buffer.readUInt32BE(16),
          height: buffer.readUInt32BE(20),
        };
      }

      // JPEG
      if (buffer[0] === 0xff && buffer[1] === 0xd8) {
        let offset = 2;
        while (offset < buffer.length) {
          if (buffer[offset] !== 0xff) break;
          const marker = buffer[offset + 1];

          // SOF markers
          if (
            marker >= 0xc0 &&
            marker <= 0xcf &&
            marker !== 0xc4 &&
            marker !== 0xc8 &&
            marker !== 0xcc
          ) {
            return {
              height: buffer.readUInt16BE(offset + 5),
              width: buffer.readUInt16BE(offset + 7),
            };
          }

          const length = buffer.readUInt16BE(offset + 2);
          offset += 2 + length;
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Generate Markdown with image reference
   */
  static generateMarkdownReference(imagePath: string, caption?: string, altText?: string): string {
    const alt = altText || caption || path.basename(imagePath);
    const captionLine = caption ? `\n*${caption}*` : '';
    return `![${alt}](${imagePath})${captionLine}`;
  }
}
