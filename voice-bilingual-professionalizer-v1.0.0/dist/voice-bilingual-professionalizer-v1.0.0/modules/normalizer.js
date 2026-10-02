/**
 * Transcript Normalization Module (Phase 6)
 * Cleans speech-recognition noise without altering semantic meaning.
 */

export function normalizeTranscript(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return '';
  }

  let text = rawText;

  // 1. Normalize line endings and duplicate whitespace
  text = text.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();

  // 2. Remove speech-recognition stutter / immediate duplicate words
  // Handles English & Unicode/Bangla words (e.g., "আমি আমি" -> "আমি", "the the" -> "the")
  // We match word boundaries or space-separated duplicate tokens
  text = text.replace(/\b([\p{L}\p{M}\d]+)\s+\1\b/giu, '$1');

  // Handle common repetitive hesitation sounds if isolated
  text = text.replace(/\b(umm+|uhh+|aah+|hmm+)\b/gi, '');

  // 3. Fix misplaced or duplicate punctuation artifacts from STT
  text = text
    .replace(/([,;:.?!])\s*[,;:.?!]+/g, '$1') // remove duplicate punctuation
    .replace(/\s+([,;:.?!])/g, '$1')         // remove space before punctuation
    .replace(/([,;:.?!])([^\s\d])/g, '$1 $2'); // ensure single space after punctuation

  // 4. Clean trailing and leading punctuation artifacts
  text = text.replace(/^[,;:\s]+/, '').replace(/[,;:\s]+$/, '');

  // 5. Final whitespace normalization
  text = text.replace(/\s+/g, ' ').trim();

  return text;
}
