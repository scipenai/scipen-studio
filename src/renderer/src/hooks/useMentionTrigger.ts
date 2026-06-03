/**
 * @file useMentionTrigger — pure parser that locates the `@token` the
 *   user is currently typing inside a text input. Returns the slice
 *   indices so callers can replace exactly the right range when a
 *   dropdown selection lands.
 *
 * Token boundary mirrors `AtMentionResolver`'s `MENTION_TOKEN_REGEX`
 * (`@` followed by anything except whitespace + common punctuation /
 * brackets). The `@` itself must sit at the start of input or after
 * one of those same boundary characters — otherwise `foo@bar.com`
 * style emails would falsely trigger the dropdown.
 */

import { useMemo } from 'react';

export interface MentionTrigger {
  /** Text between `@` and caret, lower-cased and trimmed for matching. */
  query: string;
  /** Slice index of `@` in `value`. */
  replaceFrom: number;
  /** Slice index just past the last typed character (== caret position). */
  replaceTo: number;
}

// Same character class as MENTION_TOKEN_REGEX in AtMentionResolver — keep
// the two in sync so the dropdown doesn't pop on text the resolver
// won't actually treat as a mention.
const TOKEN_BOUNDARY = /[\s,;!?()[\]{}'"<>]/;

export function useMentionTrigger(value: string, caretPos: number): MentionTrigger | null {
  return useMemo(() => parseMentionTrigger(value, caretPos), [value, caretPos]);
}

export function parseMentionTrigger(value: string, caretPos: number): MentionTrigger | null {
  if (caretPos <= 0 || caretPos > value.length) return null;
  // Walk backwards from caret looking for `@`. Stop on any boundary
  // character — we're inside a mention token only if there's an
  // uninterrupted run of non-boundary chars between `@` and the caret.
  let i = caretPos - 1;
  while (i >= 0) {
    const c = value[i];
    if (c === '@') break;
    if (TOKEN_BOUNDARY.test(c)) return null;
    i--;
  }
  if (i < 0 || value[i] !== '@') return null;
  // The `@` itself must be at string start or follow a boundary char,
  // otherwise it's part of something like `foo@bar.com`.
  if (i > 0 && !TOKEN_BOUNDARY.test(value[i - 1])) return null;
  return {
    query: value.slice(i + 1, caretPos),
    replaceFrom: i,
    replaceTo: caretPos,
  };
}
