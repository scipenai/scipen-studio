/**
 * @file AudioProcessor - Audio Processor
 * @description Supports Whisper/DashScope ASR transcription with timestamps and speaker identification
 * @depends BaseProcessor, AudioSplitter
 */

import * as path from 'path';
import { createLogger } from '../../LoggerService';
import type {
  AudioProcessOptions,
  ChunkData,
  DocumentMetadata,
  ProcessorResult,
  TranscriptSegment,
} from '../types';
import { AudioSplitter } from '../utils/AudioSplitter';
import fs from '../utils/fsCompat';
import { BaseProcessor, type ProcessorContext } from './BaseProcessor';

/** OpenAI Whisper API 响应类型 */
interface WhisperResponse {
  text?: string;
  duration?: number;
  segments?: Array<{
    text?: string;
    start?: number;
    end?: number;
    avg_logprob?: number;
  }>;
}

/** DashScope ASR API 响应类型 */
interface DashScopeASRResponse {
  output?: {
    text?: string;
    choices?: Array<{
      message?: {
        content?: Array<{ text?: string }> | string;
      };
    }>;
  };
  text?: string;
}

export interface AudioProcessorConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  language?: string;
  provider?: 'openai' | 'dashscope' | 'custom';
}

export class AudioProcessor extends BaseProcessor {
  private logger = createLogger('AudioProcessor');
  private apiConfig: AudioProcessorConfig;

  constructor(config: AudioProcessorConfig) {
    super();
    this.apiConfig = {
      baseUrl: 'https://api.openai.com/v1',
      model: 'whisper-1',
      provider: 'openai',
      ...config,
    };
    this.detectProvider();
  }

  private detectProvider(): void {
    const baseUrl = this.apiConfig.baseUrl || '';
    if (baseUrl.includes('dashscope.aliyuncs.com')) {
      this.apiConfig.provider = 'dashscope';
    } else if (baseUrl.includes('api.openai.com')) {
      this.apiConfig.provider = 'openai';
    }
  }

  updateConfig(config: Partial<AudioProcessorConfig>): void {
    this.apiConfig = { ...this.apiConfig, ...config };
    this.detectProvider();
  }

  getSupportedExtensions(): string[] {
    return ['.mp3', '.mp4', '.mpeg', '.mpga', '.m4a', '.wav', '.webm', '.ogg', '.flac'];
  }

  async process(context: ProcessorContext): Promise<ProcessorResult> {
    try {
      const { filePath, filename, options } = context;
      const audioOptions = options as AudioProcessOptions;

      this.logger.info('[AudioProcessor] 开始处理音频文件:', filename);
      this.logger.info('[AudioProcessor] API 配置:', {
        hasApiKey: !!this.apiConfig.apiKey,
        apiKeyPrefix: `${this.apiConfig.apiKey?.substring(0, 10)}...`,
        baseUrl: this.apiConfig.baseUrl,
        model: this.apiConfig.model,
      });

      if (!this.apiConfig.apiKey) {
        throw new Error('Whisper API Key 未配置。请在设置 → 语音中配置 OpenAI API Key');
      }

      const stats = await fs.stat(filePath);
      const needsSplit = stats.size > 25 * 1024 * 1024;

      let allSegments: TranscriptSegment[] = [];

      if (needsSplit) {
        this.logger.info(
          `[AudioProcessor] 文件较大 (${(stats.size / 1024 / 1024).toFixed(2)} MB)，开始自动分割...`
        );

        const audioSegments = await AudioSplitter.split(filePath);
        this.logger.info(`[AudioProcessor] 文件已分割为 ${audioSegments.length} 个片段`);

        try {
          for (const audioSegment of audioSegments) {
            this.logger.info(
              `[AudioProcessor] 处理片段 ${audioSegment.index + 1}/${audioSegments.length}...`
            );

            const segmentTranscripts = await this.transcribeAudio(
              audioSegment.filePath,
              audioOptions
            );

            // Adjust timestamps by adding the segment's start time to maintain continuity across splits
            const adjustedTranscripts = segmentTranscripts.map((seg) => ({
              ...seg,
              start: seg.start + audioSegment.startTime,
              end: seg.end + audioSegment.startTime,
            }));

            allSegments.push(...adjustedTranscripts);
          }
        } finally {
          await AudioSplitter.cleanup(audioSegments);
        }
      } else {
        allSegments = await this.transcribeAudio(filePath, audioOptions);
      }

      const chunks = this.segmentsToChunks(allSegments, audioOptions);

      const metadata: DocumentMetadata = {
        title: path.basename(filename, path.extname(filename)),
        duration: allSegments.length > 0 ? allSegments[allSegments.length - 1].end : 0,
        language: audioOptions?.language,
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

  private async transcribeAudio(
    filePath: string,
    options?: AudioProcessOptions
  ): Promise<TranscriptSegment[]> {
    const { provider } = this.apiConfig;

    this.logger.info('[AudioProcessor] 使用服务商:', provider);

    if (provider === 'dashscope') {
      return this.transcribeWithDashScope(filePath, options);
    } else {
      return this.transcribeWithOpenAI(filePath, options);
    }
  }

  private async transcribeWithOpenAI(
    filePath: string,
    options?: AudioProcessOptions
  ): Promise<TranscriptSegment[]> {
    const { apiKey, baseUrl, model } = this.apiConfig;

    const fileBuffer = await fs.readFile(filePath);
    const filename = path.basename(filePath);

    const formData = new FormData();
    formData.append('file', new Blob([new Uint8Array(fileBuffer)]), filename);
    formData.append('model', model || 'whisper-1');
    formData.append('response_format', 'verbose_json');

    if (options?.language && options.language !== 'auto') {
      formData.append('language', options.language);
    }

    if (options?.enableTimestamps !== false) {
      formData.append('timestamp_granularities[]', 'segment');
    }

    const response = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[AudioProcessor] OpenAI Whisper API 调用失败:', {
        status: response.status,
        statusText: response.statusText,
        error: errorText,
      });
      this.throwApiError(response.status, errorText, 'OpenAI');
    }

    const data = (await response.json()) as WhisperResponse;

    if (data.segments && Array.isArray(data.segments)) {
      return data.segments.map((seg) => ({
        text: seg.text?.trim() || '',
        start: seg.start || 0,
        end: seg.end || 0,
        speaker: undefined,
        confidence: seg.avg_logprob ? Math.exp(seg.avg_logprob) : undefined,
      }));
    }

    return [
      {
        text: data.text?.trim() || '',
        start: 0,
        end: data.duration || 0,
      },
    ];
  }

  /**
   * Transcribe using Alibaba Cloud DashScope (Qwen ASR)
   * Documentation: https://help.aliyun.com/zh/model-studio/developer-reference/qwen3-asr
   */
  private async transcribeWithDashScope(
    filePath: string,
    options?: AudioProcessOptions
  ): Promise<TranscriptSegment[]> {
    const { apiKey, model } = this.apiConfig;

    const fileBuffer = await fs.readFile(filePath);
    const base64Audio = fileBuffer.toString('base64');
    const filename = path.basename(filePath);
    const ext = path.extname(filename).toLowerCase().replace('.', '');

    const mimeMap: Record<string, string> = {
      mp3: 'audio/mp3',
      wav: 'audio/wav',
      pcm: 'audio/pcm',
      m4a: 'audio/m4a',
      flac: 'audio/flac',
      ogg: 'audio/ogg',
      webm: 'audio/webm',
      aac: 'audio/aac',
    };
    const mimeType = mimeMap[ext] || 'audio/mp3';

    const apiUrl =
      'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';

    interface DashScopeASRRequest {
      model: string;
      input: {
        messages: Array<{
          role: 'system' | 'user';
          content: Array<{ text?: string; audio?: string }>;
        }>;
      };
      parameters: {
        result_format: string;
        asr_options?: {
          enable_lid?: boolean;
          enable_itn?: boolean;
          language?: string;
        };
      };
    }
    const requestBody: DashScopeASRRequest = {
      model: model || 'qwen3-asr-flash',
      input: {
        messages: [
          {
            role: 'system',
            content: [
              { text: '' }, // Context for customized recognition
            ],
          },
          {
            role: 'user',
            content: [
              {
                audio: `data:${mimeType};base64,${base64Audio}`,
              },
            ],
          },
        ],
      },
      parameters: {
        result_format: 'message',
        asr_options: {
          enable_lid: true,
          enable_itn: true,
          language: options?.language && options.language !== 'auto' ? options.language : undefined,
        },
      },
    };

    this.logger.info('[AudioProcessor] DashScope ASR request:', {
      url: apiUrl,
      model: requestBody.model,
      mimeType: mimeType,
      audioSize: `${(fileBuffer.length / 1024 / 1024).toFixed(2)} MB`,
      language: options?.language || 'auto',
    });

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[AudioProcessor] DashScope API 调用失败:', {
        status: response.status,
        statusText: response.statusText,
        error: errorText,
      });
      this.throwApiError(response.status, errorText, 'DashScope');
    }

    const data = (await response.json()) as DashScopeASRResponse;
    this.logger.info('[AudioProcessor] DashScope response:', JSON.stringify(data, null, 2));

    // Parse DashScope ASR response
    // Response format: { output: { choices: [{ message: { content: [{ text: "..." }] } }] } }
    let text = '';
    try {
      const content = data.output?.choices?.[0]?.message?.content;
      if (Array.isArray(content)) {
        text = content
          .filter((item) => item.text)
          .map((item) => item.text)
          .join('');
      } else if (typeof content === 'string') {
        text = content;
      }
    } catch (e) {
      console.error('[AudioProcessor] 解析响应失败:', e);
    }

    if (!text) {
      text = data.output?.text || data.text || '';
    }

    if (!text) {
      throw new Error('DashScope 返回空结果，请检查音频文件是否有效');
    }

    this.logger.info(
      '[AudioProcessor] 转录结果:',
      text.substring(0, 200) + (text.length > 200 ? '...' : '')
    );

    // DashScope ASR doesn't provide timestamps; return entire text as a single segment
    return [
      {
        text: text.trim(),
        start: 0,
        end: 0,
      },
    ];
  }

  private throwApiError(status: number, errorText: string, provider: string): never {
    if (status === 401) {
      throw new Error(`${provider} API Key 无效或已过期。请检查设置 → 语音中的 API Key 配置`);
    } else if (status === 429) {
      throw new Error(`${provider} API 请求过于频繁，请稍后重试`);
    } else if (status === 413) {
      throw new Error('音频文件过大，请确保文件小于 25MB');
    } else if (status === 404) {
      throw new Error(`${provider} API 端点不存在，请检查模型名称是否正确`);
    } else {
      throw new Error(`${provider} API 错误 (${status}): ${errorText}`);
    }
  }

  private segmentsToChunks(
    segments: TranscriptSegment[],
    _options?: AudioProcessOptions
  ): ChunkData[] {
    const chunks: ChunkData[] = [];

    const mergedSegments = this.mergeShortSegments(segments);

    for (const segment of mergedSegments) {
      if (!segment.text.trim()) continue;

      chunks.push({
        content: segment.text.trim(),
        chunkType: 'audio_transcript',
        metadata: {
          startTime: segment.start,
          endTime: segment.end,
          speaker: segment.speaker,
          confidence: segment.confidence,
          sourceType: 'audio',
        },
      });
    }

    return chunks;
  }

  private mergeShortSegments(segments: TranscriptSegment[], minLength = 100): TranscriptSegment[] {
    const merged: TranscriptSegment[] = [];
    let current: TranscriptSegment | null = null;

    for (const segment of segments) {
      if (!current) {
        current = { ...segment };
        continue;
      }

      if (current.text.length < minLength) {
        current.text += ` ${segment.text}`;
        current.end = segment.end;
        // If speakers differ, mark as multiple speakers
        if (segment.speaker && current.speaker !== segment.speaker) {
          current.speaker = 'Multiple';
        }
      } else {
        merged.push(current);
        current = { ...segment };
      }
    }

    if (current) {
      merged.push(current);
    }

    return merged;
  }

  static formatTimestamp(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);

    if (h > 0) {
      return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  static formatTranscriptWithTimestamps(segments: TranscriptSegment[]): string {
    return segments
      .map((seg) => `[${AudioProcessor.formatTimestamp(seg.start)}] ${seg.text}`)
      .join('\n');
  }
}
