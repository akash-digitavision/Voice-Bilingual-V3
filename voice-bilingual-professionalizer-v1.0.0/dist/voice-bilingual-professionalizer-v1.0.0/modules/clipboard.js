/**
 * Unicode-Safe Clipboard Module (Phase 10)
 * Preserves Bangla Unicode, English punctuation, and line breaks.
 */

export async function copyToClipboard(text) {
  if (!text) return false;

  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (err) {
    console.warn('navigator.clipboard failed, attempting fallback:', err);
  }

  // Robust fallback for extension or iframe contexts
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-999999px';
    textarea.style.top = '-999999px';
    textarea.setAttribute('readonly', '');
    document.body.appendChild(textarea);
    textarea.select();
    const success = document.execCommand('copy');
    document.body.removeChild(textarea);
    return success;
  } catch (fallbackErr) {
    console.error('Clipboard copy failed:', fallbackErr);
    return false;
  }
}
