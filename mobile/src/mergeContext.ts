/**
 * mergeContext.ts: Combines audio transcript and OCR text into a single
 * context object before passing it to the verification pipeline.
 *
 * In Phase 1 (audio-only), the OCR text array will be empty and the
 * merged context is simply the audio transcript. In Phase 2, both
 * streams contribute to a richer context.
 */

export interface OcrEntry {
  /** Extracted text from a single frame. */
  text: string;
  /** Timestamp (ms from recording start) when the frame was captured. */
  timestamp: number;
}

export interface MergedContext {
  /** The combined text to send to claim extraction. */
  combinedText: string;
  /** Whether OCR data was available and contributed to the context. */
  hasVisualContext: boolean;
  /** The raw audio transcript. */
  audioTranscript: string;
  /** The time-ordered OCR entries (empty in Phase 1). */
  ocrEntries: OcrEntry[];
}

/**
 * Merge the audio transcript and time-ordered OCR text results into a
 * single context string for claim extraction.
 *
 * The output format is designed so the LLM sees both what was *said*
 * (audio) and what was *shown* (on-screen text) without conflating them.
 */
export function mergeContext(
  audioTranscript: string,
  ocrEntries: OcrEntry[] = [],
): MergedContext {
  // Phase 1: audio-only, no OCR data
  if (ocrEntries.length === 0 || ocrEntries.every((e) => !e.text.trim())) {
    return {
      combinedText: audioTranscript,
      hasVisualContext: false,
      audioTranscript,
      ocrEntries: [],
    };
  }

  // Phase 2: merge audio + visual
  // Deduplicate near-identical OCR results (same text appearing in consecutive frames)
  const uniqueOcr = deduplicateOcr(ocrEntries);

  const ocrSection = uniqueOcr
    .map((e) => `[On-screen at ${formatTimestamp(e.timestamp)}]: ${e.text}`)
    .join('\n');

  const combinedText =
    `[Audio transcript]:\n${audioTranscript}\n\n` +
    `[On-screen text/captions]:\n${ocrSection}`;

  return {
    combinedText,
    hasVisualContext: true,
    audioTranscript,
    ocrEntries: uniqueOcr,
  };
}

/**
 * Remove near-duplicate OCR entries where the text is identical or
 * very similar to the previous entry (common when on-screen text
 * persists across multiple frame captures).
 */
function deduplicateOcr(entries: OcrEntry[]): OcrEntry[] {
  if (entries.length === 0) return [];

  const result: OcrEntry[] = [entries[0]];
  for (let i = 1; i < entries.length; i++) {
    const prev = result[result.length - 1].text.trim().toLowerCase();
    const curr = entries[i].text.trim().toLowerCase();
    // Skip if identical or if the current is a substring of the previous
    if (curr === prev || prev.includes(curr) || curr.includes(prev)) {
      continue;
    }
    result.push(entries[i]);
  }
  return result;
}

function formatTimestamp(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return `${seconds}s`;
}
