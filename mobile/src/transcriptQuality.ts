/**
 * Conservative gate before a transcript is allowed to reach claim extraction.
 * Short/noisy ASR fragments are not enough context for a model to distinguish
 * a factual statement from an accidental token, so treating them as "no claim"
 * is safer than manufacturing a confident sentence around them.
 */
export function isCheckableTranscript(text: string): boolean {
  const normalized = String(text || '').normalize('NFKC').trim();
  const meaningful = normalized.match(/[\p{L}\p{N}]/gu) || [];
  if (meaningful.length < 8) return false;

  if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(normalized)) {
    return true;
  }

  const tokens = normalized
    .split(/\s+/)
    .filter(token => /[\p{L}\p{N}]/u.test(token));
  return tokens.length >= 3;
}
