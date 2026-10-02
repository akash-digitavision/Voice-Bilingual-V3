/**
 * OAuth 2.0 PKCE Client Module
 * Supports RFC 7636 Authorization Code Flow with PKCE for Chrome Extensions and Web.
 */

import { saveSettings } from './storage.js';

export function getRedirectUri() {
  if (typeof chrome !== 'undefined' && chrome.identity && chrome.identity.getRedirectURL) {
    return chrome.identity.getRedirectURL('oauth2');
  }
  return window.location.origin + '/oauth-callback.html';
}

function generateRandomString(length = 64) {
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, byte => charset[byte % charset.length]).join('');
}

async function sha256(plain) {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  return await crypto.subtle.digest('SHA-256', data);
}

function base64UrlEncode(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export async function generatePKCE() {
  const verifier = generateRandomString(64);
  const hash = await sha256(verifier);
  const challenge = base64UrlEncode(hash);
  const state = generateRandomString(32);
  return { verifier, challenge, state };
}

export function parseJwt(token) {
  try {
    const base64Url = token.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(
      atob(base64)
        .split('')
        .map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    );
    return JSON.parse(jsonPayload);
  } catch (e) {
    return null;
  }
}

export async function initiateOAuthFlow(config = {}) {
  const authEndpoint = config.authEndpoint || 'https://auth.openai.com/oauth/authorize';
  const tokenEndpoint = config.tokenEndpoint || 'https://auth.openai.com/oauth/token';
  const clientId = (config.clientId || '').trim();
  const scope = config.scope || 'openid profile email offline_access';
  const redirectUri = getRedirectUri();

  if (!clientId) {
    throw new Error('OAuth Client ID is required. Please enter your OAuth Client ID in Settings.');
  }

  const { verifier, challenge, state } = await generatePKCE();

  const authUrl = new URL(authEndpoint);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', scope);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  // If in Chrome extension environment with identity permission
  if (typeof chrome !== 'undefined' && chrome.identity && chrome.identity.launchWebAuthFlow) {
    return new Promise((resolve, reject) => {
      chrome.identity.launchWebAuthFlow(
        {
          url: authUrl.toString(),
          interactive: true
        },
        async (redirectUrl) => {
          if (chrome.runtime.lastError) {
            const rawMsg = chrome.runtime.lastError.message || '';
            if (rawMsg.includes('could not be loaded') || rawMsg.includes('403')) {
              return reject(new Error(
                'OpenAI blocks external browser extensions from auth.openai.com (Cloudflare 403). ' +
                'OpenAI does not provide a public OAuth login portal for extensions. ' +
                'Please use an OpenAI Platform API Key or the Free Built-in Gateway.'
              ));
            }
            return reject(new Error(rawMsg || 'OAuth authorization window was closed.'));
          }

          if (!redirectUrl) {
            return reject(new Error('No redirect URL returned from OAuth authorization.'));
          }

          try {
            const urlObj = new URL(redirectUrl);
            const returnedState = urlObj.searchParams.get('state');
            const code = urlObj.searchParams.get('code');
            const error = urlObj.searchParams.get('error');
            const errorDescription = urlObj.searchParams.get('error_description');

            if (error) {
              return reject(new Error(errorDescription || error || 'OAuth server returned an error.'));
            }

            if (returnedState !== state) {
              return reject(new Error('OAuth state mismatch (possible CSRF attempt).'));
            }

            if (!code) {
              return reject(new Error('No authorization code was returned in callback.'));
            }

            // Exchange code for tokens
            const tokens = await exchangeCodeForToken({
              tokenEndpoint,
              clientId,
              code,
              verifier,
              redirectUri
            });

            resolve(tokens);
          } catch (err) {
            reject(err);
          }
        }
      );
    });
  }

  // Web fallback window
  return new Promise((resolve, reject) => {
    const width = 560;
    const height = 680;
    const left = window.screenX + (window.outerWidth - width) / 2;
    const top = window.screenY + (window.outerHeight - height) / 2.5;

    const popup = window.open(
      authUrl.toString(),
      'OAuth2_Login',
      `width=${width},height=${height},left=${left},top=${top},status=0,toolbar=0,menubar=0`
    );

    if (!popup) {
      return reject(new Error('Popup blocked by browser. Please allow popups for this site.'));
    }

    const checkTimer = setInterval(() => {
      try {
        if (popup.closed) {
          clearInterval(checkTimer);
          return reject(new Error('OAuth authorization window was closed before completion.'));
        }

        // Check if redirect occurred
        if (popup.location.href.includes(redirectUri)) {
          clearInterval(checkTimer);
          const urlObj = new URL(popup.location.href);
          popup.close();

          const code = urlObj.searchParams.get('code');
          const returnedState = urlObj.searchParams.get('state');

          if (returnedState !== state) {
            return reject(new Error('State mismatch error.'));
          }

          if (!code) {
            return reject(new Error('No code returned.'));
          }

          exchangeCodeForToken({
            tokenEndpoint,
            clientId,
            code,
            verifier,
            redirectUri
          }).then(resolve).catch(reject);
        }
      } catch (e) {
        // Cross-origin restriction before redirect is normal
      }
    }, 500);
  });
}

export async function exchangeCodeForToken({ tokenEndpoint, clientId, code, verifier, redirectUri }) {
  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('client_id', clientId);
  body.set('code', code);
  body.set('code_verifier', verifier);
  body.set('redirect_uri', redirectUri);

  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json'
    },
    body: body.toString()
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Token exchange failed (HTTP ${response.status}): ${errText}`);
  }

  const data = await response.json();
  let userEmail = '';

  if (data.id_token) {
    const claims = parseJwt(data.id_token);
    userEmail = claims?.email || claims?.preferred_username || claims?.name || '';
  }

  await saveSettings({
    oauthConnected: true,
    oauthAccessToken: data.access_token || '',
    oauthRefreshToken: data.refresh_token || '',
    oauthExpiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : 0,
    oauthUserEmail: userEmail || 'Verified User'
  });

  return {
    ...data,
    userEmail
  };
}
