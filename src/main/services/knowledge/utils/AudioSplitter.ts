/**
 * @file AudioSplitter - Audio Splitting Utility
 * @description Splits large audio files into <25MB segments for Whisper API compliance, supports WAV/MP3
 * @depends music-metadata, fsCompat
 */

import * as path from 'path';
import * as musicMetadata from 'music-metadata';
import { createLogger } from '../../LoggerService';
import fs from './fsCompat';

const logger = createLogger('AudioSplitter');

// ====== Type Definitions ======

/** Audio segment information after splitting */
export interface AudioSegment {
  /** Segment file path */
  filePath: string;
  /** Segment start time (seconds) */
  startTime: number;
  /** Segment end time (seconds) */
  endTime: number;
  /** Segment index */
  index: number;
  /** Whether this is a temporary file (needs cleanup) */
  isTemp: boolean;
}

/** Split configuration */
export interface SplitOptions {
  /** Maximum segment size in bytes, default 20MB (with margin) */
  maxSegmentSize?: number;
  /** Maximum segment duration in seconds, default 600 seconds (10 minutes) */
  maxSegmentDuration?: number;
  /** Temporary file directory */
  tempDir?: string;
}

// ====== Constants ======

// Default configuration
const DEFAULT_MAX_SIZE = 20 * 1024 * 1024; // 20MB, leaving 5MB margin

// ====== Audio Splitter Class ======

/**
 * Audio splitter
 *
 * Uses static methods to organize related functionality, keeping API concise
 */
// biome-ignore lint/complexity/noStaticOnlyClass: Using class to organize related static methods is clearer
export class AudioSplitter {
  /**
   * Check if file needs splitting
   */
  static async needsSplit(filePath: string): Promise<boolean> {
    const stats = await fs.stat(filePath);
    return stats.size > 25 * 1024 * 1024;
  }

  /**
   * Split audio file
   *
   * @param filePath Audio file path
   * @param options Split options
   * @returns List of split segments
   */
  static async split(filePath: string, options?: SplitOptions): Promise<AudioSegment[]> {
    const stats = await fs.stat(filePath);
    const fileSize = stats.size;

    // If file is smaller than 25MB, no splitting needed
    if (fileSize <= 25 * 1024 * 1024) {
      logger.info('[AudioSplitter] File does not need splitting:', filePath);
      return [
        {
          filePath,
          startTime: 0,
          endTime: -1, // Unknown
          index: 0,
          isTemp: false,
        },
      ];
    }

    logger.info(
      `[AudioSplitter] Starting file split: ${filePath} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`
    );

    const ext = path.extname(filePath).toLowerCase();

    if (ext === '.wav') {
      return AudioSplitter.splitWav(filePath, fileSize, options);
    } else if (ext === '.mp3') {
      return AudioSplitter.splitMp3(filePath, fileSize, options);
    } else {
      // Other formats: simple size-based split (may break frame structure)
      logger.warn(`[AudioSplitter] Unsupported format ${ext}, attempting size-based split`);
      return AudioSplitter.splitBySize(filePath, fileSize, options);
    }
  }

  // ====== WAV File Splitting ======

  /**
   * Split WAV file
   *
   * WAV file structure:
   * - 44-byte header (RIFF header)
   * - PCM data (can be split directly)
   */
  private static async splitWav(
    filePath: string,
    _fileSize: number,
    options?: SplitOptions
  ): Promise<AudioSegment[]> {
    const maxSize = options?.maxSegmentSize || DEFAULT_MAX_SIZE;
    const tempDir = options?.tempDir || path.dirname(filePath);

    // Read file
    const buffer = await fs.readFile(filePath);

    // Validate WAV header
    const riff = buffer.toString('ascii', 0, 4);
    const wave = buffer.toString('ascii', 8, 12);
    if (riff !== 'RIFF' || wave !== 'WAVE') {
      throw new Error('Invalid WAV file format');
    }

    // Find data chunk
    let dataOffset = 12;
    let dataSize = 0;

    while (dataOffset < buffer.length - 8) {
      const chunkId = buffer.toString('ascii', dataOffset, dataOffset + 4);
      const chunkSize = buffer.readUInt32LE(dataOffset + 4);

      if (chunkId === 'data') {
        dataOffset += 8;
        dataSize = chunkSize;
        break;
      }

      dataOffset += 8 + chunkSize;
      // Align to even bytes
      if (chunkSize % 2 !== 0) dataOffset++;
    }

    if (dataSize === 0) {
      throw new Error('Data chunk not found in WAV file');
    }

    const headerSize = dataOffset;
    const header = buffer.slice(0, headerSize);

    const metadata = await musicMetadata.parseFile(filePath);
    const duration = metadata.format.duration || 0;
    const bytesPerSecond = dataSize / duration;

    const segmentDataSize = maxSize - headerSize;
    const numSegments = Math.ceil(dataSize / segmentDataSize);

    logger.info(
      `[AudioSplitter] WAV split: ${numSegments} segments, approximately ${(segmentDataSize / 1024 / 1024).toFixed(2)} MB each`
    );

    const segments: AudioSegment[] = [];
    const baseName = path.basename(filePath, '.wav');

    for (let i = 0; i < numSegments; i++) {
      const startByte = i * segmentDataSize;
      const endByte = Math.min(startByte + segmentDataSize, dataSize);
      const segmentData = buffer.slice(headerSize + startByte, headerSize + endByte);

      // Create new WAV header (update data chunk size)
      const newHeader = Buffer.from(header);
      // Update RIFF size
      newHeader.writeUInt32LE(segmentData.length + headerSize - 8, 4);
      // Update data chunk size
      newHeader.writeUInt32LE(segmentData.length, headerSize - 4);

      // Write segment file
      const segmentPath = path.join(tempDir, `${baseName}_part${i + 1}.wav`);
      const segmentBuffer = Buffer.concat([newHeader, segmentData]);
      await fs.writeFile(segmentPath, segmentBuffer);

      const startTime = startByte / bytesPerSecond;
      const endTime = endByte / bytesPerSecond;

      segments.push({
        filePath: segmentPath,
        startTime,
        endTime,
        index: i,
        isTemp: true,
      });

      logger.info(
        `[AudioSplitter] Created segment ${i + 1}/${numSegments}: ${startTime.toFixed(1)}s - ${endTime.toFixed(1)}s`
      );
    }

    return segments;
  }

  // ====== MP3 File Splitting ======

  /**
   * Split MP3 file
   *
   * MP3 is a frame-compressed format, needs to split at frame boundaries
   * Simplified approach: split by size, cut at frame sync words (0xFF 0xFB/FA/F3/F2)
   */
  private static async splitMp3(
    filePath: string,
    fileSize: number,
    options?: SplitOptions
  ): Promise<AudioSegment[]> {
    const maxSize = options?.maxSegmentSize || DEFAULT_MAX_SIZE;
    const tempDir = options?.tempDir || path.dirname(filePath);

    const buffer = await fs.readFile(filePath);

    const metadata = await musicMetadata.parseFile(filePath);
    const duration = metadata.format.duration || 0;
    const bytesPerSecond = fileSize / duration;

    // Skip ID3v2 header if present (MP3 files may have metadata header)
    let dataStart = 0;
    if (buffer.toString('ascii', 0, 3) === 'ID3') {
      // ID3v2 header size is in bytes 6-9 (syncsafe integer)
      const size =
        ((buffer[6] & 0x7f) << 21) |
        ((buffer[7] & 0x7f) << 14) |
        ((buffer[8] & 0x7f) << 7) |
        (buffer[9] & 0x7f);
      dataStart = 10 + size;
    }

    const numSegments = Math.ceil(fileSize / maxSize);
    const targetSegmentSize = Math.ceil(fileSize / numSegments);

    logger.info(`[AudioSplitter] MP3 split: ${numSegments} segments`);

    const segments: AudioSegment[] = [];
    const baseName = path.basename(filePath, '.mp3');

    let currentPos = dataStart;

    for (let i = 0; i < numSegments; i++) {
      const startPos = currentPos;
      let endPos = Math.min(startPos + targetSegmentSize, buffer.length);

      // If not the last segment, find nearest frame sync word
      if (i < numSegments - 1 && endPos < buffer.length) {
        endPos = AudioSplitter.findMp3FrameSync(buffer, endPos);
      }

      const segmentData = buffer.slice(startPos, endPos);

      const segmentPath = path.join(tempDir, `${baseName}_part${i + 1}.mp3`);
      await fs.writeFile(segmentPath, segmentData);

      const startTime = (startPos - dataStart) / bytesPerSecond;
      const endTime = (endPos - dataStart) / bytesPerSecond;

      segments.push({
        filePath: segmentPath,
        startTime,
        endTime,
        index: i,
        isTemp: true,
      });

      currentPos = endPos;

      logger.info(
        `[AudioSplitter] Created segment ${i + 1}/${numSegments}: ${startTime.toFixed(1)}s - ${endTime.toFixed(1)}s`
      );
    }

    return segments;
  }

  /**
   * Find frame sync word position in MP3
   *
   * MP3 frames start with 0xFF, followed by 0xE0-0xFF
   * Why search backwards? Ensures we don't break frame boundaries when splitting
   */
  private static findMp3FrameSync(buffer: Buffer, startPos: number): number {
    for (let i = startPos; i > startPos - 4096 && i > 0; i--) {
      if (buffer[i] === 0xff && (buffer[i + 1] & 0xe0) === 0xe0) {
        return i;
      }
    }
    return startPos;
  }

  // ====== Generic Size-Based Splitting ======

  /**
   * Simple size-based split (generic approach)
   */
  private static async splitBySize(
    filePath: string,
    fileSize: number,
    options?: SplitOptions
  ): Promise<AudioSegment[]> {
    const maxSize = options?.maxSegmentSize || DEFAULT_MAX_SIZE;
    const tempDir = options?.tempDir || path.dirname(filePath);

    const buffer = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    const baseName = path.basename(filePath, ext);

    const numSegments = Math.ceil(fileSize / maxSize);
    const segments: AudioSegment[] = [];

    let duration = 0;
    try {
      const metadata = await musicMetadata.parseFile(filePath);
      duration = metadata.format.duration || 0;
    } catch {
      // Ignore metadata read errors
    }

    const bytesPerSecond = duration > 0 ? fileSize / duration : 0;

    for (let i = 0; i < numSegments; i++) {
      const startPos = i * maxSize;
      const endPos = Math.min(startPos + maxSize, fileSize);

      const segmentData = buffer.slice(startPos, endPos);
      const segmentPath = path.join(tempDir, `${baseName}_part${i + 1}${ext}`);
      await fs.writeFile(segmentPath, segmentData);

      const startTime =
        bytesPerSecond > 0 ? startPos / bytesPerSecond : i * (duration / numSegments);
      const endTime =
        bytesPerSecond > 0 ? endPos / bytesPerSecond : (i + 1) * (duration / numSegments);

      segments.push({
        filePath: segmentPath,
        startTime,
        endTime,
        index: i,
        isTemp: true,
      });
    }

    return segments;
  }

  /**
   * Clean up temporary files
   */
  static async cleanup(segments: AudioSegment[]): Promise<void> {
    for (const segment of segments) {
      if (segment.isTemp) {
        try {
          await fs.remove(segment.filePath);
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  }
}
