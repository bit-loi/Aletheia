/**
 * mergeContext.ts: Prepares the audio transcript as context for the
 * verification pipeline.
 */

export interface MergedContext {
  /** The combined text to send to claim extraction. */
  combinedText: string;
  /** Whether visual context was available (always false in audio-only mode). */
  hasVisualContext: boolean;
  /** The raw audio transcript. */
  audioTranscript: string;
}

/**
 * Wrap the audio transcript into a MergedContext for the claim extraction
 * pipeline.
 */
export function mergeContext(audioTranscript: string): MergedContext {
  return {
    combinedText: audioTranscript,
    hasVisualContext: false,
    audioTranscript,
  };
}
