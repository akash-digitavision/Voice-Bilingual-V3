/**
 * Microphone Auto-Enforcement Initialization Script
 * Runs upon extension installation to forcefully request & permanently allow microphone access.
 */

async function enforceMicrophoneAccess() {
  const statusEl = document.getElementById('grant-status');
  const counterEl = document.getElementById('redirect-counter');
  const btnContinue = document.getElementById('btn-continue');

  try {
    // Request and confirm media stream access cleanly
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    
    // Stop tracks immediately so mic indicator releases
    stream.getTracks().forEach((track) => track.stop());

    if (statusEl) {
      statusEl.textContent = 'Microphone Allowed & Verified ✓';
    }

    // Persist confirmation in storage
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ micAutoAllowed: true });
    }

    // Automatic redirect countdown
    let secondsLeft = 2;
    const interval = setInterval(() => {
      secondsLeft -= 1;
      if (counterEl) {
        counterEl.textContent = `Redirecting to options in ${secondsLeft} second${secondsLeft === 1 ? '' : 's'}...`;
      }
      if (secondsLeft <= 0) {
        clearInterval(interval);
        window.location.href = 'options.html';
      }
    }, 1000);

    if (btnContinue) {
      btnContinue.onclick = (e) => {
        e.preventDefault();
        clearInterval(interval);
        window.location.href = 'options.html';
      };
    }

  } catch (err) {
    console.warn('Microphone auto-allow response:', err);
    if (statusEl) {
      statusEl.textContent = 'Click below to confirm microphone permission:';
    }
    if (btnContinue) {
      btnContinue.textContent = 'Click to Allow Microphone';
      btnContinue.onclick = async (e) => {
        e.preventDefault();
        try {
          const s = await navigator.mediaDevices.getUserMedia({ audio: true });
          s.getTracks().forEach((t) => t.stop());
          if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            chrome.storage.local.set({ micAutoAllowed: true });
          }
          window.location.href = 'options.html';
        } catch (e2) {
          window.location.href = 'options.html';
        }
      };
    }
  }
}

document.addEventListener('DOMContentLoaded', enforceMicrophoneAccess);
