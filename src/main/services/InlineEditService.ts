/**
 * @file InlineEditService — Studio-direct (no SNACA) implementation of
 *   Ctrl+K inline edit. Streams a single LLM completion using the same
 *   `AIService` configuration users already maintain for chat / completion.
 *
 * Why direct: Ctrl+K is single-shot (instruction → replacement). Going
 * through the SNACA agent loop would add ~3 hops of latency and force
 * users to maintain a second LLM config. See `scipen-studio_snaca.md` §
 * decision matrix — we picked "B" (Studio direct) over the calendar plan's
 * "A" (SNACA InlineEdit tool) precisely for this trade-off.
 *
 * Concurrency: each `start()` allocates a fresh `AbortController` keyed by
 * its own turn id, so two widgets can run simultaneously without the
 * `chatStream` single-flight constraint biting us.
 *
 * Sanitisation: LLMs frequently wrap their output in ``` fences despite
 * the system prompt's instructions. We strip the outer fence on
 * `complete` (but not on deltas — the renderer needs the raw byte stream
 * to drive its ghost text). The renderer should display deltas verbatim
 * and only commit the sanitised `fullText` to the buffer.
 */

import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { type LanguageModel, streamText } from 'ai';
import { Emitter, type Event } from '@shared/utils/event';
import { createLogger } from './LoggerService';
import type { AIConfig, IAIService } from './interfaces';
import type {
  IInlineEditService,
  InlineEditCompleteEvent,
  InlineEditDeltaEvent,
  InlineEditErrorEvent,
  InlineEditStartParams,
} from './interfaces/IInlineEditService';

const logger = createLogger('InlineEdit');

/** Hard cap on the surrounding-context block we forward to the LLM. */
const MAX_SURROUNDING_CHARS = 4096;

/**
 * Output discipline. Mirrors what Cursor / Codeium send on Ctrl+K — short,
 * forceful, and aimed at suppressing the urge to "explain the change".
 */
const SYSTEM_PROMPT = [
  'You are an inline code editor. Apply the user\'s instruction to the SELECTED text.',
  'Output ONLY the replacement text — no explanations, no markdown code fences, no commentary.',
  'Preserve the surrounding code\'s indentation, style, and language conventions.',
  'If the instruction is impossible or ambiguous, return the selection unchanged.',
].join('\n');

export interface InlineEditServiceDeps {
  aiService: IAIService;
}

interface InflightTurn {
  controller: AbortController;
}

export class InlineEditService implements IInlineEditService {
  private readonly _onDelta = new Emitter<InlineEditDeltaEvent>();
  readonly onDelta: Event<InlineEditDeltaEvent> = this._onDelta.event;

  private readonly _onComplete = new Emitter<InlineEditCompleteEvent>();
  readonly onComplete: Event<InlineEditCompleteEvent> = this._onComplete.event;

  private readonly _onError = new Emitter<InlineEditErrorEvent>();
  readonly onError: Event<InlineEditErrorEvent> = this._onError.event;

  private readonly inflight = new Map<string, InflightTurn>();
  private turnCounter = 0;
  private disposed = false;

  constructor(private readonly deps: InlineEditServiceDeps) {}

  async start(params: InlineEditStartParams): Promise<{ turnId: string }> {
    if (this.disposed) {
      throw new Error('InlineEditService disposed');
    }
    const cfg = this.deps.aiService.getConfig();
    if (!cfg || !this.deps.aiService.isConfigured()) {
      const err: InlineEditErrorEvent = {
        turnId: '',
        message: 'AI is not configured. Set provider + API key in Settings.',
        code: 'not_configured',
      };
      throw Object.assign(new Error(err.message), { code: err.code });
    }

    const turnId = this.nextTurnId();
    const controller = new AbortController();
    this.inflight.set(turnId, { controller });

    // Fire-and-forget the stream; results flow through events. Keeps `start`
    // returning quickly so the renderer can mount the ghost-text widget
    // without waiting on the first token.
    void this.runStream(turnId, cfg, params, controller);

    return { turnId };
  }

  cancel(turnId: string): { ok: boolean } {
    const turn = this.inflight.get(turnId);
    if (!turn) return { ok: false };
    turn.controller.abort();
    this.inflight.delete(turnId);
    return { ok: true };
  }

  dispose(): void {
    this.disposed = true;
    for (const [, turn] of this.inflight) turn.controller.abort();
    this.inflight.clear();
    this._onDelta.dispose();
    this._onComplete.dispose();
    this._onError.dispose();
  }

  // ============ Internals ============

  private async runStream(
    turnId: string,
    cfg: AIConfig,
    params: InlineEditStartParams,
    controller: AbortController
  ): Promise<void> {
    let acc = '';
    try {
      const model = buildModel(cfg);
      const userPrompt = renderUserPrompt(params);

      const result = streamText({
        model,
        system: SYSTEM_PROMPT,
        prompt: userPrompt,
        maxOutputTokens: cfg.maxTokens,
        temperature: cfg.temperature,
        abortSignal: controller.signal,
      });

      for await (const chunk of result.textStream) {
        if (controller.signal.aborted) return;
        if (!chunk) continue;
        acc += chunk;
        this._onDelta.fire({ turnId, delta: chunk });
      }

      this._onComplete.fire({ turnId, fullText: stripCodeFence(acc) });
    } catch (err) {
      const aborted =
        controller.signal.aborted ||
        (err instanceof Error && (err.name === 'AbortError' || /aborted/i.test(err.message)));
      const message = err instanceof Error ? err.message : String(err);
      if (aborted) {
        // Treat as a clean cancel, not an error — the renderer already
        // tore down the widget; surfacing a red banner would be misleading.
        this._onError.fire({ turnId, message: 'cancelled', code: 'aborted' });
      } else {
        logger.error('inline edit stream failed', { turnId, error: message });
        this._onError.fire({ turnId, message: friendlyError(message), code: 'provider_error' });
      }
    } finally {
      this.inflight.delete(turnId);
    }
  }

  private nextTurnId(): string {
    this.turnCounter += 1;
    return `inline-${Date.now()}-${this.turnCounter}`;
  }
}

export function createInlineEditService(deps: InlineEditServiceDeps): InlineEditService {
  return new InlineEditService(deps);
}

// ============ Helpers ============

/**
 * Build a LanguageModel from `AIConfig`. Mirrors `AIService.createModel` but
 * keeps lifecycle (abort, in-flight tracking) under InlineEditService's own
 * roof so we don't collide with the chat-side single-flight controller.
 */
function buildModel(cfg: AIConfig): LanguageModel {
  if (cfg.provider === 'anthropic') {
    const anthropic = createAnthropic({
      apiKey: cfg.apiKey,
      baseURL: cfg.baseUrl || undefined,
    });
    return anthropic(cfg.model);
  }
  const openai = createOpenAI({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseUrl,
  });
  // .chat() forces Chat Completions API — many OpenAI-compatible endpoints
  // still don't speak the new Responses API.
  return openai.chat(cfg.model);
}

function renderUserPrompt(p: InlineEditStartParams): string {
  const lines: string[] = [];
  if (p.fileLabel) lines.push(`File: ${p.fileLabel} (${p.language})`);
  else lines.push(`Language: ${p.language}`);
  lines.push('');
  lines.push(`Instruction: ${p.instruction.trim()}`);
  lines.push('');
  lines.push('Selected text:');
  lines.push(p.selectedText);
  if (p.surroundingContext) {
    const cap = p.surroundingContext.slice(0, MAX_SURROUNDING_CHARS);
    lines.push('');
    lines.push('Surrounding context (for reference, not to be edited):');
    lines.push(cap);
  }
  return lines.join('\n');
}

/**
 * Strip a single outer ``` (optionally language-tagged) fence if the LLM
 * wrapped its reply in one. We only peel the outermost layer; nested
 * fences (e.g. an actual `\verb` block in LaTeX) stay intact.
 */
function stripCodeFence(s: string): string {
  const trimmed = s.trim();
  // Match ```optional-lang\n…\n```
  const m = /^```[a-zA-Z0-9_+\-.]*\n([\s\S]*?)\n```$/.exec(trimmed);
  return m ? m[1] : s;
}

function friendlyError(message: string): string {
  if (/insufficient|balance/i.test(message)) return 'Insufficient balance, please top up';
  if (/rate limit|429/i.test(message)) return 'Rate limit exceeded, please retry later';
  if (/401|Unauthorized/i.test(message)) return 'Invalid or expired API Key';
  if (/timeout|ETIMEDOUT/i.test(message)) return 'Request timeout, check network connection';
  return message;
}
