/**
 * Voice Sentinel – Web UI.
 * API base: local/dev = http://45.55.247.199/api; on Vercel = /api (proxied in vercel.json).
 * All APIs use this base; none send the user's name.
 * Endpoints: POST /auth/register, POST /auth/login, GET /user/me, PATCH /user/update, POST /auth/change-password, DELETE /user/terminate, GET /system/stats, POST /forensics/predict (multipart: file, user_id).
 */
const API_BASE =
  typeof window !== 'undefined' &&
  window.location &&
  window.location.hostname.endsWith('vercel.app')
    ? '/api'
    : 'http://45.55.247.199/api';

const AUTH_TOKEN_KEY = 'voiceSentinelToken';

/** Returns the stored auth token, or null if not logged in. */
function getAuthToken() {
  try {
    return localStorage.getItem(AUTH_TOKEN_KEY);
  } catch {
    return null;
  }
}

/** Clears the stored auth token (e.g. on log out). */
function clearAuthToken() {
  try {
    localStorage.removeItem(AUTH_TOKEN_KEY);
  } catch (_) {}
}

/**
 * Fetch helper that calls the API with the auth token attached.
 * @param {string} path - Path relative to API_BASE (e.g. '/auth/login' or 'users/me')
 * @param {RequestInit} [options] - Same as fetch() options; headers are merged with Authorization if token exists.
 * @returns {Promise<Response>}
 */
function apiFetch(path, options = {}) {
  const url = path.startsWith('http') ? path : `${API_BASE.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
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
  recordedChunks: [],
  recordedBlob: null,
  reviewAudioUrl: null,
  /** Current blob/file in review modal (for POST forensics/predict). */
  reviewBlob: null,
  /** User id from GET /user/me (for forensics API). */
  userId: null,
};

// --- DOM ---
const welcomeScreen = document.getElementById('screen-welcome');
const appShell = document.getElementById('app-shell');
const panels = {
  home: document.getElementById('panel-home'),
  settings: document.getElementById('panel-settings'),
  changeUserType: document.getElementById('panel-change-user-type'),
  audioBreakdown: document.getElementById('panel-audio-breakdown'),
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
  'settings': 'settings',
  'change-user-type': 'changeUserType',
  'audio-breakdown': 'audioBreakdown',
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
  if (path === 'home') showPanel('home');
  else if (path === 'settings') showPanel('settings');
  else if (path === 'change-user-type') showPanel('changeUserType');
  else if (path === 'audio-breakdown') showPanel('audioBreakdown');
  else if (path === 'download') showPanel('download');
}

// --- Sidebar nav ---
document.querySelectorAll('.sidebar-nav .nav-item[data-nav]').forEach((btn) => {
  btn.addEventListener('click', () => navTo(btn.getAttribute('data-nav')));
});
document.getElementById('sidebar-logout')?.addEventListener('click', () => {
  clearAuthToken();
  navTo('welcome');
});

// --- Restore session on load/refresh: if user has a token, stay in the app and fetch user id for forensics ---
if (getAuthToken()) {
  enterApp();
  (async () => {
    try {
      const res = await apiFetch('user/me', { method: 'GET' });
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      if (res.ok && data && typeof data === 'object') {
        const id = data.id ?? data.user_id ?? data.userId;
        if (id != null) state.userId = Number(id);
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
      enterApp();
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
      if (typeof data === 'string' && data) {
        try { localStorage.setItem(AUTH_TOKEN_KEY, data); } catch (_) {}
      } else if (data && typeof data === 'object' && (data.access_token ?? data.token)) {
        const token = data.access_token ?? data.token;
        try { localStorage.setItem(AUTH_TOKEN_KEY, token); } catch (_) {}
      }
      enterApp();
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
  try {
    const res = await apiFetch('user/update', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ level }).toString(),
    });
    const text = await res.text();
    if (res.ok) {
      try { localStorage.setItem('voiceSentinelUserType', level); } catch (_) {}
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
const EDIT_PROFILE_STORAGE_KEY = 'voiceSentinelUserType';
/** Name is stored in localStorage only; never sent to register, login, or any other API. Updated on sign-up and when user changes it in Edit profile. */
const USER_NAME_STORAGE_KEY = 'voiceSentinelUserName';
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
    const res = await apiFetch('user/me', { method: 'GET' });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (res.ok && data && typeof data === 'object') {
      const id = data.id ?? data.user_id ?? data.userId;
      if (id != null) state.userId = Number(id);
      const level = data.level ?? data.user_type ?? data.userType;
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
    // API: change password only when user chose to change it.
    if (wantPasswordChange) {
      const body = new URLSearchParams({ old: currentPassword, new: newPassword });
      const res = await apiFetch('auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      const text = await res.text();
      if (!res.ok) {
        showEditProfileError(parseApiError(res, text));
        if (saveBtn) saveBtn.disabled = false;
        return;
      }
    }

    // API: update user type only when user chose to change it.
    if (wantLevelChange) {
      const res = await apiFetch('user/update', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ level }).toString(),
      });

      if (res.ok) {
        try { localStorage.setItem(EDIT_PROFILE_STORAGE_KEY, level); } catch (_) {}
        if (changeUserSelect) changeUserSelect.value = level;
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

// --- Settings: Delete account ---
document.getElementById('settings-delete-account')?.addEventListener('click', async () => {
  if (!confirm('Permanently delete your account? This cannot be undone.')) return;
  const btn = document.getElementById('settings-delete-account');
  const errorEl = document.getElementById('settings-delete-error');
  if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = ''; }
  if (btn) btn.disabled = true;
  try {
    const res = await apiFetch('user/terminate', { method: 'DELETE' });
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
      // Capture audio for review playback
      try {
        state.recordedChunks = [];
        const recorder = new MediaRecorder(stream);
        recorder.ondataavailable = (e) => { if (e.data.size) state.recordedChunks.push(e.data); };
        recorder.onstop = () => {
          state.recordedBlob = new Blob(state.recordedChunks, { type: recorder.mimeType || 'audio/webm' });
          state.mediaRecorder = null;
          stopWaveform();
          pendingReviewDuration = state.recordingSeconds;
          pendingReviewFileName = null;
          updateRecordUI();
          openReviewModal(state.recordedBlob);
        };
        recorder.start();
        state.mediaRecorder = recorder;
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
  if (state.waveformAnimationId) {
    cancelAnimationFrame(state.waveformAnimationId);
    state.waveformAnimationId = null;
  }
  updateRecordUI();
}

function resumeRecording() {
  if (!state.isRecording || !state.isPaused) return;
  state.isPaused = false;
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
  if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
    state.mediaRecorder.stop();
    // Modal opens from mediaRecorder.onstop
  } else {
    stopWaveform();
    pendingReviewDuration = state.recordingSeconds;
    pendingReviewFileName = null;
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

async function submitRecordingFromReview() {
  const blob = state.reviewBlob;
  const submitBtn = document.getElementById('review-submit-btn');
  const reviewErrorEl = document.getElementById('review-error');
  const transcriptionEl = document.getElementById('review-transcription');
  if (reviewErrorEl) { reviewErrorEl.style.display = 'none'; reviewErrorEl.textContent = ''; }

  const duration = formatDuration(pendingReviewDuration);
  const name = pendingReviewFileName || `Recording ${state.recordings.length + 1}`;

  if (blob) {
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Submitting…'; }
    const formData = new FormData();
    const filename = blob instanceof File ? blob.name : 'recording.webm';
    formData.append('file', blob, filename);
    formData.append('user_id', String(state.userId ?? 0));
    try {
      const res = await apiFetch('forensics/predict', {
        method: 'POST',
        body: formData,
      });
      const text = await res.text();
      if (res.ok) {
        if (transcriptionEl) transcriptionEl.textContent = typeof text === 'string' && text ? text : 'Analysis complete.';
        state.recordings.unshift({ name, duration, status: 'completed' });
        closeReviewModal();
        renderRecordings();
        return;
      }
      const errMsg = parseApiError(res, text);
      if (reviewErrorEl) { reviewErrorEl.textContent = errMsg; reviewErrorEl.style.display = 'block'; }
    } catch (err) {
      if (reviewErrorEl) {
        reviewErrorEl.textContent = formatNetworkError(err);
        reviewErrorEl.style.display = 'block';
      }
    } finally {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Submit'; }
    }
    return;
  }

  state.recordings.unshift({ name, duration, status: 'analyzing' });
  closeReviewModal();
  renderRecordings();
  setTimeout(() => {
    const r = state.recordings.find((x) => x.status === 'analyzing');
    if (r) r.status = 'completed';
    renderRecordings();
  }, 2000);
}

document.getElementById('btn-record')?.addEventListener('click', () => {
  if (state.isRecording) {
    if (state.isPaused) resumeRecording();
  } else {
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
document.getElementById('upload-card')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    uploadAudioInput?.click();
  }
});
uploadAudioInput?.addEventListener('change', () => {
  const file = uploadAudioInput.files?.[0];
  if (!file) return;
  if (!file.type.startsWith('audio/')) {
    return;
  }
  pendingReviewDuration = 0;
  pendingReviewFileName = file.name;
  openReviewModal(file);
  uploadAudioInput.value = '';
});

// --- Home: Recordings list ---
function renderRecordings() {
  const container = document.getElementById('recordings-list');
  const titleEl = document.getElementById('recent-title');
  if (!container) return;
  container.innerHTML = '';
  if (state.recordings.length === 0) {
    if (titleEl) titleEl.style.display = 'none';
    return;
  }
  if (titleEl) titleEl.style.display = 'block';
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
      renderRecordings();
    });
  });
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

// --- View History: fetch GET /forensics/history and show in Audio breakdown panel ---
document.getElementById('btn-history')?.addEventListener('click', async () => {
  const listEl = document.getElementById('history-list');
  const errorEl = document.getElementById('history-error');
  const loadingEl = document.getElementById('history-loading');
  const placeholderCard = document.getElementById('history-placeholder-card');
  if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = ''; }
  if (listEl) listEl.style.display = 'none';
  if (placeholderCard) placeholderCard.style.display = 'none';
  if (loadingEl) { loadingEl.style.display = 'block'; loadingEl.textContent = 'Loading history…'; }
  navTo('audio-breakdown');
  try {
    const res = await apiFetch('forensics/history');
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
    if (listEl) {
      listEl.innerHTML = '';
      if (Array.isArray(data) && data.length > 0) {
        data.forEach((item, i) => {
          const entry = document.createElement('div');
          entry.className = 'card history-entry';
          if (typeof item === 'object' && item !== null) {
            entry.innerHTML = `<div class="card-inner"><pre class="history-entry-json">${escapeHtml(JSON.stringify(item, null, 2))}</pre></div>`;
          } else {
            entry.innerHTML = `<div class="card-inner"><p class="history-entry-text">${escapeHtml(String(item))}</p></div>`;
          }
          listEl.appendChild(entry);
        });
      } else if (Array.isArray(data)) {
        listEl.innerHTML = '<div class="card"><div class="card-inner placeholder-card"><p>No history yet. Record or upload audio and submit to see entries here.</p></div></div>';
      } else if (data !== null && data !== '') {
        listEl.innerHTML = `<div class="card"><div class="card-inner"><pre class="history-entry-json">${escapeHtml(typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data))}</pre></div></div>`;
      } else {
        listEl.innerHTML = '<div class="card"><div class="card-inner placeholder-card"><p>No history yet. Record or upload audio and submit to see entries here.</p></div></div>';
      }
      listEl.style.display = 'block';
    }
    if (placeholderCard) placeholderCard.style.display = 'none';
  } catch (err) {
    if (loadingEl) loadingEl.style.display = 'none';
    if (errorEl) {
      errorEl.textContent = formatNetworkError(err);
      errorEl.style.display = 'block';
    }
    if (placeholderCard) placeholderCard.style.display = 'block';
  }
});
