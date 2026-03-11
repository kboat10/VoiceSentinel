/**
 * Voice Sentinel – Web UI.
 * API base: local/dev = http://45.55.247.199/api; on Vercel = /api (proxied in vercel.json).
 * All APIs use this base; none send the user's name.
 * Endpoints: POST /auth/register, POST /auth/login, GET /user/me, PATCH /user/update, POST /auth/change-password, DELETE /user/terminate, GET /system/stats, POST /forensics/predict (multipart: file, user_id, recording_input_type).
 */
const API_BASE =
  typeof window !== 'undefined' &&
  window.location &&
  window.location.hostname.endsWith('vercel.app')
    ? '/api'
    : 'http://45.55.247.199/api';

const AUTH_TOKEN_KEY = 'voiceSentinelToken';
const USER_ID_KEY = 'voiceSentinelUserId';
const USER_EMAIL_KEY = 'voiceSentinelEmail';
const USER_NAME_STORAGE_KEY = 'voiceSentinelUserName';
const EDIT_PROFILE_STORAGE_KEY = 'voiceSentinelUserType';
const SAMPLES_STORAGE_KEY = 'voiceSentinelSamples';
const RECORDING_INPUT_TYPE_KEY = 'recording_input_type';
const PREDICTION_FEEDBACK_ENDPOINT = 'forensics/feedback';

const ALLOWED_AUDIO_TYPES = ['audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp3'];
const ALLOWED_AUDIO_EXTS = ['.wav', '.mp3'];

function isAllowedAudioFile(file) {
  if (!file) return false;
  const ext = (file.name || '').toLowerCase().replace(/^.*(\.\w+)$/, '$1');
  return ALLOWED_AUDIO_TYPES.includes(file.type) || ALLOWED_AUDIO_EXTS.includes(ext);
}

function sampleStorageKey(uid) {
  return `${SAMPLES_STORAGE_KEY}_${uid}`;
}

function getSavedSamples(uid) {
  const id = uid ?? state.userId ?? getStoredUserId();
  if (id == null) return [];
  try {
    const raw = localStorage.getItem(sampleStorageKey(id));
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveSampleFootprint(entry) {
  const uid = entry.user_id ?? state.userId ?? getStoredUserId();
  if (uid == null) return;
  try {
    const samples = getSavedSamples(uid);
    samples.unshift(entry);
    if (samples.length > 200) samples.length = 200;
    localStorage.setItem(sampleStorageKey(uid), JSON.stringify(samples));
  } catch (_) {}
}

/** Returns the stored auth token, or null if not logged in. */
function getAuthToken() {
  try { return localStorage.getItem(AUTH_TOKEN_KEY); } catch { return null; }
}

/** Returns the stored user id as a number, or null. */
function getStoredUserId() {
  try {
    const v = localStorage.getItem(USER_ID_KEY);
    return v != null ? Number(v) : null;
  } catch { return null; }
}

/** Returns the stored user email, or null. */
function getStoredEmail() {
  try { return localStorage.getItem(USER_EMAIL_KEY); } catch { return null; }
}

function getStoredUserName() {
  try { return localStorage.getItem(USER_NAME_STORAGE_KEY); } catch { return null; }
}

function getStoredUserType() {
  try { return localStorage.getItem(EDIT_PROFILE_STORAGE_KEY); } catch { return null; }
}

/** Persist user id and email to localStorage + state. */
function storeUserIdentity(id, email) {
  if (id != null) {
    state.userId = Number(id);
    try { localStorage.setItem(USER_ID_KEY, String(id)); } catch (_) {}
  }
  if (email) {
    try { localStorage.setItem(USER_EMAIL_KEY, email); } catch (_) {}
  }
}

/** Clears all auth-related storage (token, user id, email). */
function clearAuthToken() {
  try {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(USER_ID_KEY);
    localStorage.removeItem(USER_EMAIL_KEY);
  } catch (_) {}
  state.userId = null;
  updateUserSurface();
}

/**
 * Fetch helper that calls the API with the auth token attached.
 * @param {string} path - Path relative to API_BASE (e.g. '/auth/login' or 'users/me')
 * @param {RequestInit} [options] - Same as fetch() options; headers are merged with Authorization if token exists.
 * @returns {Promise<Response>}
 */
function apiFetch(path, options = {}) {
  const url = path.startsWith('http') ? path
    : path.startsWith('/api/') ? path
    : `${API_BASE.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
  const token = getAuthToken();
  const headers = new Headers(options.headers || {});
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return fetch(url, { ...options, headers });
}

/** User-friendly message for network/fetch errors (e.g. CORS, offline, server down). */
function formatNetworkError(err) {
  const msg = err?.message ?? '';
  if (/failed to fetch|network error|load failed|networkrequestfailed/i.test(msg)) {
    return 'Could not reach the server. Check your internet connection and try again. If you\'re opening the app from a different origin, the server may need to allow it (CORS).';
  }
  if (/ROUTER_EXTERNAL_TARGET_CONNECTION|connection error|target connection/i.test(msg)) {
    return 'Could not connect to the API. The backend may be unavailable or unreachable. Please try again later.';
  }
  return msg || 'Network error. Please try again.';
}
/** If response body indicates a proxy/connection failure, return a user-friendly message; otherwise return null. */
function formatApiConnectionError(res, text) {
  if (!text || typeof text !== 'string') return null;
  if (/ROUTER_EXTERNAL_TARGET_CONNECTION|connection error|target connection|could not connect/i.test(text)) {
    return 'Could not connect to the API. The backend may be unavailable or unreachable. Please try again later.';
  }
  if (res.status >= 502 && res.status <= 504) {
    return 'The API is temporarily unavailable. Please try again in a moment.';
  }
  return null;
}

// --- State (UI only) ---
const state = {
  theme: 'light',
  isRecording: false,
  isPaused: false,
  recordingSeconds: 0,
  recordings: [],
  timerId: null,
  waveformIntervalId: null,
  amplitudeHistory: [],
  maxBars: 36,
  // Real audio waveform
  mediaStream: null,
  audioContext: null,
  analyser: null,
  waveformAnimationId: null,
  // Recording capture for playback in review
  mediaRecorder: null,
  pcmCapture: null,
  recordedBlob: null,
  reviewAudioUrl: null,
  /** Current blob/file in review modal (for POST forensics/predict). */
  reviewBlob: null,
  /** Source type sent to API: upload | live_source | live_user */
  reviewInputType: null,
  /** Current live capture type selected before recording starts. */
  currentLiveInputType: null,
  /** Current prediction context used when collecting user vote/feedback. */
  predictionFeedbackContext: null,
  /** Tracks samples already voted on to avoid repeat prompts in one session. */
  feedbackSubmittedSamples: {},
  /** Prevents opening duplicate feedback modals. */
  feedbackPromptActive: false,
  /** User id from GET /user/me (for forensics API). */
  userId: null,
};

function formatSentinelScore(confidence) {
  return confidence != null ? `${(confidence * 100).toFixed(1)}%` : '—';
}

function getPredictionConfidence(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const raw = obj.confidence ?? obj.confidence_score ?? obj.confidenceScore;
  if (raw == null || raw === '') return null;
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

function updateUserSurface() {
  const name = getStoredUserName();
  const email = getStoredEmail();
  const userType = getStoredUserType() || 'BASIC';
  const isAuthenticated = !!getAuthToken();

  const greetEl = document.getElementById('home-greeting');
  if (greetEl) greetEl.textContent = isAuthenticated && name ? `Welcome back, ${name}` : 'Welcome back';

  const settingsName = document.getElementById('settings-user-name');
  const settingsMeta = document.getElementById('settings-user-meta');
  const settingsBadge = document.getElementById('settings-user-type-badge');
  if (settingsName) settingsName.textContent = isAuthenticated ? (name || email || 'Signed-in user') : 'Guest user';
  if (settingsMeta) settingsMeta.textContent = isAuthenticated ? (email || 'History and exports are linked to your account.') : 'Sign in to sync history and exports.';
  if (settingsBadge) settingsBadge.textContent = userType.charAt(0) + userType.slice(1).toLowerCase();
}

function updateVoiceLabSummary() {
  const header = document.getElementById('recent-recordings-header');
  const titleEl = document.getElementById('recent-title');
  const count = state.recordings.length;
  if (header) header.style.display = count > 0 ? 'flex' : 'none';
  if (titleEl) titleEl.textContent = count > 0 ? `Recent Recordings (${count})` : 'Recent Recordings';
}

function setBreakdownEmptyState(isVisible) {
  const emptyState = document.getElementById('breakdown-empty-state');
  if (emptyState) emptyState.style.display = isVisible ? '' : 'none';
}

// --- DOM ---
const welcomeScreen = document.getElementById('screen-welcome');
const appShell = document.getElementById('app-shell');
const panels = {
  home: document.getElementById('panel-home'),
  voiceLab: document.getElementById('panel-voice-lab'),
  compare: document.getElementById('panel-compare'),
  settings: document.getElementById('panel-settings'),
  changeUserType: document.getElementById('panel-change-user-type'),
  audioBreakdown: document.getElementById('panel-audio-breakdown'),
  history: document.getElementById('panel-history'),
  download: document.getElementById('panel-download'),
};

// --- Enter app (show shell, hide welcome) ---
function enterApp() {
  welcomeScreen.classList.remove('active');
  welcomeScreen.style.display = 'none';
  appShell.style.display = 'flex';
  showPanel('home');
}

function leaveApp() {
  appShell.style.display = 'none';
  welcomeScreen.style.display = 'block';
  welcomeScreen.classList.add('active');
  if (welcomeContent) welcomeContent.style.display = 'block';
  if (authContent) authContent.style.display = 'none';
}

// Map sidebar data-nav to panel keys
const navToPanelKey = {
  'home': 'home',
  'voice-lab': 'voiceLab',
  'compare': 'compare',
  'settings': 'settings',
  'change-user-type': 'changeUserType',
  'audio-breakdown': 'audioBreakdown',
  'history': 'history',
  'download': 'download',
};

// --- Panel navigation ---
function showPanel(name) {
  const key = navToPanelKey[name] || name;
  Object.values(panels).forEach((el) => el?.classList.remove('active'));
  const panel = panels[key];
  if (panel) panel.classList.add('active');

  document.querySelectorAll('.sidebar-nav .nav-item[data-nav]').forEach((btn) => {
    const isActive = btn.getAttribute('data-nav') === name;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-current', isActive ? 'page' : null);
  });
}

function navTo(path) {
  if (path === 'welcome') {
    leaveApp();
    return;
  }
  showPanel(path);
  if (path === 'history') loadHistoryFromServer();
}

function injectGlobalDisclaimers() {
  document.querySelectorAll('.page-content').forEach((content) => {
    if (!content || content.querySelector('.panel-disclaimer')) return;
    const firstSubtitle = content.querySelector('.page-subtitle');
    const note = document.createElement('div');
    note.className = 'panel-disclaimer';
    note.innerHTML = '<strong>Disclaimer:</strong> Voice Sentinel provides probabilistic AI analysis. Always verify critical decisions with independent evidence.';
    if (firstSubtitle && firstSubtitle.parentNode === content) {
      firstSubtitle.insertAdjacentElement('afterend', note);
    } else {
      content.insertBefore(note, content.firstChild);
    }
  });
}

injectGlobalDisclaimers();

// --- Sidebar nav ---
document.querySelectorAll('.sidebar-nav .nav-item[data-nav]').forEach((btn) => {
  btn.addEventListener('click', () => navTo(btn.getAttribute('data-nav')));
});
document.getElementById('sidebar-logout')?.addEventListener('click', () => {
  clearAuthToken();
  navTo('welcome');
});

document.getElementById('home-go-lab')?.addEventListener('click', () => navTo('voice-lab'));
document.getElementById('home-go-compare')?.addEventListener('click', () => navTo('compare'));
document.getElementById('home-go-breakdown')?.addEventListener('click', () => navTo('audio-breakdown'));
document.getElementById('home-go-history')?.addEventListener('click', () => navTo('history'));

// --- Restore session on load/refresh: load identity from localStorage, then confirm from API ---
if (getAuthToken()) {
  const storedId = getStoredUserId();
  if (storedId != null) state.userId = storedId;
  loadRecordings();
  renderRecordings();
  enterApp();
  updateUserSurface();
  (async () => {
    try {
      const uid = state.userId ?? getStoredUserId();
      if (uid == null) return;
      const res = await apiFetch(`user/me?user_id=${encodeURIComponent(uid)}`, { method: 'GET' });
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      if (res.ok && data && typeof data === 'object') {
        const id = data.id ?? data.user_id ?? data.userId;
        storeUserIdentity(id, data.email);
      }
    } catch (_) {}
  })();
}

// --- Welcome / Auth ---
const welcomeContent = document.getElementById('welcome-content');
const authContent = document.getElementById('auth-content');
const authTitle = document.getElementById('auth-title');
const authSub = document.getElementById('auth-sub');
const authSignupFields = document.getElementById('auth-signup-fields');
const authSubmitBtn = document.getElementById('btn-auth-submit');
const toggleAuthBtn = document.getElementById('btn-toggle-auth');

document.getElementById('btn-signin')?.addEventListener('click', () => {
  welcomeContent.style.display = 'none';
  authContent.style.display = 'block';
  setAuthMode(false);
  hideAuthError();
});
document.getElementById('btn-skip')?.addEventListener('click', enterApp);
document.getElementById('btn-skip-auth')?.addEventListener('click', enterApp);
document.getElementById('btn-auth-submit')?.addEventListener('click', handleAuthSubmit);

toggleAuthBtn?.addEventListener('click', () => {
  const isSignUp = authSignupFields.style.display !== 'none';
  setAuthMode(isSignUp);
  hideAuthError();
});

function hideAuthError() {
  const el = document.getElementById('auth-error');
  if (el) {
    el.style.display = 'none';
    el.textContent = '';
  }
}

function showAuthError(message) {
  const el = document.getElementById('auth-error');
  if (el) {
    el.textContent = message;
    el.style.display = 'block';
  }
}

async function handleAuthSubmit() {
  const isSignUp = authSignupFields.style.display !== 'none';
  if (isSignUp) {
    await handleRegister();
  } else {
    await handleLogin();
  }
}

async function handleRegister() {
  const emailEl = document.getElementById('auth-email');
  const passwordEl = document.getElementById('auth-password');
  const confirmEl = document.getElementById('auth-password-confirm');
  const nameEl = document.getElementById('auth-name');
  const levelEl = document.getElementById('user-type-select');
  const email = emailEl?.value?.trim();
  const password = passwordEl?.value ?? '';
  const confirm = confirmEl?.value ?? '';
  const name = nameEl?.value?.trim() ?? '';
  const level = levelEl?.value ?? 'BASIC';

  hideAuthError();

  if (!email) {
    showAuthError('Please enter your email.');
    return;
  }
  if (!password) {
    showAuthError('Please enter a password.');
    return;
  }
  if (password !== confirm) {
    showAuthError('Passwords do not match.');
    return;
  }

  const submitBtn = document.getElementById('btn-auth-submit');
  const originalText = submitBtn?.textContent;
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Signing up…';
  }

  try {
    // API: email, password, level only — name is never sent; stored locally after success.
    const body = new URLSearchParams({
      email,
      password,
      level,
    });
    const res = await fetch(`${API_BASE}/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }

    if (res.ok) {
      try {
        localStorage.setItem(EDIT_PROFILE_STORAGE_KEY, level);
        if (name) localStorage.setItem(USER_NAME_STORAGE_KEY, name);
      } catch (_) {}
      setAuthMode(true);
      const passwordConfirmEl = document.getElementById('auth-password-confirm');
      if (passwordConfirmEl) passwordConfirmEl.value = '';
      updateUserSurface();
      alert('Registration successful. Please sign in with your new account.');
      return;
    }

    if (res.status === 409) {
      showAuthError('An account with this email already exists. Sign in instead or use a different email.');
      return;
    }

    if (res.status === 422 && data && data.detail != null) {
      const details = Array.isArray(data.detail) ? data.detail : [data.detail];
      const messages = details.map((d) => (d && typeof d.msg === 'string' ? d.msg : 'Validation error')).filter(Boolean);
      let msg = messages.length ? messages.join(' ') : 'Validation error. Please check your input.';
      if (/user exists|already exists|already registered/i.test(msg)) {
        msg = 'An account with this email already exists. Sign in instead or use a different email.';
      }
      showAuthError(msg);
      return;
    }

    const connectionErr = formatApiConnectionError(res, text);
    let errMsg = connectionErr;
    if (!errMsg && typeof data === 'object' && (data?.detail || data?.message)) errMsg = typeof data.detail === 'string' ? data.detail : (data.message || '');
    if (!errMsg && typeof data === 'string' && data && !/ROUTER_EXTERNAL_TARGET_CONNECTION/i.test(data)) errMsg = data;
    showAuthError(errMsg || `Registration failed (${res.status}). Please try again.`);
  } catch (err) {
    showAuthError(formatNetworkError(err));
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = originalText || 'Sign Up';
    }
  }
}

async function handleLogin() {
  const emailEl = document.getElementById('auth-email');
  const passwordEl = document.getElementById('auth-password');
  const email = emailEl?.value?.trim();
  const password = passwordEl?.value ?? '';

  hideAuthError();

  if (!email) {
    showAuthError('Please enter your email.');
    return;
  }
  if (!password) {
    showAuthError('Please enter your password.');
    return;
  }

  const submitBtn = document.getElementById('btn-auth-submit');
  const originalText = submitBtn?.textContent;
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Signing in…';
  }

  try {
    const body = new URLSearchParams({ email, password });
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }

    if (res.ok) {
      if (data && typeof data === 'object') {
        // token field = user_id (used as auth token for all routes)
        const token = data.token ?? data.access_token;
        if (token) try { localStorage.setItem(AUTH_TOKEN_KEY, String(token)); } catch (_) {}
        storeUserIdentity(token, email);
      } else if (typeof data === 'string' && data) {
        try { localStorage.setItem(AUTH_TOKEN_KEY, data); } catch (_) {}
        storeUserIdentity(data, email);
      }
      enterApp();
      updateUserSurface();
      return;
    }

    if (res.status === 401) {
      showAuthError('Invalid email or password.');
      return;
    }

    if (res.status === 422) {
      const details = Array.isArray(data?.detail) ? data.detail : (data?.detail ? [data.detail] : []);
      const messages = details.map((d) => (d && d.msg) || 'Validation error').filter(Boolean);
      showAuthError(messages.length ? messages.join(' ') : 'Invalid email or password.');
      return;
    }

    const connectionErr = formatApiConnectionError(res, text);
    let errMsg = connectionErr;
    if (!errMsg && typeof data === 'object' && (data?.detail || data?.message)) errMsg = typeof data.detail === 'string' ? data.detail : (data.message || '');
    if (!errMsg && typeof data === 'string' && data && !/ROUTER_EXTERNAL_TARGET_CONNECTION/i.test(data)) errMsg = data;
    showAuthError(errMsg || `Login failed (${res.status}). Please try again.`);
  } catch (err) {
    showAuthError(formatNetworkError(err));
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = originalText || 'Sign In';
    }
  }
}

function setAuthMode(isSignUp) {
  authSignupFields.style.display = isSignUp ? 'none' : 'block';
  authTitle.textContent = isSignUp ? 'Welcome Back' : 'Create Account';
  authSub.textContent = isSignUp ? 'Sign in to access your account' : 'Sign up to save your voice analysis history';
  authSubmitBtn.textContent = isSignUp ? 'Sign In' : 'Sign Up';
  toggleAuthBtn.textContent = isSignUp ? 'Need an account? Sign up' : 'Already have an account? Sign in';
}

// --- Theme (dark mode) ---
function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.setAttribute('data-theme', theme === 'dark' ? 'dark' : '');
  const toggle = document.getElementById('toggle-dark');
  if (toggle) {
    toggle.classList.toggle('on', theme === 'dark');
    toggle.setAttribute('aria-pressed', theme === 'dark');
  }
  try { localStorage.setItem('voiceSentinelTheme', theme); } catch (_) {}
}

const savedTheme = (typeof localStorage !== 'undefined' && localStorage.getItem('voiceSentinelTheme')) || 'light';
applyTheme(savedTheme);

document.getElementById('toggle-dark')?.addEventListener('click', () => {
  const next = state.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
});

// --- Change user type ---
const changeUserSelect = document.getElementById('change-user-select');
try {
  const stored = localStorage.getItem('voiceSentinelUserType');
  if (stored && changeUserSelect) changeUserSelect.value = stored;
} catch (_) {}
document.getElementById('change-user-save')?.addEventListener('click', async () => {
  const level = changeUserSelect?.value ?? 'BASIC';
  const saveBtn = document.getElementById('change-user-save');
  const errorEl = document.getElementById('change-user-error');
  if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = ''; }
  if (saveBtn) saveBtn.disabled = true;
  const userId = state.userId ?? getStoredUserId();
  if (userId == null) {
    if (errorEl) { errorEl.textContent = 'Could not determine your account. Please log out and log in again.'; errorEl.style.display = 'block'; }
    if (saveBtn) saveBtn.disabled = false;
    return;
  }
  try {
    const res = await apiFetch('user/update', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ user_id: String(userId), level }).toString(),
    });
    const text = await res.text();
    if (res.ok) {
      try { localStorage.setItem('voiceSentinelUserType', level); } catch (_) {}
      updateUserSurface();
      navTo('home');
    } else {
      if (errorEl) {
        errorEl.textContent = parseApiError(res, text);
        errorEl.style.display = 'block';
      }
    }
  } catch (err) {
    if (errorEl) {
      errorEl.textContent = formatNetworkError(err);
      errorEl.style.display = 'block';
    }
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
});

// --- Edit profile modal (Settings) ---
/** Initial user type when the edit profile modal was opened; used to detect level change. */
let editProfileInitialLevel = null;
/** Initial name when the edit profile modal was opened; used to detect name change. */
let editProfileInitialName = '';

async function openEditProfileModal() {
  const overlay = document.getElementById('edit-profile-overlay');
  const userTypeSelect = document.getElementById('edit-profile-user-type');
  const nameInput = document.getElementById('edit-profile-name');
  const newPasswordInput = document.getElementById('edit-profile-new-password');
  const confirmPasswordInput = document.getElementById('edit-profile-confirm-password');
  const errorEl = document.getElementById('edit-profile-error');
  if (overlay) {
    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
  }
  const currentPasswordInput = document.getElementById('edit-profile-current-password');
  if (currentPasswordInput) currentPasswordInput.value = '';
  if (newPasswordInput) newPasswordInput.value = '';
  if (confirmPasswordInput) confirmPasswordInput.value = '';
  if (errorEl) {
    errorEl.style.display = 'none';
    errorEl.textContent = '';
  }
  try {
    const storedName = localStorage.getItem(USER_NAME_STORAGE_KEY);
    if (nameInput) {
      nameInput.value = storedName ?? '';
      editProfileInitialName = nameInput.value;
    }
  } catch (_) {}
  try {
    const stored = localStorage.getItem(EDIT_PROFILE_STORAGE_KEY);
    if (stored && userTypeSelect) userTypeSelect.value = stored;
  } catch (_) {}
  editProfileInitialLevel = userTypeSelect?.value ?? 'BASIC';
  if (!getAuthToken()) return;
  try {
    const uid = state.userId ?? getStoredUserId();
    if (uid == null) return;
    const res = await apiFetch(`user/me?user_id=${encodeURIComponent(uid)}`, { method: 'GET' });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (res.ok && data && typeof data === 'object') {
      const id = data.id ?? data.user_id ?? data.userId;
      storeUserIdentity(id, data.email);
      const level = data.preferred_explanation_level ?? data.level ?? data.user_type ?? data.userType;
      if (level && userTypeSelect) {
        const opt = Array.from(userTypeSelect.options).find((o) => o.value === level);
        if (opt) userTypeSelect.value = level;
        else try { localStorage.setItem(EDIT_PROFILE_STORAGE_KEY, level); } catch (_) {}
      }
    }
  } catch (_) {}
  editProfileInitialLevel = userTypeSelect?.value ?? 'BASIC';
  if (nameInput) editProfileInitialName = nameInput.value;
}

function closeEditProfileModal() {
  const overlay = document.getElementById('edit-profile-overlay');
  if (overlay) {
    overlay.classList.remove('open');
    overlay.setAttribute('aria-hidden', 'true');
  }
}

function showEditProfileError(message) {
  const el = document.getElementById('edit-profile-error');
  if (el) {
    el.textContent = message;
    el.style.display = 'block';
  }
}

/** Parse API error body: supports HTTPValidationError (detail[]), ValidationError, proxy/connection errors, and 5xx. */
function parseApiError(res, text) {
  const connectionErr = formatApiConnectionError(res, text);
  if (connectionErr) return connectionErr;
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (res.status === 422 && data && data.detail != null) {
    const details = Array.isArray(data.detail) ? data.detail : [data.detail];
    const messages = details.map((d) => (d && typeof d.msg === 'string' ? d.msg : 'Validation error')).filter(Boolean);
    if (messages.length) return messages.join(' ');
  }
  const serverMsg = typeof data === 'object' && data && (typeof data.detail === 'string' ? data.detail : data.message);
  if (serverMsg) return serverMsg;
  if (res.status >= 500) return `Server error (${res.status}). The server had a problem. Please try again in a moment.`;
  return `Request failed (${res.status}). Try again.`;
}

/**
 * Edit profile save: user can change name only, password only, user type only, or any combination.
 * Name is stored locally only (never sent to API). Password and user type use their respective APIs.
 */
async function handleEditProfileSave() {
  const currentPasswordInput = document.getElementById('edit-profile-current-password');
  const newPasswordInput = document.getElementById('edit-profile-new-password');
  const confirmPasswordInput = document.getElementById('edit-profile-confirm-password');
  const nameInput = document.getElementById('edit-profile-name');
  const userTypeSelect = document.getElementById('edit-profile-user-type');
  const currentPassword = currentPasswordInput?.value ?? '';
  const newPassword = newPasswordInput?.value ?? '';
  const confirmPassword = confirmPasswordInput?.value ?? '';
  const name = nameInput?.value?.trim() ?? '';
  const level = userTypeSelect?.value ?? 'BASIC';

  const wantPasswordChange = newPassword.length > 0;
  const wantLevelChange = editProfileInitialLevel != null && level !== editProfileInitialLevel;
  const wantNameChange = name !== editProfileInitialName;

  const saveBtn = document.getElementById('edit-profile-save');
  if (saveBtn) saveBtn.disabled = true;

  const errorEl = document.getElementById('edit-profile-error');
  if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = ''; }

  if (!wantPasswordChange && !wantLevelChange && !wantNameChange) {
    showEditProfileError('Change your name, password and/or user type to update.');
    if (saveBtn) saveBtn.disabled = false;
    return;
  }

  // Name: stored locally only; never sent to change-password or user/update APIs. When user updates name, we only update the stored version here.
  if (wantNameChange) {
    try { localStorage.setItem(USER_NAME_STORAGE_KEY, name); } catch (_) {}
    updateUserSurface();
  }

  // Password: require current password only when user is actually changing password.
  if (wantPasswordChange) {
    if (!currentPassword) {
      showEditProfileError('Please enter your current password to set a new one.');
      if (saveBtn) saveBtn.disabled = false;
      return;
    }
    if (newPassword !== confirmPassword) {
      showEditProfileError('New password and confirm password do not match.');
      if (saveBtn) saveBtn.disabled = false;
      return;
    }
  }

  try {
    // API: change password only when user chose to change it. user_id is passed automatically from the stored identity.
    if (wantPasswordChange) {
      const userId = state.userId ?? getStoredUserId();
      if (userId == null) {
        showEditProfileError('Could not determine your account. Please log out and log in again.');
        if (saveBtn) saveBtn.disabled = false;
        return;
      }
      const body = new URLSearchParams({ user_id: String(userId), old: currentPassword, new: newPassword });
      const res = await apiFetch('auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      const text = await res.text();
      if (!res.ok) {
        if (res.status === 403) {
          showEditProfileError('Current password is incorrect.');
        } else {
          showEditProfileError(parseApiError(res, text));
        }
        if (saveBtn) saveBtn.disabled = false;
        return;
      }
    }

    // API: update user type only when user chose to change it. user_id is passed automatically.
    if (wantLevelChange) {
      const userId = state.userId ?? getStoredUserId();
      if (userId == null) {
        showEditProfileError('Could not determine your account. Please log out and log in again.');
        if (saveBtn) saveBtn.disabled = false;
        return;
      }
      const res = await apiFetch('user/update', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ user_id: String(userId), level }).toString(),
      });

      if (res.ok) {
        try { localStorage.setItem(EDIT_PROFILE_STORAGE_KEY, level); } catch (_) {}
        if (changeUserSelect) changeUserSelect.value = level;
        updateUserSurface();
      } else {
        const text = await res.text();
        showEditProfileError(parseApiError(res, text));
        if (saveBtn) saveBtn.disabled = false;
        return;
      }
    }

    closeEditProfileModal();
  } catch (err) {
    showEditProfileError(formatNetworkError(err));
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

document.getElementById('settings-edit-profile')?.addEventListener('click', openEditProfileModal);
document.getElementById('edit-profile-cancel')?.addEventListener('click', closeEditProfileModal);
document.getElementById('edit-profile-save')?.addEventListener('click', handleEditProfileSave);
document.getElementById('edit-profile-overlay')?.addEventListener('click', (e) => {
  if (e.target.id === 'edit-profile-overlay') closeEditProfileModal();
});

// --- Settings: About Me ---
document.getElementById('settings-about-me')?.addEventListener('click', async () => {
  const panel = document.getElementById('about-me-panel');
  const loadingEl = document.getElementById('about-me-loading');
  const contentEl = document.getElementById('about-me-content');
  const errorEl = document.getElementById('about-me-error');

  if (panel && panel.style.display !== 'none') {
    panel.style.display = 'none';
    return;
  }

  if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = ''; }
  if (loadingEl) loadingEl.style.display = '';
  if (contentEl) contentEl.style.display = 'none';
  if (panel) panel.style.display = '';

  const userId = state.userId ?? getStoredUserId();
  if (userId == null) {
    if (loadingEl) loadingEl.style.display = 'none';
    if (panel) panel.style.display = 'none';
    if (errorEl) { errorEl.textContent = 'Could not determine your account. Please log out and log in again.'; errorEl.style.display = ''; }
    return;
  }

  try {
    const res = await apiFetch(`user/me?user_id=${encodeURIComponent(userId)}`);
    const text = await res.text();
    if (!res.ok) {
      if (loadingEl) loadingEl.style.display = 'none';
      if (errorEl) { errorEl.textContent = parseApiError(res, text); errorEl.style.display = ''; }
      if (panel) panel.style.display = 'none';
      return;
    }
    const data = JSON.parse(text);
    document.getElementById('about-me-uid').textContent = data.user_id ?? '—';
    document.getElementById('about-me-email').textContent = data.email ?? '—';
    document.getElementById('about-me-level').textContent = data.preferred_explanation_level ?? '—';
    const created = data.created_at;
    document.getElementById('about-me-created').textContent = created ? new Date(created).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : '—';

    if (loadingEl) loadingEl.style.display = 'none';
    if (contentEl) contentEl.style.display = '';
  } catch (err) {
    if (loadingEl) loadingEl.style.display = 'none';
    if (panel) panel.style.display = 'none';
    if (errorEl) { errorEl.textContent = formatNetworkError(err); errorEl.style.display = ''; }
  }
});

// --- Settings: Delete account ---
document.getElementById('settings-delete-account')?.addEventListener('click', async () => {
  if (!confirm('Permanently delete your account? This cannot be undone.')) return;
  const btn = document.getElementById('settings-delete-account');
  const errorEl = document.getElementById('settings-delete-error');
  if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = ''; }
  if (btn) btn.disabled = true;
  const userId = state.userId ?? getStoredUserId();
  if (userId == null) {
    if (errorEl) { errorEl.textContent = 'Could not determine your account. Please log out and log in again.'; errorEl.style.display = 'block'; }
    if (btn) btn.disabled = false;
    return;
  }
  try {
    const res = await apiFetch('user/terminate', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ user_id: String(userId) }).toString(),
    });
    const text = await res.text();
    if (res.ok) {
      clearAuthToken();
      try { localStorage.removeItem('voiceSentinelUserType'); localStorage.removeItem(EDIT_PROFILE_STORAGE_KEY); } catch (_) {}
      navTo('welcome');
      return;
    }
    if (errorEl) {
      errorEl.textContent = parseApiError(res, text);
      errorEl.style.display = 'block';
    }
  } catch (err) {
    if (errorEl) {
      errorEl.textContent = formatNetworkError(err);
      errorEl.style.display = 'block';
    }
  } finally {
    if (btn) btn.disabled = false;
  }
});

// --- Settings: System stats ---
document.getElementById('settings-view-stats')?.addEventListener('click', async () => {
  const btn = document.getElementById('settings-view-stats');
  const errorEl = document.getElementById('settings-stats-error');
  const outputEl = document.getElementById('settings-stats-output');
  if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = ''; }
  if (outputEl) { outputEl.style.display = 'none'; outputEl.textContent = ''; }
  if (btn) btn.disabled = true;
  try {
    const res = await apiFetch('system/stats');
    const text = await res.text();
    if (!res.ok) {
      if (errorEl) {
        errorEl.textContent = parseApiError(res, text);
        errorEl.style.display = 'block';
      }
      if (btn) btn.disabled = false;
      return;
    }
    let display = text;
    try {
      const data = text ? JSON.parse(text) : null;
      display = typeof data === 'object' && data !== null ? JSON.stringify(data, null, 2) : (typeof data === 'string' ? data : text);
    } catch (_) {}
    if (outputEl) {
      outputEl.textContent = display;
      outputEl.style.display = 'block';
    }
  } catch (err) {
    if (errorEl) {
      errorEl.textContent = formatNetworkError(err);
      errorEl.style.display = 'block';
    }
  } finally {
    if (btn) btn.disabled = false;
  }
});

// --- Settings: Export Data ---
document.getElementById('settings-export-data')?.addEventListener('click', () => {
  const panel = document.getElementById('export-panel');
  if (panel) panel.style.display = panel.style.display === 'none' ? '' : 'none';
});

async function handleExport(format) {
  const errorEl = document.getElementById('export-error');
  const loadingEl = document.getElementById('export-loading');
  const successEl = document.getElementById('export-success');
  const jsonBtn = document.getElementById('export-json-btn');
  const csvBtn = document.getElementById('export-csv-btn');

  if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = ''; }
  if (successEl) { successEl.style.display = 'none'; successEl.textContent = ''; }
  if (loadingEl) loadingEl.style.display = '';
  if (jsonBtn) jsonBtn.disabled = true;
  if (csvBtn) csvBtn.disabled = true;

  const userId = state.userId ?? getStoredUserId();
  if (userId == null) {
    if (loadingEl) loadingEl.style.display = 'none';
    if (errorEl) { errorEl.textContent = 'Could not determine your account. Please log out and log in again.'; errorEl.style.display = ''; }
    if (jsonBtn) jsonBtn.disabled = false;
    if (csvBtn) csvBtn.disabled = false;
    return;
  }

  const endpoint = format === 'csv' ? 'export/csv' : 'export/results';

  try {
    const res = await apiFetch(`${endpoint}?user_id=${encodeURIComponent(userId)}`);
    const text = await res.text();
    if (loadingEl) loadingEl.style.display = 'none';

    if (!res.ok) {
      if (errorEl) { errorEl.textContent = parseApiError(res, text); errorEl.style.display = ''; }
      return;
    }

    if (format === 'csv') {
      const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `voicesentinel_export_${userId}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      if (successEl) { successEl.textContent = 'CSV file downloaded successfully.'; successEl.style.display = ''; }
    } else {
      let data = text;
      try {
        const parsed = JSON.parse(text);
        data = JSON.stringify(parsed, null, 2);
      } catch (_) {}
      const blob = new Blob([data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `voicesentinel_export_${userId}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      if (successEl) { successEl.textContent = 'JSON file downloaded successfully.'; successEl.style.display = ''; }
    }
  } catch (err) {
    if (loadingEl) loadingEl.style.display = 'none';
    if (errorEl) { errorEl.textContent = formatNetworkError(err); errorEl.style.display = ''; }
  } finally {
    if (jsonBtn) jsonBtn.disabled = false;
    if (csvBtn) csvBtn.disabled = false;
  }
}

document.getElementById('export-json-btn')?.addEventListener('click', () => handleExport('json'));
document.getElementById('export-csv-btn')?.addEventListener('click', () => handleExport('csv'));

// --- Raw PCM capture: records uncompressed float32 samples directly from the mic ---
// This avoids any lossy encoding (webm/opus) so no acoustic features are lost.
// Captures raw PCM samples straight from the mic MediaStreamSource.
// No codec, no resampling, no processing — the exact digital samples
// the microphone ADC produces are stored and wrapped in a WAV container.
function createPcmCapture(audioContext, sourceNode) {
  const bufferSize = 4096;
  const processor = audioContext.createScriptProcessor(bufferSize, 1, 1);
  const pcmChunks = [];
  let capturing = true;
  let paused = false;

  processor.onaudioprocess = (e) => {
    if (!capturing || paused) return;
    const raw = e.inputBuffer.getChannelData(0);
    pcmChunks.push(new Float32Array(raw));
    // Zero the output so the mic never plays back through the speakers
    const out = e.outputBuffer.getChannelData(0);
    for (let i = 0; i < out.length; i++) out[i] = 0;
  };

  sourceNode.connect(processor);
  // Must connect to destination for onaudioprocess to fire in all browsers;
  // output is silenced above so there is no feedback.
  processor.connect(audioContext.destination);

  return {
    pause() { paused = true; },
    resume() { paused = false; },
    stop() {
      capturing = false;
      try { processor.disconnect(); } catch (_) {}
    },
    toWavBlob() {
      let totalLength = 0;
      for (const chunk of pcmChunks) totalLength += chunk.length;

      const sampleRate = audioContext.sampleRate;
      const numChannels = 1;
      const bytesPerSample = 2; // 16-bit PCM
      const dataSize = totalLength * bytesPerSample;
      const buffer = new ArrayBuffer(44 + dataSize);
      const view = new DataView(buffer);

      function w(off, s) { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); }
      w(0, 'RIFF');
      view.setUint32(4, 36 + dataSize, true);
      w(8, 'WAVE');
      w(12, 'fmt ');
      view.setUint32(16, 16, true);          // chunk size
      view.setUint16(20, 1, true);            // PCM format
      view.setUint16(22, numChannels, true);
      view.setUint32(24, sampleRate, true);   // native hw rate, no resampling
      view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
      view.setUint16(32, numChannels * bytesPerSample, true);
      view.setUint16(34, 16, true);           // bits per sample
      w(36, 'data');
      view.setUint32(40, dataSize, true);

      let offset = 44;
      for (const chunk of pcmChunks) {
        for (let i = 0; i < chunk.length; i++) {
          const s = Math.max(-1, Math.min(1, chunk[i]));
          view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
          offset += 2;
        }
      }

      return new Blob([buffer], { type: 'audio/wav' });
    },
  };
}

// --- Home: Record status & timer ---
function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatTimerHHMMSS(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function updateRecordUI() {
  const statusRow = document.getElementById('recording-status-row');
  const pill = document.getElementById('recording-pill');
  const pillText = document.getElementById('recording-pill-text');
  const timerEl = document.getElementById('recording-timer');
  const btnPause = document.getElementById('btn-pause');
  const btnStop = document.getElementById('btn-stop');
  const btnRecord = document.getElementById('btn-record');
  const recordStatus = document.getElementById('record-status');
  const recordSub = document.getElementById('record-sub');

  if (state.isRecording || state.isPaused) {
    if (recordStatus) recordStatus.textContent = state.isPaused ? 'Paused' : 'Recording...';
    if (recordSub) recordSub.textContent = formatDuration(state.recordingSeconds);
    if (statusRow) statusRow.style.display = 'block';
    if (timerEl) timerEl.textContent = formatTimerHHMMSS(state.recordingSeconds);
    if (pill) {
      pill.classList.toggle('paused', state.isPaused);
    }
    if (pillText) pillText.textContent = state.isPaused ? 'Paused' : 'Recording';
    if (btnPause) {
      btnPause.disabled = false;
      btnPause.title = state.isPaused ? 'Resume' : 'Pause';
      btnPause.setAttribute('aria-label', state.isPaused ? 'Resume recording' : 'Pause recording');
      const iconPause = btnPause.querySelector('.icon-pause');
      const iconPlay = btnPause.querySelector('.icon-play');
      if (iconPause) iconPause.style.display = state.isPaused ? 'none' : 'block';
      if (iconPlay) iconPlay.style.display = state.isPaused ? 'block' : 'none';
    }
    if (btnStop) btnStop.disabled = false;
    if (btnRecord) {
      btnRecord.classList.add('active');
      btnRecord.title = state.isPaused ? 'Resume' : 'Recording…';
    }
  } else {
    if (recordStatus) recordStatus.textContent = 'Ready to Scan';
    if (recordSub) recordSub.textContent = 'Record or upload an audio file to begin.';
    if (statusRow) statusRow.style.display = 'none';
    if (btnPause) {
      btnPause.disabled = true;
      const iconPause = btnPause.querySelector('.icon-pause');
      const iconPlay = btnPause.querySelector('.icon-play');
      if (iconPause) iconPause.style.display = 'block';
      if (iconPlay) iconPlay.style.display = 'none';
    }
    if (btnStop) btnStop.disabled = true;
    if (btnRecord) {
      btnRecord.classList.remove('active');
      btnRecord.title = 'Record';
    }
  }
}

// --- Audio waveform visualization (Web Audio API) ---
// Bar-style waveform: setupWaveform → startWaveformAnimation → drawWaveform (bars) → clearWaveform

const waveform = {
  audioContext: null,
  analyser: null,
  dataArray: null,
  canvas: null,
  canvasCtx: null,
  barCount: 48,
  minBarHeight: 4,

  // Initializes the audioContext, analyser, and canvas for drawing
  setupWaveform(stream) {
    const canvas = document.getElementById('waveform-canvas');
    if (!canvas) return false;
    this.canvas = canvas;
    this.canvasCtx = canvas.getContext('2d');
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.audioContext = ctx;
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.7;
    analyser.minDecibels = -70;
    analyser.maxDecibels = -25;
    source.connect(analyser);
    this.analyser = analyser;
    this.sourceNode = source;
    this.dataArray = new Uint8Array(analyser.frequencyBinCount);
    return true;
  },

  resizeCanvas() {
    if (!this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width && rect.height && (this.canvas.width !== rect.width || this.canvas.height !== rect.height)) {
      this.canvas.width = rect.width;
      this.canvas.height = rect.height;
    }
  },

  // Draws the bar waveform from analyser frequency data
  drawWaveform() {
    if (!state.isRecording || state.isPaused || !this.analyser || !this.canvasCtx || !this.dataArray) return;
    state.waveformAnimationId = requestAnimationFrame(() => this.drawWaveform());

    this.resizeCanvas();
    const width = this.canvas.width;
    const height = this.canvas.height;
    if (!width || !height) return;

    this.analyser.getByteFrequencyData(this.dataArray);

    const bg = getComputedStyle(document.documentElement).getPropertyValue('--background').trim() || '#F8F9FA';
    this.canvasCtx.fillStyle = bg;
    this.canvasCtx.fillRect(0, 0, width, height);

    const barColor = getComputedStyle(document.documentElement).getPropertyValue('--primary-blue').trim() || '#285BAE';
    this.canvasCtx.fillStyle = barColor;

    const barWidth = (width / this.barCount) - 2;
    const gap = 2;
    const step = Math.floor(this.dataArray.length / this.barCount);

    for (let i = 0; i < this.barCount; i++) {
      const value = this.dataArray[i * step] || 0;
      const normalized = value / 255;
      const barHeight = Math.max(this.minBarHeight, normalized * (height - this.minBarHeight * 2));
      const x = i * (barWidth + gap);
      const y = height - barHeight;
      this.canvasCtx.fillRect(x, y, barWidth, barHeight);
    }
  },

  // Starts the animation loop
  startWaveformAnimation() {
    this.resizeCanvas();
    this.drawWaveform();
  },

  // Clears it when recording stops
  clearWaveform() {
    if (!this.canvas || !this.canvasCtx) return;
    const width = this.canvas.width;
    const height = this.canvas.height;
    if (width && height) {
      const bg = getComputedStyle(document.documentElement).getPropertyValue('--background').trim() || '#F8F9FA';
      this.canvasCtx.fillStyle = bg;
      this.canvasCtx.fillRect(0, 0, width, height);
    }
  },
};

function startWaveformFromMic() {
  const container = document.querySelector('.waveform-container');
  const canvas = document.getElementById('waveform-canvas');
  if (!container || !canvas) return;

  navigator.mediaDevices.getUserMedia({ audio: true })
    .then((stream) => {
      state.mediaStream = stream;
      if (!waveform.setupWaveform(stream)) {
        startMockWaveformBars();
        return;
      }
      state.analyser = waveform.analyser;
      container.classList.remove('show-bars');
      container.classList.add('show-canvas');
      waveform.startWaveformAnimation();
      // Raw PCM capture — records uncompressed samples directly from the mic
      // so no lossy codec (webm/opus) strips acoustic features.
      try {
        state.pcmCapture = createPcmCapture(waveform.audioContext, waveform.sourceNode);
        state.mediaRecorder = { _pcm: true };
      } catch (_) {
        state.mediaRecorder = null;
      }
    })
    .catch(() => {
      startMockWaveformBars();
    });
}

function startMockWaveformBars() {
  const container = document.querySelector('.waveform-container');
  const barsEl = document.getElementById('waveform-bars');
  if (!container || !barsEl) return;
  container.classList.remove('show-canvas');
  container.classList.add('show-bars');
  barsEl.innerHTML = '';
  state.amplitudeHistory = [];
  for (let i = 0; i < state.maxBars; i++) {
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.style.height = '4px';
    barsEl.appendChild(bar);
  }
  state.waveformIntervalId = setInterval(() => {
    const v = 0.25 + Math.random() * 0.6;
    state.amplitudeHistory.push(v);
    if (state.amplitudeHistory.length > state.maxBars) state.amplitudeHistory.shift();
    const start = state.amplitudeHistory.length > state.maxBars ? state.amplitudeHistory.length - state.maxBars : 0;
    const bars = barsEl.querySelectorAll('.bar');
    const height = 56;
    const minH = 4;
    bars.forEach((bar, i) => {
      const idx = start + i;
      const val = idx < state.amplitudeHistory.length ? state.amplitudeHistory[idx] : 0;
      const h = minH + val * (height - minH * 2);
      bar.style.height = `${Math.max(minH, h)}px`;
    });
  }, 80);
}

function stopWaveform() {
  const container = document.querySelector('.waveform-container');
  if (container) {
    container.classList.remove('show-canvas', 'show-bars');
  }
  if (state.waveformAnimationId) {
    cancelAnimationFrame(state.waveformAnimationId);
    state.waveformAnimationId = null;
  }
  if (state.waveformIntervalId) {
    clearInterval(state.waveformIntervalId);
    state.waveformIntervalId = null;
  }
  waveform.clearWaveform();
  if (state.mediaStream) {
    state.mediaStream.getTracks().forEach((t) => t.stop());
    state.mediaStream = null;
  }
  if (waveform.audioContext) {
    waveform.audioContext.close().catch(() => {});
    waveform.audioContext = null;
  }
  waveform.analyser = null;
  waveform.dataArray = null;
  state.audioContext = null;
  state.analyser = null;
}

// --- Home: Record / Pause / Stop (mock recording + real waveform) ---
function startMockRecording() {
  state.isRecording = true;
  state.isPaused = false;
  if (!state.timerId) state.recordingSeconds = 0;
  updateRecordUI();
  if (!state.mediaStream) startWaveformFromMic();
  else if (waveform.analyser) waveform.startWaveformAnimation();
  if (!state.timerId) {
    state.timerId = setInterval(() => {
      state.recordingSeconds++;
      updateRecordUI();
    }, 1000);
  }
}

function pauseRecording() {
  if (!state.isRecording || state.isPaused) return;
  state.isPaused = true;
  if (state.timerId) {
    clearInterval(state.timerId);
    state.timerId = null;
  }
  if (state.pcmCapture) state.pcmCapture.pause();
  if (state.waveformAnimationId) {
    cancelAnimationFrame(state.waveformAnimationId);
    state.waveformAnimationId = null;
  }
  updateRecordUI();
}

function resumeRecording() {
  if (!state.isRecording || !state.isPaused) return;
  state.isPaused = false;
  if (state.pcmCapture) state.pcmCapture.resume();
  state.timerId = setInterval(() => {
    state.recordingSeconds++;
    updateRecordUI();
  }, 1000);
  if (waveform.analyser) waveform.startWaveformAnimation();
  updateRecordUI();
}

// Pending recording duration when review modal is open
let pendingReviewDuration = 0;
/** When set, review modal was opened from an upload; use this as the recording name on submit. */
let pendingReviewFileName = null;

function stopRecordingAndOpenReview() {
  state.isRecording = false;
  state.isPaused = false;
  if (state.timerId) clearInterval(state.timerId);
  state.timerId = null;

  if (state.pcmCapture) {
    state.pcmCapture.stop();
    const wavBlob = state.pcmCapture.toWavBlob();
    state.pcmCapture = null;
    state.mediaRecorder = null;
    stopWaveform();
    pendingReviewDuration = state.recordingSeconds;
    pendingReviewFileName = null;
    state.reviewInputType = state.currentLiveInputType || 'live_user';
    state.currentLiveInputType = null;
    updateRecordUI();
    state.recordedBlob = wavBlob;
    openReviewModal(wavBlob);
  } else {
    stopWaveform();
    pendingReviewDuration = state.recordingSeconds;
    pendingReviewFileName = null;
    state.reviewInputType = state.currentLiveInputType || 'live_user';
    state.currentLiveInputType = null;
    updateRecordUI();
    openReviewModal(null);
  }
}

function formatTimeForPlayer(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(1, '0')}:${String(s).padStart(2, '0')}`;
}

function openReviewModal(blob) {
  const overlay = document.getElementById('review-modal-overlay');
  const timeEl = document.getElementById('review-time');
  const progressBar = document.getElementById('review-progress-bar');
  const transcriptionEl = document.getElementById('review-transcription');
  const playBtn = document.getElementById('review-play-btn');
  const audio = document.getElementById('review-audio');

  if (state.reviewAudioUrl) {
    URL.revokeObjectURL(state.reviewAudioUrl);
    state.reviewAudioUrl = null;
  }
  if (audio) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  }

  if (overlay) {
    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
  }
  if (timeEl) {
    const totalStr = formatTimeForPlayer(pendingReviewDuration);
    timeEl.textContent = `0:00 / ${totalStr}`;
  }
  if (progressBar) progressBar.style.width = '0%';
  if (transcriptionEl) {
    transcriptionEl.textContent = 'Transcription will appear here after analysis.';
  }
  const reviewErrorEl = document.getElementById('review-error');
  if (reviewErrorEl) { reviewErrorEl.style.display = 'none'; reviewErrorEl.textContent = ''; }

  state.reviewBlob = blob || null;
  if (blob && audio) {
    state.reviewAudioUrl = URL.createObjectURL(blob);
    audio.src = state.reviewAudioUrl;
    if (playBtn) {
      playBtn.disabled = false;
      playBtn.setAttribute('aria-label', 'Play');
    }
    audio.onloadedmetadata = () => {
      pendingReviewDuration = audio.duration;
      if (timeEl) {
        const total = formatTimeForPlayer(audio.duration);
        timeEl.textContent = `0:00 / ${total}`;
      }
    };
    audio.ontimeupdate = () => {
      if (!timeEl || !progressBar) return;
      const current = audio.currentTime;
      const duration = audio.duration || pendingReviewDuration;
      const total = formatTimeForPlayer(duration);
      timeEl.textContent = `${formatTimeForPlayer(current)} / ${total}`;
      progressBar.style.width = duration ? `${(current / duration) * 100}%` : '0%';
    };
    audio.onended = () => {
      if (timeEl) timeEl.textContent = `0:00 / ${formatTimeForPlayer(audio.duration)}`;
      if (progressBar) progressBar.style.width = '0%';
      if (playBtn) {
        playBtn.querySelector('.review-icon-pause').style.display = 'none';
        playBtn.querySelector('.review-icon-play').style.display = 'block';
        playBtn.setAttribute('aria-label', 'Play');
      }
    };
  } else {
    if (playBtn) playBtn.disabled = true;
  }
}

function closeReviewModal() {
  const overlay = document.getElementById('review-modal-overlay');
  const audio = document.getElementById('review-audio');
  const playBtn = document.getElementById('review-play-btn');
  if (audio) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  }
  if (state.reviewAudioUrl) {
    URL.revokeObjectURL(state.reviewAudioUrl);
    state.reviewAudioUrl = null;
  }
  state.reviewBlob = null;
  state.reviewInputType = null;
  if (playBtn) {
    playBtn.disabled = true;
    const iconPlay = playBtn.querySelector('.review-icon-play');
    const iconPause = playBtn.querySelector('.review-icon-pause');
    if (iconPlay) iconPlay.style.display = 'block';
    if (iconPause) iconPause.style.display = 'none';
  }
  if (overlay) {
    overlay.classList.remove('open');
    overlay.setAttribute('aria-hidden', 'true');
  }
}

function toggleReviewPlayback() {
  const audio = document.getElementById('review-audio');
  const playBtn = document.getElementById('review-play-btn');
  if (!audio || !audio.src || !playBtn) return;
  const iconPlay = playBtn.querySelector('.review-icon-play');
  const iconPause = playBtn.querySelector('.review-icon-pause');
  if (audio.paused) {
    audio.play();
    if (iconPlay) iconPlay.style.display = 'none';
    if (iconPause) iconPause.style.display = 'block';
    playBtn.setAttribute('aria-label', 'Pause');
  } else {
    audio.pause();
    if (iconPlay) iconPlay.style.display = 'block';
    if (iconPause) iconPause.style.display = 'none';
    playBtn.setAttribute('aria-label', 'Play');
  }
}

function simpleMarkdownToHtml(md) {
  if (!md || typeof md !== 'string') return '';
  let s = md;
  s = s.replace(/\r\n/g, '\n');
  s = s.replace(/(#{2,3}\s)/g, '\n$1');
  s = s.replace(/\*\*(\d+)\)\s/g, '\n**$1) ');
  s = s.replace(/\n{3,}/g, '\n\n');

  s = s.replace(/^##\s+(.+)$/gm, '<h2 class="md-h2">$1</h2>');
  s = s.replace(/^###\s+(.+)$/gm, '<h3 class="md-h3">$1</h3>');

  s = s.replace(/\*\*(\d+\)\s[^*]+)\*\*/g, '<h3 class="md-h3">$1</h3>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  s = s.replace(/(?:^|\n)\s*\*\s+/g, '\n<li>');
  s = s.replace(/(?:^|\n)\s*(\d+)\.\s+<strong>/g, '\n<li class="md-ol"><strong>');
  s = s.replace(/(?:^|\n)\s*(\d+)\.\s+/g, '\n<li class="md-ol">');

  const lines = s.split('\n');
  let html = '';
  let inList = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('<li')) {
      if (!inList) { html += '<ul class="md-list">'; inList = true; }
      html += trimmed.endsWith('</li>') ? trimmed : trimmed + '</li>';
    } else {
      if (inList) { html += '</ul>'; inList = false; }
      if (trimmed.startsWith('<h2') || trimmed.startsWith('<h3')) {
        html += trimmed;
      } else {
        html += '<p class="md-p">' + trimmed + '</p>';
      }
    }
  }
  if (inList) html += '</ul>';
  return html;
}

function renderAnalysisContent(container, data) {
  if (!container) return;
  if (typeof data === 'string') {
    const rendered = simpleMarkdownToHtml(data);
    container.innerHTML = `<div class="analysis-prose">${rendered || escapeHtml(data)}</div>`;
    return;
  }
  if (!data || typeof data !== 'object') {
    container.innerHTML = '<p style="color:var(--grey-600);">No analysis data available.</p>';
    return;
  }

  const metaKeys = new Set(['sample_id', 'filename', 'verdict', 'confidence', 'analyzed_at', 'analysis_url', 'user_id']);
  const meta = {};
  const modelVotes = {};
  const featureGroups = {};
  const scalarFeatures = {};
  let proseAnalysis = null;

  const GROUP_LABELS = {
    mel: 'Mel Spectrogram', mfcc: 'MFCC Features', ssl: 'SSL Features',
    chroma: 'Chroma Features', spectral: 'Spectral Features', zcr: 'Zero Crossing Rate',
    rms: 'RMS Energy', pitch: 'Pitch Features', delta: 'Delta Features',
    tonnetz: 'Tonnetz Features', contrast: 'Spectral Contrast', bandwidth: 'Bandwidth',
    rolloff: 'Spectral Rolloff', flatness: 'Spectral Flatness', centroid: 'Spectral Centroid',
  };

  function classifyKey(k, v) {
    if (metaKeys.has(k)) { meta[k] = v; return; }
    if ((k === 'analysis' || k === 'report' || k === 'summary') && typeof v === 'string' && v.length > 100) {
      proseAnalysis = v;
      return;
    }
    if (k === 'model_votes' && typeof v === 'object' && v !== null) {
      Object.assign(modelVotes, v);
      return;
    }
    const prefixMatch = k.match(/^([a-zA-Z]+)_(\d+)$/);
    if (prefixMatch && typeof v === 'number') {
      const prefix = prefixMatch[1].toLowerCase();
      if (!featureGroups[prefix]) featureGroups[prefix] = {};
      featureGroups[prefix][k] = v;
      return;
    }
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      const sub = Object.entries(v);
      if (sub.length) {
        const numericSubs = sub.filter(([sk]) => /^[a-zA-Z]+_\d+$/.test(sk));
        if (numericSubs.length > sub.length * 0.5) {
          for (const [sk, sv] of sub) {
            classifyKey(sk, sv);
          }
          return;
        }
      }
    }
    if (k === 'acoustic_features' && typeof v === 'object' && v !== null) {
      for (const [sk, sv] of Object.entries(v)) classifyKey(sk, sv);
      return;
    }
    if (typeof v === 'number') {
      scalarFeatures[k] = v;
    } else {
      scalarFeatures[k] = v;
    }
  }

  for (const [k, v] of Object.entries(data)) classifyKey(k, v);

  function fmtVal(v) {
    if (v == null) return '—';
    if (typeof v === 'number') {
      if (Number.isInteger(v)) return String(v);
      return v.toExponential ? (Math.abs(v) < 0.0001 || Math.abs(v) >= 1e8 ? v.toExponential(4) : v.toFixed(6)) : String(v);
    }
    return String(v);
  }

  function buildMetaRows(obj) {
    return Object.entries(obj).map(([k, v]) => {
      const label = k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      let val = v;
      if (k === 'confidence' && typeof v === 'number') val = (v * 100).toFixed(2) + '%';
      else if (typeof v === 'object' && v !== null) val = JSON.stringify(v);
      const verdictClass = k === 'verdict' ? (v === 'Real' ? ' prediction-verdict--real' : v === 'Synthetic' ? ' prediction-verdict--synthetic' : '') : '';
      return `<div class="analysis-meta-row"><span class="analysis-meta-label">${escapeHtml(label)}</span><span class="analysis-meta-value${verdictClass}">${escapeHtml(String(val ?? '—'))}</span></div>`;
    }).join('');
  }

  function buildFeatureGrid(obj) {
    const entries = Object.entries(obj);
    const allNumeric = entries.every(([k]) => /\d+$/.test(k));
    const sorted = entries.sort((a, b) => {
      if (allNumeric) {
        const na = parseInt(a[0].replace(/\D+/g, ''), 10) || 0;
        const nb = parseInt(b[0].replace(/\D+/g, ''), 10) || 0;
        return na - nb;
      }
      return a[0].localeCompare(b[0]);
    });
    return sorted.map(([k, v]) => {
      const displayKey = allNumeric ? k.replace(/\D+/g, '') : k.replace(/_/g, ' ');
      return `<div class="feat-cell"><span class="feat-idx">${escapeHtml(displayKey)}</span><span class="feat-val" title="${escapeHtml(fmtVal(v))}">${escapeHtml(fmtVal(v))}</span></div>`;
    }).join('');
  }

  function buildModelVotesBar(votes) {
    const entries = Object.entries(votes).sort((a, b) => Number(b[1]) - Number(a[1]));
    const max = Math.max(...entries.map(([, v]) => Math.abs(Number(v))), 0.001);
    const topScore = Math.max(...entries.map(([, s]) => Number(s)));
    return entries.map(([model, score]) => {
      const num = Number(score);
      const pct = Math.min(Math.abs(num) / max * 100, 100).toFixed(1);
      const isTop = num === topScore;
      const display = typeof score === 'number'
        ? (Math.abs(score) < 0.0001 && score !== 0 ? score.toExponential(2) : score.toFixed(4))
        : String(score);
      return `<div class="vote-row"><span class="vote-model">${escapeHtml(model.toUpperCase())}</span><div class="vote-bar-track"><div class="vote-bar-fill${isTop ? ' vote-bar--top' : ''}" style="width:${pct}%"></div></div><span class="vote-score">${escapeHtml(display)}</span></div>`;
    }).join('');
  }

  let html = '';
  let sectionIdx = 0;

  if (Object.keys(meta).length) {
    html += `<div class="analysis-section analysis-meta-section"><div class="analysis-meta-rows">${buildMetaRows(meta)}</div></div>`;
  }

  if (Object.keys(modelVotes).length) {
    const sid = `as-${sectionIdx++}`;
    html += `<div class="analysis-section"><div class="analysis-section-header" data-toggle="${sid}"><span class="analysis-section-title">Model Votes</span><span class="analysis-section-badge">${Object.keys(modelVotes).length} models</span><span class="analysis-chevron">&#9662;</span></div><div class="analysis-section-body" id="section-${sid}">${buildModelVotesBar(modelVotes)}</div></div>`;
  }

  const groupOrder = Object.keys(featureGroups).sort((a, b) => {
    const oa = Object.keys(featureGroups[a]).length;
    const ob = Object.keys(featureGroups[b]).length;
    return oa - ob;
  });

  for (const prefix of groupOrder) {
    const obj = featureGroups[prefix];
    const count = Object.keys(obj).length;
    if (!count) continue;
    const sid = `as-${sectionIdx++}`;
    const label = GROUP_LABELS[prefix] || (prefix.charAt(0).toUpperCase() + prefix.slice(1) + ' Features');
    const startCollapsed = count > 20;
    const chevron = startCollapsed ? '&#9656;' : '&#9662;';
    const collapsedClass = startCollapsed ? ' analysis-section-collapsed' : '';
    html += `<div class="analysis-section"><div class="analysis-section-header" data-toggle="${sid}"><span class="analysis-section-title">${escapeHtml(label)}</span><span class="analysis-section-badge">${count} features</span><span class="analysis-chevron">${chevron}</span></div><div class="analysis-section-body${collapsedClass}" id="section-${sid}"><div class="feat-grid">${buildFeatureGrid(obj)}</div></div></div>`;
  }

  if (proseAnalysis) {
    const sid = `as-${sectionIdx++}`;
    const rendered = simpleMarkdownToHtml(proseAnalysis);
    html += `<div class="analysis-section"><div class="analysis-section-header" data-toggle="${sid}"><span class="analysis-section-title">Forensic Analysis Report</span><span class="analysis-chevron">&#9662;</span></div><div class="analysis-section-body" id="section-${sid}"><div class="analysis-prose">${rendered}</div></div></div>`;
  }

  if (Object.keys(scalarFeatures).length) {
    const sid = `as-${sectionIdx++}`;
    const rows = Object.entries(scalarFeatures).map(([k, v]) => {
      const label = k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      let val;
      if (typeof v === 'object' && v !== null) val = JSON.stringify(v);
      else val = fmtVal(v);
      return `<div class="analysis-meta-row"><span class="analysis-meta-label">${escapeHtml(label)}</span><span class="analysis-meta-value">${escapeHtml(String(val ?? '—'))}</span></div>`;
    }).join('');
    html += `<div class="analysis-section"><div class="analysis-section-header" data-toggle="${sid}"><span class="analysis-section-title">Additional Details</span><span class="analysis-section-badge">${Object.keys(scalarFeatures).length}</span><span class="analysis-chevron">&#9662;</span></div><div class="analysis-section-body" id="section-${sid}"><div class="analysis-meta-rows">${rows}</div></div></div>`;
  }

  if (!html) {
    container.innerHTML = '<p style="color:var(--grey-600);">No analysis data available.</p>';
    return;
  }

  container.innerHTML = html;

  container.querySelectorAll('.analysis-section-header[data-toggle]').forEach((hdr) => {
    hdr.addEventListener('click', () => {
      const id = hdr.getAttribute('data-toggle');
      const body = container.querySelector(`#section-${id}`);
      if (!body) return;
      body.classList.toggle('analysis-section-collapsed');
      const chev = hdr.querySelector('.analysis-chevron');
      if (chev) chev.textContent = body.classList.contains('analysis-section-collapsed') ? '\u25B8' : '\u25BE';
    });
  });
}

async function fetchAnalysis(sampleId, opts) {
  const { loadingEl, errorEl, contentEl, cardEl } = opts;
  if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = ''; }
  if (contentEl) contentEl.innerHTML = '';
  if (loadingEl) loadingEl.style.display = '';
  if (cardEl) cardEl.style.display = '';

  try {
    const res = await apiFetch(`/api/forensics/analysis/${encodeURIComponent(sampleId)}`);
    const text = await res.text();
    if (loadingEl) loadingEl.style.display = 'none';
    if (!res.ok) {
      if (errorEl) { errorEl.textContent = parseApiError(res, text); errorEl.style.display = ''; }
      return null;
    }
    let data = null;
    try { data = text ? JSON.parse(text) : text; } catch { data = text; }
    renderAnalysisContent(contentEl, data);
    return data;
  } catch (err) {
    if (loadingEl) loadingEl.style.display = 'none';
    if (errorEl) { errorEl.textContent = formatNetworkError(err); errorEl.style.display = ''; }
    return null;
  }
}

async function fetchSampleAnalysis(sampleId, userId, opts) {
  const { loadingEl, errorEl, contentEl, cardEl } = opts;
  if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = ''; }
  if (contentEl) contentEl.innerHTML = '';
  if (loadingEl) loadingEl.style.display = '';
  if (cardEl) cardEl.style.display = '';

  try {
    const res = await apiFetch(`/api/forensics/sample/${encodeURIComponent(sampleId)}?user_id=${encodeURIComponent(userId)}`);
    const text = await res.text();
    if (loadingEl) loadingEl.style.display = 'none';
    if (!res.ok) {
      if (errorEl) { errorEl.textContent = parseApiError(res, text); errorEl.style.display = ''; }
      return null;
    }
    let data = null;
    try { data = text ? JSON.parse(text) : text; } catch { data = text; }
    renderAnalysisContent(contentEl, data);
    return data;
  } catch (err) {
    if (loadingEl) loadingEl.style.display = 'none';
    if (errorEl) { errorEl.textContent = formatNetworkError(err); errorEl.style.display = ''; }
    return null;
  }
}

function populateSamplePicker(historyData) {
  const select = document.getElementById('sample-picker-select');
  if (!select) return;
  select.innerHTML = '<option value="" disabled selected>Select a sample…</option>';
  let items = [];
  if (Array.isArray(historyData)) {
    items = historyData.filter((h) => h && h.sample_id != null);
  }
  const localSamples = getSavedSamples();
  localSamples.forEach((s) => {
    if (s.sample_id != null && !items.some((h) => String(h.sample_id) === String(s.sample_id))) {
      items.push(s);
    }
  });
  if (items.length === 0) {
    select.innerHTML += '<option value="" disabled>No samples found</option>';
    return;
  }
  items.forEach((item) => {
    const opt = document.createElement('option');
    opt.value = item.sample_id;
    const verdict = item.verdict ?? '';
    const date = item.created_at ?? item.date;
    const dateStr = date ? new Date(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
    opt.textContent = `#${item.sample_id}` + (verdict ? ` — ${verdict}` : '') + (dateStr ? ` (${dateStr})` : '');
    select.appendChild(opt);
  });
}

function showPredictionResult(data, options = {}) {
  const { promptFeedback = true } = options;
  const card = document.getElementById('prediction-result');
  if (!card) return;

  const v = data.verdict ?? '—';
  const isReal = v === 'Real';
  const isSynthetic = v === 'Synthetic';

  const iconEl = document.getElementById('verdict-icon');
  if (iconEl) {
    iconEl.className = 'verdict-icon';
    if (isReal) { iconEl.classList.add('verdict-icon--real'); iconEl.textContent = '✓'; }
    else if (isSynthetic) { iconEl.classList.add('verdict-icon--synthetic'); iconEl.textContent = '✗'; }
    else { iconEl.classList.add('verdict-icon--unknown'); iconEl.textContent = '?'; }
  }

  const verdictEl = document.getElementById('pred-verdict');
  verdictEl.textContent = v;
  verdictEl.className = 'verdict-label';
  if (isReal) verdictEl.classList.add('verdict-label--real');
  else if (isSynthetic) verdictEl.classList.add('verdict-label--synthetic');

  const confidence = getPredictionConfidence(data);
  const confEl = document.getElementById('pred-confidence');
  confEl.textContent = `SentinelScore: ${formatSentinelScore(confidence)}`;

  document.getElementById('pred-sample-id').textContent = data.sample_id ?? '—';

  const fnEl = document.getElementById('pred-filename');
  fnEl.textContent = data.filename ?? '';

  const urlEl = document.getElementById('pred-analysis-url');
  urlEl.innerHTML = '<button type="button" class="prediction-link-btn" id="pred-open-analysis">Jump to full analysis</button>';

  state.predictionFeedbackContext = {
    sample_id: data.sample_id ?? null,
    predicted_verdict: data.verdict ?? null,
    predicted_confidence: confidence,
    recording_input_type: data.recording_input_type ?? null,
  };
  resetPredictionFeedbackUI();

  card.style.display = '';
  setBreakdownEmptyState(false);

  const detailCard = document.getElementById('analysis-detail');
  const detailBody = document.getElementById('analysis-detail-body');
  const detailToggle = document.getElementById('analysis-detail-toggle');
  if (detailBody) {
    detailBody.classList.add('breakdown-collapsed');
    if (detailToggle) detailToggle.classList.remove('open');
  }

  document.getElementById('pred-open-analysis')?.addEventListener('click', () => {
    const analysisCard = document.getElementById('analysis-detail');
    const analysisBody = document.getElementById('analysis-detail-body');
    const analysisToggle = document.getElementById('analysis-detail-toggle');
    if (!analysisCard || !analysisBody) return;
    analysisCard.style.display = '';
    analysisBody.classList.remove('breakdown-collapsed');
    if (analysisToggle) analysisToggle.classList.add('open');
    analysisCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  if (promptFeedback) {
    setTimeout(() => {
      openMandatoryFeedbackModal();
    }, 120);
  }
}

function setPredictionFeedbackStatus(message, isError) {
  const statusEl = document.getElementById('prediction-feedback-status');
  if (!statusEl) return;
  if (!message) {
    statusEl.style.display = 'none';
    statusEl.textContent = '';
    statusEl.classList.remove('feedback-status-error', 'feedback-status-success');
    return;
  }
  statusEl.textContent = message;
  statusEl.style.display = '';
  statusEl.classList.toggle('feedback-status-error', !!isError);
  statusEl.classList.toggle('feedback-status-success', !isError);
}

function resetPredictionFeedbackUI() {
  const box = document.getElementById('prediction-feedback');
  const details = document.getElementById('prediction-feedback-details');
  const notesEl = document.getElementById('prediction-feedback-notes');
  const correctedVerdictEl = document.getElementById('prediction-feedback-corrected-verdict');
  const submitBtn = document.getElementById('prediction-feedback-submit');
  const yesBtn = document.getElementById('prediction-feedback-yes');
  const noBtn = document.getElementById('prediction-feedback-no');
  if (box) box.style.display = 'none';
  if (details) details.style.display = 'none';
  if (notesEl) notesEl.value = '';
  if (correctedVerdictEl) correctedVerdictEl.value = '';
  if (submitBtn) submitBtn.disabled = false;
  if (yesBtn) yesBtn.disabled = false;
  if (noBtn) noBtn.disabled = false;
  setPredictionFeedbackStatus('', false);
}

async function submitPredictionFeedback(vote) {
  const ctx = state.predictionFeedbackContext;
  const notesEl = document.getElementById('prediction-feedback-notes');
  const correctedVerdictEl = document.getElementById('prediction-feedback-corrected-verdict');
  const submitBtn = document.getElementById('prediction-feedback-submit');
  const yesBtn = document.getElementById('prediction-feedback-yes');
  const noBtn = document.getElementById('prediction-feedback-no');
  const details = document.getElementById('prediction-feedback-details');

  if (!ctx || ctx.sample_id == null) {
    setPredictionFeedbackStatus('No sample is available for feedback yet.', true);
    return;
  }

  const correctedVerdict = vote === 'incorrect' ? (correctedVerdictEl?.value || null) : null;
  const notes = notesEl?.value?.trim() || null;
  const userId = state.userId ?? getStoredUserId();

  if (yesBtn) yesBtn.disabled = true;
  if (noBtn) noBtn.disabled = true;
  if (submitBtn) submitBtn.disabled = true;
  setPredictionFeedbackStatus('Submitting feedback...', false);

  try {
    const payload = {
      sample_id: ctx.sample_id,
      user_id: userId,
      vote,
      predicted_verdict: ctx.predicted_verdict,
      predicted_confidence: ctx.predicted_confidence,
      corrected_verdict: correctedVerdict,
      feedback_notes: notes,
      recording_input_type: ctx.recording_input_type,
    };

    const res = await apiFetch(PREDICTION_FEEDBACK_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await res.text();

    if (!res.ok) {
      setPredictionFeedbackStatus(parseApiError(res, text), true);
      if (yesBtn) yesBtn.disabled = false;
      if (noBtn) noBtn.disabled = false;
      if (submitBtn) submitBtn.disabled = false;
      return;
    }

    setPredictionFeedbackStatus('Thanks. Your feedback was submitted.', false);
    if (details) details.style.display = 'none';
  } catch (err) {
    setPredictionFeedbackStatus(formatNetworkError(err), true);
    if (yesBtn) yesBtn.disabled = false;
    if (noBtn) noBtn.disabled = false;
    if (submitBtn) submitBtn.disabled = false;
  }
}

async function sendPredictionFeedback(vote, correctedVerdict, notes) {
  const ctx = state.predictionFeedbackContext;
  if (!ctx || ctx.sample_id == null) {
    return { ok: false, message: 'No sample is available for feedback yet.' };
  }

  const userId = state.userId ?? getStoredUserId();
  const payload = {
    sample_id: ctx.sample_id,
    user_id: userId,
    vote,
    predicted_verdict: ctx.predicted_verdict,
    predicted_confidence: ctx.predicted_confidence,
    corrected_verdict: correctedVerdict || null,
    feedback_notes: notes || null,
    recording_input_type: ctx.recording_input_type,
  };

  try {
    const res = await apiFetch(PREDICTION_FEEDBACK_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, message: parseApiError(res, text) };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, message: formatNetworkError(err) };
  }
}

async function openMandatoryFeedbackModal() {
  const ctx = state.predictionFeedbackContext;
  if (!ctx || ctx.sample_id == null) return;
  if (state.feedbackSubmittedSamples[String(ctx.sample_id)]) return;
  if (state.feedbackPromptActive) return;

  // Fallback keeps existing inline controls available if SweetAlert is not loaded.
  if (typeof window.Swal === 'undefined') {
    const box = document.getElementById('prediction-feedback');
    if (box) box.style.display = '';
    return;
  }

  state.feedbackPromptActive = true;
  try {
    let submitted = false;
    while (!submitted) {
      const first = await window.Swal.fire({
        title: 'Help Improve Voice Sentinel',
        html: '<p style="margin:0;color:#64748b;">Was this prediction correct?</p>',
        icon: 'question',
        showDenyButton: true,
        confirmButtonText: 'Yes, accurate',
        denyButtonText: 'No, inaccurate',
        allowOutsideClick: false,
        allowEscapeKey: false,
        showCloseButton: false,
      });

      if (first.isConfirmed) {
        const result = await sendPredictionFeedback('correct', null, null);
        if (result.ok) {
          submitted = true;
          break;
        }
        await window.Swal.fire({
          icon: 'error',
          title: 'Feedback not submitted',
          text: result.message || 'Please try again.',
          allowOutsideClick: false,
          allowEscapeKey: false,
          confirmButtonText: 'Retry',
        });
        continue;
      }

      if (first.isDenied) {
        const second = await window.Swal.fire({
          title: 'What should it be?',
          html:
            '<label for="swal-corrected" style="display:block;text-align:left;font-size:12px;color:#64748b;margin-bottom:6px;">Correct label (optional)</label>' +
            '<select id="swal-corrected" class="swal2-input" style="margin:0 0 10px;max-width:100%;height:42px;">' +
            '<option value="">Prefer not to say</option>' +
            '<option value="Real">Real</option>' +
            '<option value="Synthetic">Synthetic</option>' +
            '</select>' +
            '<label for="swal-notes" style="display:block;text-align:left;font-size:12px;color:#64748b;margin-bottom:6px;">Notes (optional)</label>' +
            '<textarea id="swal-notes" class="swal2-textarea" placeholder="What looked wrong?" style="margin:0;max-width:100%;"></textarea>',
          focusConfirm: false,
          showCancelButton: false,
          confirmButtonText: 'Submit feedback',
          allowOutsideClick: false,
          allowEscapeKey: false,
          preConfirm: async () => {
            const correctedVerdict = document.getElementById('swal-corrected')?.value || null;
            const notes = document.getElementById('swal-notes')?.value?.trim() || null;
            const result = await sendPredictionFeedback('incorrect', correctedVerdict, notes);
            if (!result.ok) {
              window.Swal.showValidationMessage(result.message || 'Submission failed. Please try again.');
              return false;
            }
            return true;
          },
        });
        if (second.isConfirmed) {
          submitted = true;
          break;
        }
      }
    }

    state.feedbackSubmittedSamples[String(ctx.sample_id)] = true;
    await window.Swal.fire({
      icon: 'success',
      title: 'Thanks for voting',
      text: 'Your feedback helps improve model quality.',
      timer: 1300,
      showConfirmButton: false,
    });
  } finally {
    state.feedbackPromptActive = false;
  }
}

function updateHistorySummary(serverCount) {
  const serverEl = document.getElementById('history-server-count');
  if (serverEl) serverEl.textContent = String(serverCount ?? 0);
}

async function openSampleBreakdown(sampleId, verdict) {
  if (sampleId == null) return;
  navTo('audio-breakdown');
  const analysisOpts = {
    loadingEl: document.getElementById('analysis-detail-loading'),
    errorEl: document.getElementById('analysis-detail-error'),
    contentEl: document.getElementById('analysis-detail-content'),
    cardEl: document.getElementById('analysis-detail'),
  };
  const userId = state.userId ?? getStoredUserId();
  let data = null;
  if (userId != null) {
    data = await fetchSampleAnalysis(sampleId, userId, analysisOpts);
  } else {
    data = await fetchAnalysis(sampleId, analysisOpts);
  }
  if (data && typeof data === 'object') showPredictionResult(data, { promptFeedback: false });
  else showPredictionResult({ sample_id: sampleId, verdict }, { promptFeedback: false });
}

async function openPublicSampleBreakdown(sampleId) {
  if (!sampleId) return;
  navTo('audio-breakdown');
  const analysisOpts = {
    loadingEl: document.getElementById('analysis-detail-loading'),
    errorEl: document.getElementById('analysis-detail-error'),
    contentEl: document.getElementById('analysis-detail-content'),
    cardEl: document.getElementById('analysis-detail'),
  };
  const data = await fetchAnalysis(sampleId, analysisOpts);
  if (data && typeof data === 'object') showPredictionResult(data, { promptFeedback: false });
}

async function submitRecordingFromReview() {
  const blob = state.reviewBlob;
  const submitBtn = document.getElementById('review-submit-btn');
  const reviewErrorEl = document.getElementById('review-error');
  const transcriptionEl = document.getElementById('review-transcription');
  if (reviewErrorEl) { reviewErrorEl.style.display = 'none'; reviewErrorEl.textContent = ''; }

  const duration = formatDuration(pendingReviewDuration);
  const name = pendingReviewFileName || `Recording ${state.recordings.length + 1}`;

  if (!blob) {
    if (reviewErrorEl) { reviewErrorEl.textContent = 'No audio to submit.'; reviewErrorEl.style.display = 'block'; }
    return;
  }

  if (blob instanceof File && !isAllowedAudioFile(blob)) {
    if (reviewErrorEl) { reviewErrorEl.textContent = 'Only WAV and MP3 files are accepted. Please upload a supported file.'; reviewErrorEl.style.display = 'block'; }
    return;
  }

  const userId = state.userId ?? getStoredUserId();
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Analyzing…'; }

  const formData = new FormData();
  const filename = blob instanceof File ? blob.name : 'recording.wav';
  formData.append('file', blob, filename);
  if (userId != null) formData.append('user_id', String(userId));
  const recordingInputType = state.reviewInputType || (blob instanceof File ? 'upload' : 'live_user');
  formData.append(RECORDING_INPUT_TYPE_KEY, recordingInputType);

  try {
    const res = await apiFetch('forensics/predict', {
      method: 'POST',
      body: formData,
    });
    const text = await res.text();

    if (res.ok) {
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }

      const sampleId = data?.sample_id ?? null;
      const verdict = data?.verdict ?? null;
      const confidence = getPredictionConfidence(data);
      const analysisUrl = data?.analysis_url ?? null;

      if (transcriptionEl) {
        transcriptionEl.textContent = verdict
          ? `Verdict: ${verdict}` + (confidence != null ? ` (SentinelScore: ${formatSentinelScore(confidence)})` : '')
          : 'Analysis complete.';
      }

      const footprint = {
        user_id: userId,
        sample_id: sampleId,
        filename: name,
        verdict,
        confidence,
        confidence_score: confidence,
        analysis_url: analysisUrl,
        recording_input_type: recordingInputType,
        source: blob instanceof File ? 'upload' : 'recording',
        date: new Date().toISOString(),
      };
      saveSampleFootprint(footprint);

      state.recordings.unshift({ name, duration, status: 'completed', verdict, confidence, sampleId });
      saveRecordings();
      closeReviewModal();
      renderRecordings();
      showPredictionResult(footprint);
      navTo('audio-breakdown');

      if (sampleId != null) {
        const analysisOpts = {
          loadingEl: document.getElementById('analysis-detail-loading'),
          errorEl: document.getElementById('analysis-detail-error'),
          contentEl: document.getElementById('analysis-detail-content'),
          cardEl: document.getElementById('analysis-detail'),
        };
        if (userId != null) {
          fetchSampleAnalysis(sampleId, userId, analysisOpts);
        } else {
          fetchAnalysis(sampleId, analysisOpts);
        }
        populateSamplePicker([{ sample_id: sampleId, verdict, date: new Date().toISOString() }]);
      }
      return;
    }

    if (res.status === 415) {
      if (reviewErrorEl) { reviewErrorEl.textContent = 'Unsupported audio format. Only WAV and MP3 files are accepted.'; reviewErrorEl.style.display = 'block'; }
    } else if (res.status === 500) {
      if (reviewErrorEl) { reviewErrorEl.textContent = 'Server processing error. Please try again in a moment.'; reviewErrorEl.style.display = 'block'; }
    } else {
      const errMsg = parseApiError(res, text);
      if (reviewErrorEl) { reviewErrorEl.textContent = errMsg; reviewErrorEl.style.display = 'block'; }
    }
  } catch (err) {
    if (reviewErrorEl) {
      reviewErrorEl.textContent = formatNetworkError(err);
      reviewErrorEl.style.display = 'block';
    }
  } finally {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Submit'; }
  }
}

document.getElementById('btn-record')?.addEventListener('click', () => {
  if (state.isRecording) {
    if (state.isPaused) resumeRecording();
  } else {
    const fromExternalSource = confirm('Are you recording from an external source (speaker/device)? Click OK for source audio or Cancel for your own live voice.');
    state.currentLiveInputType = fromExternalSource ? 'live_source' : 'live_user';
    startMockRecording();
  }
});

document.getElementById('btn-pause')?.addEventListener('click', () => {
  if (state.isPaused) resumeRecording();
  else pauseRecording();
});

document.getElementById('btn-stop')?.addEventListener('click', () => {
  if (state.isRecording || state.isPaused) stopRecordingAndOpenReview();
});

// Review modal: Re-record closes without saving, Submit saves and closes
document.getElementById('review-rerecord-btn')?.addEventListener('click', () => {
  closeReviewModal();
});

document.getElementById('review-submit-btn')?.addEventListener('click', () => {
  submitRecordingFromReview();
});

document.getElementById('review-modal-overlay')?.addEventListener('click', (e) => {
  if (e.target.id === 'review-modal-overlay') closeReviewModal();
});

document.getElementById('review-play-btn')?.addEventListener('click', () => {
  toggleReviewPlayback();
});

// --- Home: Upload audio from device ---
const uploadAudioInput = document.getElementById('upload-audio-input');
document.getElementById('upload-card')?.addEventListener('click', () => {
  uploadAudioInput?.click();
});
document.getElementById('voice-lab-upload-cta')?.addEventListener('click', () => {
  uploadAudioInput?.click();
});
document.getElementById('voice-lab-history-cta')?.addEventListener('click', () => {
  navTo('history');
});
document.getElementById('upload-card')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    uploadAudioInput?.click();
  }
});
uploadAudioInput?.addEventListener('change', () => {
  const file = uploadAudioInput.files?.[0];
  if (!file) return;
  if (!isAllowedAudioFile(file)) {
    alert('Only WAV and MP3 files are accepted. Please select a supported file.');
    uploadAudioInput.value = '';
    return;
  }
  pendingReviewDuration = 0;
  pendingReviewFileName = file.name;
  state.reviewInputType = 'upload';
  openReviewModal(file);
  uploadAudioInput.value = '';
});

// --- Persist recordings in localStorage per user ---
const RECORDINGS_STORAGE_KEY = 'voiceSentinelRecordings';
function saveRecordings() {
  const uid = state.userId ?? getStoredUserId();
  if (uid == null) return;
  try {
    const data = state.recordings.map(({ name, duration, status, verdict, confidence, sampleId }) =>
      ({ name, duration, status, verdict, confidence, sampleId }));
    localStorage.setItem(`${RECORDINGS_STORAGE_KEY}_${uid}`, JSON.stringify(data));
  } catch (_) {}
}
function loadRecordings() {
  const uid = state.userId ?? getStoredUserId();
  if (uid == null) return;
  try {
    const raw = localStorage.getItem(`${RECORDINGS_STORAGE_KEY}_${uid}`);
    if (raw) state.recordings = JSON.parse(raw);
  } catch (_) {}
}

// --- Home: Recordings list ---
function renderRecordings() {
  const container = document.getElementById('recordings-list');
  if (!container) return;
  container.innerHTML = '';
  if (state.recordings.length === 0) {
    updateVoiceLabSummary();
    return;
  }
  updateVoiceLabSummary();
  state.recordings.forEach((rec, index) => {
    const tile = document.createElement('div');
    tile.className = 'card';
    const isAnalyzing = rec.status === 'analyzing';
    const icon = isAnalyzing
      ? '<div class="spinner"></div>'
      : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>';
    tile.innerHTML = `
      <div class="recording-tile">
        <div class="avatar">${icon}</div>
        <div class="info">
          <div class="name">${escapeHtml(rec.name)}</div>
          <div class="duration">${escapeHtml(rec.duration)}</div>
        </div>
        <button type="button" class="delete" data-index="${index}" aria-label="Delete">🗑</button>
      </div>
    `;
    container.appendChild(tile);
  });
  container.querySelectorAll('.delete').forEach((btn) => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.getAttribute('data-index'), 10);
      state.recordings.splice(i, 1);
      saveRecordings();
      renderRecordings();
    });
  });
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

// --- Comparative Analysis ---
const compareState = { file1: null, file2: null, sampleId1: null, sampleId2: null };

function updateCompareButton() {
  const btn = document.getElementById('compare-submit-btn');
  if (btn) btn.disabled = !(compareState.file1 && compareState.file2);
}

function setupCompareUpload(index) {
  const fileInput = document.getElementById(`compare-file-${index}`);
  const area = document.getElementById(`compare-area-${index}`);
  const nameEl = document.getElementById(`compare-name-${index}`);

  area?.addEventListener('click', () => fileInput?.click());
  area?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput?.click(); }
  });

  fileInput?.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    if (!isAllowedAudioFile(file)) {
      alert('Only WAV and MP3 files are accepted. Please select a supported file.');
      fileInput.value = '';
      return;
    }
    compareState[`file${index}`] = file;
    if (nameEl) { nameEl.textContent = file.name; nameEl.classList.add('has-file'); }
    updateCompareButton();
    fileInput.value = '';
  });
}
setupCompareUpload(1);
setupCompareUpload(2);

document.getElementById('compare-submit-btn')?.addEventListener('click', async () => {
  const errorEl = document.getElementById('compare-error');
  const loadingEl = document.getElementById('compare-loading');
  const resultEl = document.getElementById('compare-result');
  const btn = document.getElementById('compare-submit-btn');

  if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = ''; }
  if (resultEl) resultEl.style.display = 'none';

  const userId = state.userId ?? getStoredUserId();
  if (userId == null) {
    if (errorEl) { errorEl.textContent = 'Could not determine your account. Please log out and log in again.'; errorEl.style.display = ''; }
    return;
  }
  if (!compareState.file1 || !compareState.file2) {
    if (errorEl) { errorEl.textContent = 'Please upload both audio samples.'; errorEl.style.display = ''; }
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = 'Uploading…'; }
  if (loadingEl) loadingEl.style.display = '';

  try {
    const uploadSample = async (file) => {
      const fd = new FormData();
      fd.append('file', file, file.name);
      fd.append('user_id', String(userId));
      fd.append(RECORDING_INPUT_TYPE_KEY, 'upload');
      const res = await apiFetch('forensics/predict', { method: 'POST', body: fd });
      const text = await res.text();
      if (!res.ok) throw new Error(parseApiError(res, text));
      let data = null;
      try { data = JSON.parse(text); } catch { data = text; }
      return data?.sample_id ?? null;
    };

    if (loadingEl) loadingEl.textContent = 'Uploading Sample 1…';
    const sid1 = await uploadSample(compareState.file1);
    if (sid1 == null) throw new Error('Sample 1 did not return a sample ID.');

    if (loadingEl) loadingEl.textContent = 'Uploading Sample 2…';
    const sid2 = await uploadSample(compareState.file2);
    if (sid2 == null) throw new Error('Sample 2 did not return a sample ID.');

    compareState.sampleId1 = sid1;
    compareState.sampleId2 = sid2;

    if (loadingEl) loadingEl.textContent = 'Comparing…';
    const qp = new URLSearchParams({ sample_id_1: String(sid1), sample_id_2: String(sid2), user_id: String(userId) });
    const res = await apiFetch(`forensics/compare?${qp.toString()}`);
    const text = await res.text();

    if (loadingEl) loadingEl.style.display = 'none';

    if (!res.ok) {
      if (res.status === 404) {
        if (errorEl) { errorEl.textContent = 'One or both samples were not found or do not belong to your account.'; errorEl.style.display = ''; }
      } else {
        if (errorEl) { errorEl.textContent = parseApiError(res, text); errorEl.style.display = ''; }
      }
      return;
    }

    let data = null;
    try { data = JSON.parse(text); } catch { data = text; }

    const agreementEl = document.getElementById('compare-agreement');
    if (agreementEl && data) {
      const agree = data.verdict_agreement;
      if (agree === true) {
        agreementEl.textContent = 'Verdicts Agree';
        agreementEl.className = 'compare-agreement compare-agreement--agree';
      } else if (agree === false) {
        agreementEl.textContent = 'Verdicts Disagree';
        agreementEl.className = 'compare-agreement compare-agreement--disagree';
      } else {
        agreementEl.textContent = '';
        agreementEl.className = 'compare-agreement';
      }
    }

    const comparison = data?.comparison;
    const r1El = document.getElementById('compare-result-1');
    const r2El = document.getElementById('compare-result-2');
    if (Array.isArray(comparison) && comparison.length >= 2) {
      renderAnalysisContent(r1El, comparison[0]);
      renderAnalysisContent(r2El, comparison[1]);
    } else if (comparison) {
      renderAnalysisContent(r1El, comparison);
      if (r2El) r2El.innerHTML = '';
    } else {
      renderAnalysisContent(r1El, data);
      if (r2El) r2El.innerHTML = '';
    }

    if (resultEl) resultEl.style.display = '';
  } catch (err) {
    if (loadingEl) loadingEl.style.display = 'none';
    if (errorEl) { errorEl.textContent = err.message || formatNetworkError(err); errorEl.style.display = ''; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Compare Samples'; }
    updateCompareButton();
  }
});

// --- View History: fetch GET /forensics/history?user_id= and show in Audio breakdown panel ---
function renderHistoryEntry(item) {
  const el = document.createElement('div');
  el.className = 'card history-entry';
  if (typeof item !== 'object' || item === null) {
    el.innerHTML = `<div class="card-inner"><p class="history-entry-text">${escapeHtml(String(item))}</p></div>`;
    return el;
  }
  const verdict = item.verdict ?? '—';
  const verdictClass = verdict === 'Real' ? 'prediction-verdict--real' : verdict === 'Synthetic' ? 'prediction-verdict--synthetic' : '';
  const conf = item.confidence_score ?? item.confidence;
  const confStr = conf != null ? `${(conf * 100).toFixed(1)}%` : '—';
  const sampleId = item.sample_id ?? '—';
  const filename = item.filename ?? '';
  const sourceTag = item.source_tag ?? '';
  const date = item.created_at ?? item.date;
  const dateStr = date ? new Date(date).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';

  el.innerHTML =
    `<div class="card-inner history-entry-card">` +
      `<div class="history-entry-header">` +
        `<span class="history-entry-verdict ${verdictClass}">${escapeHtml(String(verdict))}</span>` +
        `<span class="history-entry-conf">SentinelScore: ${escapeHtml(confStr)}</span>` +
      `</div>` +
      `<div class="history-entry-details">` +
        `<span>Sample ID: ${escapeHtml(String(sampleId))}</span>` +
        (filename ? `<span>${escapeHtml(filename)}</span>` : '') +
        (sourceTag ? `<span>${escapeHtml(sourceTag)}</span>` : '') +
        (dateStr ? `<span>${escapeHtml(dateStr)}</span>` : '') +
      `</div>` +
      (item.sample_id != null ? `<div class="history-entry-actions"><button type="button" class="btn-primary history-open-btn">Open analysis</button></div>` : '') +
    `</div>`;
  el.querySelector('.history-open-btn')?.addEventListener('click', () => openSampleBreakdown(item.sample_id, item.verdict));
  return el;
}

async function loadHistoryFromServer() {
  const listEl = document.getElementById('history-list');
  const errorEl = document.getElementById('history-error');
  const loadingEl = document.getElementById('history-loading');
  const placeholderCard = document.getElementById('history-placeholder-card');
  updateHistorySummary(0);
  if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = ''; }
  if (listEl) listEl.style.display = 'none';
  if (placeholderCard) placeholderCard.style.display = 'none';
  if (loadingEl) { loadingEl.style.display = 'block'; loadingEl.textContent = 'Loading history…'; }

  const userId = state.userId ?? getStoredUserId();
  if (userId == null) {
    if (loadingEl) loadingEl.style.display = 'none';
    if (errorEl) { errorEl.textContent = 'Could not determine your account. Please log out and log in again.'; errorEl.style.display = 'block'; }
    if (placeholderCard) placeholderCard.style.display = 'block';
    return;
  }

  try {
    const res = await apiFetch(`forensics/history?user_id=${encodeURIComponent(userId)}`);
    const text = await res.text();
    if (loadingEl) loadingEl.style.display = 'none';
    if (!res.ok) {
      if (errorEl) {
        errorEl.textContent = parseApiError(res, text);
        errorEl.style.display = 'block';
      }
      if (placeholderCard) placeholderCard.style.display = 'block';
      return;
    }
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    const clearBtn = document.getElementById('clear-history-btn');
    let hasEntries = false;
    let serverCount = 0;
    let serverItems = [];
    if (Array.isArray(data)) serverItems = data;
    else if (data != null && data !== '') serverItems = [data];

    serverItems.sort((a, b) => {
      const da = new Date(a.created_at ?? a.date ?? 0).getTime();
      const db = new Date(b.created_at ?? b.date ?? 0).getTime();
      return db - da;
    });

    if (listEl) {
      listEl.innerHTML = '';
      if (serverItems.length > 0) {
        serverItems.forEach((item) => listEl.appendChild(renderHistoryEntry(item)));
        hasEntries = true;
        serverCount = serverItems.length;
      } else {
        listEl.innerHTML = '<div class="card"><div class="card-inner placeholder-card"><p>No history yet. Record or upload audio and submit to see entries here.</p></div></div>';
      }
      listEl.style.display = 'block';
      listEl.classList.toggle('history-list-empty', !hasEntries);
    }
    updateHistorySummary(serverCount);
    if (clearBtn) clearBtn.style.display = hasEntries ? '' : 'none';
    if (placeholderCard) placeholderCard.style.display = 'none';
    populateSamplePicker(serverItems);
  } catch (err) {
    if (loadingEl) loadingEl.style.display = 'none';
    if (errorEl) {
      errorEl.textContent = formatNetworkError(err);
      errorEl.style.display = 'block';
    }
    if (placeholderCard) placeholderCard.style.display = 'block';
  }
}

document.getElementById('history-refresh-btn')?.addEventListener('click', () => {
  loadHistoryFromServer();
});

// --- Clear All History ---
document.getElementById('clear-history-btn')?.addEventListener('click', async () => {
  if (!confirm('Permanently delete all your analysis history? This cannot be undone.')) return;
  const btn = document.getElementById('clear-history-btn');
  const errorEl = document.getElementById('clear-history-error');
  if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = ''; }
  if (btn) btn.disabled = true;

  const userId = state.userId ?? getStoredUserId();
  if (userId == null) {
    if (errorEl) { errorEl.textContent = 'Could not determine your account. Please log out and log in again.'; errorEl.style.display = 'block'; }
    if (btn) btn.disabled = false;
    return;
  }

  try {
    const res = await apiFetch('forensics/history/clear', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ user_id: String(userId) }).toString(),
    });
    const text = await res.text();
    if (res.ok) {
      const listEl = document.getElementById('history-list');
      if (listEl) {
        listEl.innerHTML = '<div class="card"><div class="card-inner placeholder-card"><p>History cleared. Record or upload audio to see entries here.</p></div></div>';
        listEl.style.display = 'block';
      }
      updateHistorySummary(0);
      if (btn) btn.style.display = 'none';
    } else {
      if (errorEl) { errorEl.textContent = parseApiError(res, text); errorEl.style.display = 'block'; }
    }
  } catch (err) {
    if (errorEl) { errorEl.textContent = formatNetworkError(err); errorEl.style.display = 'block'; }
  } finally {
    if (btn) btn.disabled = false;
  }
});

// --- Analysis detail expand/collapse toggle ---
document.getElementById('analysis-detail-toggle')?.addEventListener('click', () => {
  const body = document.getElementById('analysis-detail-body');
  const btn = document.getElementById('analysis-detail-toggle');
  if (!body) return;
  const collapsed = body.classList.toggle('breakdown-collapsed');
  if (btn) btn.classList.toggle('open', !collapsed);
});

// --- Sample Picker (authenticated users) ---
document.getElementById('sample-picker-btn')?.addEventListener('click', async () => {
  const select = document.getElementById('sample-picker-select');
  const errorEl = document.getElementById('sample-picker-error');
  const btn = document.getElementById('sample-picker-btn');

  if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = ''; }

  const sampleId = select?.value;
  if (!sampleId) {
    if (errorEl) { errorEl.textContent = 'Please select a sample.'; errorEl.style.display = ''; }
    return;
  }

  const userId = state.userId ?? getStoredUserId();
  if (userId == null) {
    if (errorEl) { errorEl.textContent = 'Could not determine your account. Please log out and log in again.'; errorEl.style.display = ''; }
    return;
  }

  if (btn) btn.disabled = true;
  await openSampleBreakdown(sampleId);
  if (btn) btn.disabled = false;
});

// --- Manual Sample Lookup (no account needed) ---
document.getElementById('lookup-sample-btn')?.addEventListener('click', async () => {
  const input = document.getElementById('lookup-sample-id');
  const errorEl = document.getElementById('lookup-error');
  const btn = document.getElementById('lookup-sample-btn');

  if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = ''; }

  const sampleId = input?.value?.trim();
  if (!sampleId) {
    if (errorEl) { errorEl.textContent = 'Please enter a sample ID.'; errorEl.style.display = ''; }
    return;
  }

  if (btn) btn.disabled = true;
  await openPublicSampleBreakdown(sampleId);
  if (btn) btn.disabled = false;
});

document.getElementById('prediction-feedback-yes')?.addEventListener('click', () => {
  submitPredictionFeedback('correct');
});

document.getElementById('prediction-feedback-no')?.addEventListener('click', () => {
  const details = document.getElementById('prediction-feedback-details');
  if (details) details.style.display = '';
  setPredictionFeedbackStatus('Provide optional details, then submit.', false);
});

document.getElementById('prediction-feedback-submit')?.addEventListener('click', () => {
  submitPredictionFeedback('incorrect');
});

updateUserSurface();
updateVoiceLabSummary();
setBreakdownEmptyState(true);
