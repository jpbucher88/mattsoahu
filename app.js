// ================================================================
// Aloha Fleet Management System - Main Application
// ================================================================

// --------------- FIREBASE INIT ---------------
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);
const db = firebase.firestore();
let storage = null;
try {
  storage = firebase.storage();
} catch (e) {
  console.warn('Firebase Storage not available yet. Photo uploads will not work until Storage is enabled.');
}

function getStorage() {
  if (!storage) {
    try { storage = firebase.storage(); } catch (e) { /* still not enabled */ }
  }
  return storage;
}

// --------------- GLOBALS ---------------
const APP_TIMEZONE = 'Pacific/Honolulu'; // Hawaii Standard Time (used by entire app)
const TC_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone; // user's local TZ, used only by time clock display

// Get short TZ abbreviation (e.g. "HST", "EST") for display
function tzAbbr(tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date());
    const abbr = (parts.find(p => p.type === 'timeZoneName') || {}).value || '';
    return abbr;
  } catch (e) { return ''; }
}

// Format a Date in a given timezone as HH:MM AM/PM TZ
function fmtTcTime(date, tz) {
  const zone = tz || TC_TIMEZONE;
  const time = date.toLocaleTimeString('en-US', { timeZone: zone, hour: '2-digit', minute: '2-digit' });
  const abbr = tzAbbr(zone);
  return abbr ? `${time} ${abbr}` : time;
}
let currentUser = null;
let currentUserRole = null;
let currentUserTimeclockAccess = false;
let currentUserCanViewAllTimeclocks = false;
let tcViewingUid = null;   // null = own timeclock
let tcEmployees = [];      // [{uid, name, email}] populated for view-all users
let selectedVehicle = null;
let selectedAdminPhotos = new Set();
let selectedDate = todayDateString(); // dashboard photo date
let photoDatesCache = new Set();      // dates with photos for current vehicle/month

// --------------- PASSWORD TOGGLE ---------------
window.togglePassword = function(inputId, btn) {
  const input = $(inputId);
  if (input.type === 'password') {
    input.type = 'text';
    btn.textContent = 'Hide';
  } else {
    input.type = 'password';
    btn.textContent = 'Show';
  }
};

// --------------- DOM REFS ---------------
const $ = (id) => document.getElementById(id);

// ---- Datetime split-input helpers ----
// Combine a date input (YYYY-MM-DD) + text time input (HH:MM) into a datetime-local string
function getDTValue(dateId, timeId) {
  const d = $(dateId) ? $(dateId).value : '';
  if (!d) return '';
  let t = ($(timeId) ? $(timeId).value.trim() : '') || '';
  // If there is a paired AM/PM select, convert 12h → 24h
  const ampmEl = $(timeId + '-ampm');
  if (ampmEl && t && t.includes(':')) {
    let [hh, mm] = t.split(':').map(s => parseInt(s, 10) || 0);
    const ampm = ampmEl.value;
    if (ampm === 'PM' && hh !== 12) hh += 12;
    if (ampm === 'AM' && hh === 12) hh = 0;
    t = String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
  } else if (!t) {
    t = '00:00';
  }
  return d + 'T' + t;
}
// Set a date + text-time split pair from a Date object or Firestore Timestamp
function setDTValue(dateId, timeId, dateObjOrTimestamp) {
  const dEl = $(dateId), tEl = $(timeId);
  if (!dEl || !tEl) return;
  const ampmEl = $(timeId + '-ampm');
  if (!dateObjOrTimestamp) {
    dEl.value = ''; tEl.value = '';
    if (ampmEl) ampmEl.value = 'AM';
    return;
  }
  const d = dateObjOrTimestamp.toDate ? dateObjOrTimestamp.toDate() : (dateObjOrTimestamp instanceof Date ? dateObjOrTimestamp : new Date(dateObjOrTimestamp));
  dEl.value = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  if (ampmEl) {
    // 12h format with AM/PM
    const h24 = d.getHours(), m = d.getMinutes();
    const ampm = h24 >= 12 ? 'PM' : 'AM';
    const h12 = h24 === 0 ? 12 : h24 > 12 ? h24 - 12 : h24;
    tEl.value = String(h12).padStart(2, '0') + ':' + String(m).padStart(2, '0');
    ampmEl.value = ampm;
  } else {
    tEl.value = String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
  }
}
// Auto-format HH:MM as user types into a .dt-time-input
document.addEventListener('input', function(e) {
  const el = e.target;
  if (!el.classList || !el.classList.contains('dt-time-input')) return;
  let v = el.value.replace(/\D/g, '');
  if (v.length > 4) v = v.slice(0, 4);
  if (v.length >= 3) v = v.slice(0, 2) + ':' + v.slice(2);
  if (el.value !== v) el.value = v;
});

const pages = {
  login: $('page-login'),
  dashboard: $('page-dashboard'),
  vehicle: $('page-vehicle'),
  admin: $('page-admin'),
};

// --------------- UTILITY FUNCTIONS ---------------

function showPage(name) {
  Object.values(pages).forEach(p => p.classList.remove('active'));
  pages[name].classList.add('active');
  window.scrollTo(0, 0);
}

// --------------- COLLAPSIBLE SECTIONS ---------------
window.toggleSection = function(bodyId, toggleId) {
  const body = $(bodyId);
  const btn = $(toggleId);
  if (!body) return;
  const collapsed = body.classList.toggle('collapsed');
  if (btn) btn.innerHTML = collapsed ? '&#43;' : '&#8722;';
};

function showLoading(text = 'Loading...') {
  $('loading-text').textContent = text;
  $('loading-overlay').style.display = 'flex';
}

function hideLoading() {
  $('loading-overlay').style.display = 'none';
}

function toast(message, type = 'info') {
  const container = $('toast-container');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.3s';
    setTimeout(() => el.remove(), 300);
  }, 3000);
}

// ================================================================
// DAN EASTER EGG
// ================================================================
function showDanEasterEgg() {
  const overlay = $('dan-overlay');
  const bg = $('dan-bg');
  const wordsContainer = $('dan-words');
  if (!overlay) return;

  // Scatter 100 "bitch" words across the screen
  wordsContainer.innerHTML = '';
  for (let i = 0; i < 100; i++) {
    const span = document.createElement('span');
    span.textContent = 'bitch';
    span.style.cssText = `
      position:absolute;
      left:${Math.random() * 95}%;
      top:${Math.random() * 95}%;
      font-size:${10 + Math.random() * 14}px;
      font-weight:700;
      color:rgba(255,255,255,${0.4 + Math.random() * 0.6});
      transform:rotate(${-45 + Math.random() * 90}deg);
      pointer-events:none;
      animation:danFlicker ${0.3 + Math.random() * 0.5}s infinite alternate;
      animation-delay:${Math.random() * 0.5}s;
    `;
    wordsContainer.appendChild(span);
  }

  overlay.style.display = 'block';
  overlay.style.pointerEvents = 'auto';

  // Dismiss function (used by both auto-timer and tap)
  let dismissed = false;
  function dismissEgg() {
    if (dismissed) return;
    dismissed = true;
    overlay.style.pointerEvents = 'none'; // stop eating taps immediately
    overlay.style.opacity = '0';
    overlay.style.transition = 'opacity 0.4s';
    clearInterval(flashInterval);
    setTimeout(() => {
      overlay.style.display = 'none';
      overlay.style.opacity = '1';
      overlay.style.transition = '';
      bg.style.background = '#ff0040';
    }, 400);
  }

  // Tap/click anywhere to dismiss early
  overlay.addEventListener('click', dismissEgg, { once: true });
  overlay.addEventListener('touchend', dismissEgg, { once: true, passive: true });

  // Flash the background
  let flashCount = 0;
  const flashInterval = setInterval(() => {
    flashCount++;
    bg.style.background = flashCount % 2 === 0 ? '#ff0040' : '#1a0010';
    if (flashCount >= 12) clearInterval(flashInterval);
  }, 220);

  // Auto-dismiss after 3 seconds
  setTimeout(dismissEgg, 3000);
}

// ================================================================
// ALONDRA EASTER EGG
// ================================================================
function showAlondraEasterEgg() {
  const overlay = $('alondra-overlay');
  const bg = $('alondra-bg');
  const heartsContainer = $('alondra-hearts');
  if (!overlay) return;

  // Scatter 80 heart emojis across the screen
  const hearts = ['❤️', '💕', '💖', '💗', '💓', '💝', '💞', '🌸', '✨', '🩷'];
  heartsContainer.innerHTML = '';
  for (let i = 0; i < 80; i++) {
    const span = document.createElement('span');
    span.textContent = hearts[Math.floor(Math.random() * hearts.length)];
    span.style.cssText = `
      position:absolute;
      left:${Math.random() * 95}%;
      top:${Math.random() * 95}%;
      font-size:${14 + Math.random() * 24}px;
      --r:${-30 + Math.random() * 60}deg;
      pointer-events:none;
      animation:alondraFloat ${0.8 + Math.random() * 1.4}s ease-in-out infinite;
      animation-delay:${Math.random() * 1.0}s;
    `;
    heartsContainer.appendChild(span);
  }

  overlay.style.display = 'block';
  overlay.style.pointerEvents = 'auto';

  let dismissed = false;
  function dismissEgg() {
    if (dismissed) return;
    dismissed = true;
    overlay.style.pointerEvents = 'none';
    overlay.style.opacity = '0';
    overlay.style.transition = 'opacity 0.5s';
    clearInterval(flashInterval);
    setTimeout(() => {
      overlay.style.display = 'none';
      overlay.style.opacity = '1';
      overlay.style.transition = '';
      bg.style.background = '#ff69b4';
    }, 500);
  }

  overlay.addEventListener('click', dismissEgg, { once: true });
  overlay.addEventListener('touchend', dismissEgg, { once: true, passive: true });

  // Gentle pink flash cycle
  const pinkShades = ['#ff69b4', '#ff1493', '#e91e8c', '#f06292', '#ff69b4', '#c2185b', '#ff69b4'];
  let flashCount = 0;
  const flashInterval = setInterval(() => {
    flashCount++;
    bg.style.background = pinkShades[flashCount % pinkShades.length];
    if (flashCount >= 14) clearInterval(flashInterval);
  }, 230);

  // Auto-dismiss after 3.5 seconds
  setTimeout(dismissEgg, 3500);
}

// ================================================================
// JASON BABY #2 EASTER EGG
// ================================================================
function showJasonEasterEgg() {
  const overlay = $('jason-overlay');
  const bg = $('jason-bg');
  const confettiContainer = $('jason-confetti');
  if (!overlay) return;

  // First time ever = must watch the whole thing. After that, tappable.
  const hasSeenKey = 'jasonEgg_seen_v1';
  const firstTime = !localStorage.getItem(hasSeenKey);

  // Baby + celebration emojis floating around
  const pieces = ['👶', '🍼', '🎉', '🎊', '🎈', '💙', '⭐', '🌟', '🥳', '👼', '🎀', '🤍', '✨', '🏆'];
  confettiContainer.innerHTML = '';
  for (let i = 0; i < 90; i++) {
    const span = document.createElement('span');
    span.textContent = pieces[Math.floor(Math.random() * pieces.length)];
    span.style.cssText = `
      position:absolute;
      left:${Math.random() * 96}%;
      top:${Math.random() * 96}%;
      font-size:${12 + Math.random() * 28}px;
      pointer-events:none;
      animation:jasonBounce ${0.7 + Math.random() * 1.6}s ease-in-out infinite;
      animation-delay:${Math.random() * 1.2}s;
    `;
    confettiContainer.appendChild(span);
  }

  overlay.style.display = 'block';
  overlay.style.pointerEvents = 'auto';

  let dismissed = false;
  function dismissEgg() {
    if (dismissed) return;
    dismissed = true;
    localStorage.setItem(hasSeenKey, '1');
    overlay.style.pointerEvents = 'none';
    overlay.style.opacity = '0';
    overlay.style.transition = 'opacity 0.5s';
    clearInterval(flashInterval);
    setTimeout(() => {
      overlay.style.display = 'none';
      overlay.style.opacity = '1';
      overlay.style.transition = '';
      bg.style.background = '#a8d8f0';
    }, 500);
  }

  // First time: no tap-to-dismiss — he watches the full thing
  if (!firstTime) {
    overlay.addEventListener('click', dismissEgg, { once: true });
    overlay.addEventListener('touchend', dismissEgg, { once: true, passive: true });
  }

  // Gentle blue-to-sky cycle
  const blueShades = ['#a8d8f0', '#7ec8e3', '#5bb8d4', '#90caf9', '#a8d8f0', '#64b5f6', '#bbdefb', '#a8d8f0'];
  let flashCount = 0;
  const flashInterval = setInterval(() => {
    flashCount++;
    bg.style.background = blueShades[flashCount % blueShades.length];
    if (flashCount >= 16) clearInterval(flashInterval);
  }, 240);

  // Auto-dismiss after 5 seconds
  setTimeout(dismissEgg, 5000);
}

function confirm(title, message) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-dialog">
        <h4>${escapeHtml(title)}</h4>
        <p>${escapeHtml(message)}</p>
        <div class="confirm-actions">
          <button class="btn btn-secondary btn-cancel">Cancel</button>
          <button class="btn btn-danger btn-confirm">Confirm</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector('.btn-cancel').onclick = () => { overlay.remove(); resolve(false); };
    overlay.querySelector('.btn-confirm').onclick = () => { overlay.remove(); resolve(true); };
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function todayDateString() {
  const d = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: APP_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return parts; // returns YYYY-MM-DD
}

// Render a task activity log array as HTML
function renderTaskLogEntries(log) {
  if (!log || log.length === 0) return '<p class="task-log-empty">No log entries yet.</p>';
  // Show newest first
  return [...log].reverse().map(entry => `
    <div class="task-log-entry">
      <div class="task-log-entry-text">${escapeHtml(entry.text || '')}</div>
      <div class="task-log-entry-meta">${escapeHtml(entry.by || 'Unknown')} · ${escapeHtml(entry.at || '')}</div>
    </div>`).join('');
}

function formatTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: APP_TIMEZONE });
}

function sanitizePlate(plate) {
  // Normalize plate to alphanumeric + hyphens for use as folder names
  return plate.replace(/[^a-zA-Z0-9-]/g, '_').toUpperCase();
}

// Compress image before upload
// 2560px wide at 92% quality = ~500KB-1.2MB per photo (high detail for damage docs)
function compressImage(file, maxWidth = 2560, quality = 0.92) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Image processing timed out — the file format may not be supported by this browser.')), 15000);
    const reader = new FileReader();
    reader.onerror = () => { clearTimeout(timeout); reject(new Error('Could not read the image file.')); };
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = () => { clearTimeout(timeout); reject(new Error('Could not decode image — the format may not be supported. Try taking a screenshot or converting to JPEG first.')); };
      img.onload = () => {
        clearTimeout(timeout);
        const canvas = document.createElement('canvas');
        let w = img.width;
        let h = img.height;
        if (w > maxWidth) {
          h = Math.round((h * maxWidth) / w);
          w = maxWidth;
        }
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob((blob) => {
          if (!blob) { reject(new Error('Failed to convert image to JPEG.')); return; }
          resolve(new File([blob], (file.name || 'photo').replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg', lastModified: Date.now() }));
        }, 'image/jpeg', quality);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// Compress a blob directly (used by the in-browser camera)
function compressBlob(blob, maxWidth = 2560, quality = 0.92) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Image processing timed out.')), 15000);
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onerror = () => { clearTimeout(timeout); URL.revokeObjectURL(url); reject(new Error('Could not decode camera image.')); };
    img.onload = () => {
      clearTimeout(timeout);
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      let w = img.width;
      let h = img.height;
      if (w > maxWidth) {
        h = Math.round((h * maxWidth) / w);
        w = maxWidth;
      }
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob((result) => {
        if (!result) { reject(new Error('Failed to convert to JPEG.')); return; }
        resolve(result);
      }, 'image/jpeg', quality);
    };
    img.src = url;
  });
}

// ================================================================
// AUTH
// ================================================================

auth.onAuthStateChanged(async (user) => {
  if (user) {
    currentUser = user;
    showLoading('Loading your profile...');
    try {
      const userDoc = await db.collection('users').doc(user.uid).get();
      if (!userDoc.exists) {
        toast('Account not found. Contact your admin.', 'error');
        await auth.signOut();
        return;
      }
      const userData = userDoc.data();
      currentUserRole = userData.role || 'user';
      currentUserTimeclockAccess = currentUserRole === 'admin' || userData.timeclockAccess === true;
      currentUserCanViewAllTimeclocks = currentUserRole === 'admin' || userData.canViewAllTimeclocks === true;

      $('user-display').textContent = userData.displayName || user.email;
      $('btn-admin').style.display = currentUserRole === 'admin' ? '' : 'none';

      const uName = (userData.displayName || '').toLowerCase();

      // Run auto-cleanup on any login (not just admin)
      cleanupOldPhotos();

      await loadVehicles();
      showPage('dashboard');
      startMailListener();
      startIncidentListener();
      initTimeClock();
      if (currentUserRole === 'admin' || currentUserRole === 'manager') {
        const financeBtn = $('btn-finance');
        if (financeBtn) financeBtn.style.display = '';
        const prodBtn = $('productivity-open-btn');
        if (prodBtn) prodBtn.style.display = '';
      }

      // Easter eggs: fire AFTER page is visible so they don't block the loading spinner
      if (uName.includes('dan')) {
        setTimeout(() => showDanEasterEgg(), 80);
      }
      if (uName.includes('alondra')) {
        setTimeout(() => showAlondraEasterEgg(), 80);
      }
      if (uName.includes('jason')) {
        setTimeout(() => showJasonEasterEgg(), 80);
      }
    } catch (err) {
      console.error('Auth state error:', err);
      toast('Error loading profile', 'error');
    } finally {
      hideLoading();
    }
  } else {
    currentUser = null;
    currentUserRole = null;
    currentUserTimeclockAccess = false;
    if (mailUnsubscribe) { mailUnsubscribe(); mailUnsubscribe = null; }
    if (incidentUnsubscribe) { incidentUnsubscribe(); incidentUnsubscribe = null; }
    if (elapsedInterval) { clearInterval(elapsedInterval); elapsedInterval = null; }
    showPage('login');
  }
});

// Login form
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('login-email').value.trim();
  const password = $('login-password').value;
  $('login-error').textContent = '';

  showLoading('Signing in...');
  try {
    await auth.signInWithEmailAndPassword(email, password);
  } catch (err) {
    console.error('Login error:', err.code, err.message, err);
    $('login-error').textContent = friendlyAuthError(err.code) + ' [' + (err.code || 'unknown') + ']';
  } finally {
    hideLoading();
  }
});

function friendlyAuthError(code) {
  const map = {
    'auth/user-not-found': 'No account found with that email.',
    'auth/wrong-password': 'Incorrect password.',
    'auth/invalid-email': 'Invalid email format.',
    'auth/too-many-requests': 'Too many attempts. Try again later.',
    'auth/invalid-credential': 'Invalid email or password.',
  };
  return map[code] || 'Login failed. Please try again.';
}

// Logout
$('btn-logout').addEventListener('click', () => auth.signOut());
$('btn-logout-vehicle').addEventListener('click', () => auth.signOut());
$('btn-admin-logout').addEventListener('click', () => auth.signOut());

// Task panel button
$('btn-tasks').addEventListener('click', () => openTaskPanel());
$('btn-tasks-vehicle').addEventListener('click', () => openTaskPanel());

// ================================================================
// FORGOT / RESET PASSWORD
// ================================================================

$('btn-forgot-password').addEventListener('click', () => {
  $('login-form').style.display = 'none';
  $('reset-form').style.display = 'block';
  $('reset-email').value = $('login-email').value;
  $('login-error').textContent = '';
});

$('btn-back-login').addEventListener('click', () => {
  $('reset-form').style.display = 'none';
  $('login-form').style.display = 'block';
  $('reset-msg').textContent = '';
});

$('reset-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('reset-email').value.trim();
  $('reset-msg').textContent = '';
  if (!email) return;

  try {
    await auth.sendPasswordResetEmail(email);
    $('reset-msg').style.color = 'var(--success)';
    $('reset-msg').textContent = 'Reset link sent! Check your email.';
  } catch (err) {
    $('reset-msg').style.color = 'var(--danger)';
    $('reset-msg').textContent = err.code === 'auth/user-not-found'
      ? 'No account found with that email.'
      : 'Failed to send reset email. Try again.';
  }
});

// ================================================================
// CHANGE PASSWORD (for logged-in users)
// ================================================================

$('btn-change-password').addEventListener('click', async () => {
  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay';
  overlay.innerHTML = `
    <div class="confirm-dialog" style="text-align:left;">
      <h4>Change Password</h4>
      <div class="form-group" style="margin-top:12px;">
        <label>Current Password</label>
        <input type="password" id="cp-current" class="form-select" placeholder="Current password">
      </div>
      <div class="form-group">
        <label>New Password</label>
        <input type="password" id="cp-new" class="form-select" placeholder="Min 6 characters" minlength="6">
      </div>
      <div class="form-group">
        <label>Confirm New Password</label>
        <input type="password" id="cp-confirm" class="form-select" placeholder="Re-enter new password">
      </div>
      <p id="cp-error" class="error-msg"></p>
      <div class="confirm-actions" style="margin-top:16px;">
        <button class="btn btn-secondary btn-cp-cancel">Cancel</button>
        <button class="btn btn-primary btn-cp-save">Update Password</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelector('.btn-cp-cancel').onclick = () => overlay.remove();
  overlay.querySelector('.btn-cp-save').onclick = async () => {
    const currentPw = overlay.querySelector('#cp-current').value;
    const newPw = overlay.querySelector('#cp-new').value;
    const confirmPw = overlay.querySelector('#cp-confirm').value;
    const errEl = overlay.querySelector('#cp-error');

    if (!currentPw || !newPw || !confirmPw) {
      errEl.textContent = 'Please fill all fields.';
      return;
    }
    if (newPw.length < 6) {
      errEl.textContent = 'New password must be at least 6 characters.';
      return;
    }
    if (newPw !== confirmPw) {
      errEl.textContent = 'New passwords do not match.';
      return;
    }

    try {
      // Re-authenticate first
      const credential = firebase.auth.EmailAuthProvider.credential(currentUser.email, currentPw);
      await currentUser.reauthenticateWithCredential(credential);
      await currentUser.updatePassword(newPw);
      overlay.remove();
      toast('Password updated!', 'success');
    } catch (err) {
      if (err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential') {
        errEl.textContent = 'Current password is incorrect.';
      } else {
        errEl.textContent = 'Failed to update password: ' + err.message;
      }
    }
  };
});

// ================================================================
// VEHICLES
// ================================================================

let vehiclesCache = [];

async function loadVehicles() {
  const snapshot = await db.collection('vehicles').orderBy('plate').get();
  vehiclesCache = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

  // Check latest photo timestamp + overdue maintenance for each vehicle
  const now = Date.now();
  const checks = vehiclesCache.map(async (v) => {
    // Last photo
    try {
      const photoSnap = await db.collection('photos')
        .where('vehicleId', '==', v.id)
        .orderBy('timestamp', 'desc')
        .limit(1)
        .get();
      if (photoSnap.empty) {
        v.lastPhotoAge = Infinity;
        v.lastPhotoDate = null;
      } else {
        const ts = photoSnap.docs[0].data().timestamp;
        if (ts) {
          v.lastPhotoDate = ts.toDate();
          v.lastPhotoAge = now - v.lastPhotoDate.getTime();
        } else {
          v.lastPhotoAge = Infinity;
          v.lastPhotoDate = null;
        }
      }
      // Check manual override — if more recent than last photo, use it
      if (v.lastPhotoOverrideAt) {
        const overrideTime = v.lastPhotoOverrideAt.toDate ? v.lastPhotoOverrideAt.toDate().getTime() : new Date(v.lastPhotoOverrideAt).getTime();
        if (v.lastPhotoAge === Infinity || overrideTime > (now - v.lastPhotoAge)) {
          v.lastPhotoAge = now - overrideTime;
          v.lastPhotoDate = new Date(overrideTime);
        }
      }
    } catch (e) {
      v.lastPhotoAge = null;
      v.lastPhotoDate = null;
    }

    // Maintenance status — only flag if mileage-based interval notes are overdue
    v.overdueCount = 0;
    // (Overdue checks happen per-vehicle on the maintenance tab — no default schedule)
  });
  await Promise.all(checks);

  // Auto-start scheduled trips whose start time has passed
  await autoStartScheduledTrips();

  // Populate admin dropdown
  populateVehicleSelect($('admin-vehicle-select'));
  // Update vehicle count badge
  const countEl = $('vehicle-count');
  if (countEl) countEl.textContent = vehiclesCache.length;

  // Render fleet dashboard
  renderFleetDashboard();
  // Clean up stale compliance tasks for vehicles that are now compliant (>30 days)
  // and refresh text on any remaining compliance tasks so "Due in Xd" is current
  autoCleanupResolvedComplianceNotes();
  refreshStaleComplianceNotes();
  loadDashboardFollowUps();
  loadGeneralNotes();
}

// Auto-flip "scheduled" vehicles to "on-trip" when their start time arrives
async function autoStartScheduledTrips() {
  const now = Date.now();
  const toFlip = vehiclesCache.filter(v => {
    if (v.tripStatus !== 'scheduled' || !v.tripScheduledStart) return false;
    const ss = v.tripScheduledStart.toDate ? v.tripScheduledStart.toDate() : new Date(v.tripScheduledStart);
    return ss.getTime() <= now;
  });
  if (!toFlip.length) return;
  await Promise.all(toFlip.map(v =>
    db.collection('vehicles').doc(v.id).update({
      tripStatus: 'on-trip',
      location: 'On Trip',
      tripScheduledStart: firebase.firestore.FieldValue.delete(),
      tripReturnDate: v.tripExpectedEnd || firebase.firestore.FieldValue.delete(),
      tripExpectedEnd: firebase.firestore.FieldValue.delete()
    }).then(() => {
      v.tripStatus = 'on-trip';
      v.location = 'On Trip';
      if (v.tripExpectedEnd) { v.tripReturnDate = v.tripExpectedEnd; }
      delete v.tripScheduledStart;
      delete v.tripExpectedEnd;
      toast(`🚗 ${v.plate} trip started automatically!`, 'info');
    }).catch(e => console.error('Auto-start trip error:', e))
  ));
  if (toFlip.length) renderFleetDashboard();
}

// Check every minute for trips that should auto-start
setInterval(async () => {
  if (!currentUser) return;
  const hasScheduled = vehiclesCache.some(v => v.tripStatus === 'scheduled' && v.tripScheduledStart);
  if (!hasScheduled) return;
  await autoStartScheduledTrips();
}, 60000);

function populateVehicleSelect(selectEl) {
  const MS_24H = 24 * 60 * 60 * 1000;
  selectEl.innerHTML = '<option value="">-- Choose a vehicle --</option>';
  vehiclesCache.forEach(v => {
    const opt = document.createElement('option');
    opt.value = v.id;
    const stale = v.lastPhotoAge != null && v.lastPhotoAge > MS_24H;
    const prefix = stale ? '⚠️ ' : '';
    opt.textContent = `${prefix}${v.plate} — ${v.make} ${v.model}`;
    if (stale) opt.style.color = '#b91c1c';
    selectEl.appendChild(opt);
  });
}

function renderFleetDashboard() {
  const container = $('fleet-dashboard');
  if (!container) return;
  if (vehiclesCache.length === 0) {
    container.innerHTML = '<p class="hint">No vehicles added yet.</p>';
    return;
  }

  const MS_24H = 24 * 60 * 60 * 1000;
  const MS_2H = 2 * 60 * 60 * 1000;
  let html = '';
  vehiclesCache.forEach(v => {
    // Determine if photo staleness should be suppressed
    const isOnTrip = v.tripStatus === 'on-trip' || v.tripStatus === 'private-trip';
    const isAtRepair = v.tripStatus === 'repair-shop';
    const stillCleaning = v.needsCleaning;
    let withinGrace = false;
    if (v.cleaningFlaggedAt) {
      const flagTime = v.cleaningFlaggedAt.toDate ? v.cleaningFlaggedAt.toDate().getTime() : new Date(v.cleaningFlaggedAt).getTime();
      withinGrace = (Date.now() - flagTime) < MS_2H;
    }
    const suppressPhoto = isOnTrip || isAtRepair || stillCleaning || withinGrace || !!v.photoExcluded;

    // Photo status
    let photoStatus, photoCls;
    if (suppressPhoto) {
      if (v.photoExcluded) {
        photoStatus = '🚫 Excluded';
        photoCls = 'status-muted';
      } else if (v.tripStatus === 'private-trip') {
        photoStatus = '📷 Private trip';
        photoCls = 'status-muted';
      } else if (isOnTrip) {
        photoStatus = '📷 On trip';
        photoCls = 'status-muted';
      } else if (isAtRepair) {
        photoStatus = '📷 At shop';
        photoCls = 'status-muted';
      } else {
        photoStatus = '📷 Awaiting cleaning';
        photoCls = 'status-muted';
      }
    } else if (v.lastPhotoAge === Infinity || v.lastPhotoAge == null) {
      photoStatus = '📷 No photos';
      photoCls = 'status-danger';
    } else if (v.lastPhotoAge > MS_24H) {
      const hrs = Math.floor(v.lastPhotoAge / (1000 * 60 * 60));
      const days = Math.floor(hrs / 24);
      photoStatus = `📷 ${days}d ${hrs % 24}h ago`;
      photoCls = 'status-warn';
    } else {
      const hrs = Math.floor(v.lastPhotoAge / (1000 * 60 * 60));
      const mins = Math.floor((v.lastPhotoAge / (1000 * 60)) % 60);
      photoStatus = hrs > 0 ? `📷 ${hrs}h ${mins}m ago` : `📷 ${mins}m ago`;
      photoCls = 'status-ok';
    }

    // Maintenance status
    let maintStatus, maintCls;
    if (!v.mileage) {
      maintStatus = '🔧 No mileage set';
      maintCls = 'status-muted';
    } else if (v.overdueCount > 0) {
      maintStatus = `🔧 ${v.overdueCount} overdue`;
      maintCls = 'status-danger';
    } else {
      maintStatus = '🔧 Up to date';
      maintCls = 'status-ok';
    }

    const needsPhotos = photoCls !== 'status-ok';
    // Location/status display
    let locDisplay, locCls;
    if (v.tripStatus === 'on-trip') {
      let returnInfo = '';
      if (v.tripReturnDate) {
        const rd = v.tripReturnDate.toDate ? v.tripReturnDate.toDate() : new Date(v.tripReturnDate);
        returnInfo = ' · Return ' + rd.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: APP_TIMEZONE });
      }
      locDisplay = `🚗 On Trip${returnInfo}`;
      locCls = 'status-warn';
    } else if (v.tripStatus === 'repair-shop') {
      locDisplay = '🔧 Repair Shop';
      locCls = 'status-danger';
    } else if (v.tripStatus === 'private-trip') {
      const ptName = v.privateTripCustomerName ? ` — ${escapeHtml(v.privateTripCustomerName)}` : '';
      locDisplay = `🔒 Private Trip${ptName}`;
      locCls = 'status-warn';
    } else if (v.tripStatus === 'scheduled') {
      const ss = v.tripScheduledStart ? (v.tripScheduledStart.toDate ? v.tripScheduledStart.toDate() : new Date(v.tripScheduledStart)) : null;
      const ssStr = ss ? ss.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: APP_TIMEZONE }) : '';
      locDisplay = `⏰ Scheduled${ssStr ? ' · ' + ssStr : ''}`;
      locCls = 'status-muted';
    } else if (v.homeLocation) {
      locDisplay = `🏠 ${escapeHtml(v.homeLocation)}`;
      locCls = 'status-ok';
    } else {
      locDisplay = 'No location set';
      locCls = 'status-muted';
    }
    // Compliance badge
    const compFields = [v.complianceSafety, v.complianceRegistration, v.complianceInsurance];
    const compExpired = compFields.some(f => { if (!f) return false; const [y,m] = f.split('-').map(Number); return new Date(Date.UTC(y,m,0,23,59,59)) < Date.now(); });
    const compDue = !compExpired && compFields.some(f => { if (!f) return false; const [y,m] = f.split('-').map(Number); return (new Date(Date.UTC(y,m,0,23,59,59)) - Date.now()) / 86400000 <= 30; });
    const compBadge = compExpired ? '<span class="compliance-badge">EXPIRED</span>' : compDue ? '<span class="compliance-badge" style="background:#d97706;">DUE</span>' : '';
    const cleaningFlag = v.needsCleaning ? '<span class="fleet-cleaning-flag">🧹</span>' : '';
    html += `<div class="fleet-card${needsPhotos ? ' fleet-card-alert' : ''}" data-vid="${v.id}">
      ${needsPhotos ? '<span class="fleet-card-badge">⚠️</span>' : ''}
      ${compBadge}
      ${cleaningFlag}
      <div class="fleet-card-title">${escapeHtml(v.plate)}</div>
      <div class="fleet-card-subtitle">${escapeHtml(v.make)} ${escapeHtml(v.model)}</div>
      <div class="fleet-card-status ${locCls}">${locDisplay}</div>
      <div class="fleet-card-status ${photoCls}">${photoStatus}</div>
      <div class="fleet-card-status ${maintCls}">${maintStatus}</div>
    </div>`;
  });
  container.innerHTML = html;

  // Populate jump dropdown
  const jumpSelect = $('fleet-jump-select');
  if (jumpSelect) {
    jumpSelect.innerHTML = '<option value="">— Select vehicle —</option>';
    vehiclesCache.forEach(v => {
      const opt = document.createElement('option');
      opt.value = v.id;
      opt.textContent = `${v.plate} — ${v.make} ${v.model}`;
      jumpSelect.appendChild(opt);
    });
    jumpSelect.onchange = function() {
      const vid = this.value;
      if (!vid) return;
      const card = container.querySelector(`.fleet-card[data-vid="${vid}"]`);
      if (!card) return;
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.classList.add('fleet-card-highlight');
      setTimeout(() => card.classList.remove('fleet-card-highlight'), 1800);
      this.value = '';
    };
  }

  // Click a card to navigate to vehicle detail page (touchend for instant iOS response)
  container.querySelectorAll('.fleet-card').forEach(card => {
    let touchMoved = false;
    card.addEventListener('touchstart', () => { touchMoved = false; }, { passive: true });
    card.addEventListener('touchmove', () => { touchMoved = true; }, { passive: true });
    card.addEventListener('touchend', (e) => {
      if (touchMoved) return;
      e.preventDefault();
      openVehiclePage(card.dataset.vid);
    });
    card.addEventListener('click', () => {
      openVehiclePage(card.dataset.vid);
    });
  });

  // Render Locations widget
  renderLocationsWidget();
  // Compliance widget removed from dashboard — accessible via top-bar ✅ button
  // loadFleetComplianceWidget();
}

function renderLocationsWidget() {
  const container = $('locations-grid');
  if (!container) return;
  if (vehiclesCache.length === 0) {
    container.innerHTML = '<p class="hint">No vehicles to display.</p>';
    return;
  }

  const MS_24H = 24 * 60 * 60 * 1000;
  const MS_2H = 2 * 60 * 60 * 1000;
  const now = Date.now();

  // Split on-trip into overdue (show under home location) vs. active (On the Road)
  function getReturnTime(v) {
    return v.tripReturnDate ? (v.tripReturnDate.toDate ? v.tripReturnDate.toDate().getTime() : new Date(v.tripReturnDate).getTime()) : null;
  }
  function isOverdue(v) {
    const rt = getReturnTime(v);
    return rt !== null && rt < now;
  }
  const onTripAll = vehiclesCache.filter(v => v.tripStatus === 'on-trip' || v.tripStatus === 'private-trip');
  const onTrip = onTripAll.filter(v => !isOverdue(v));
  const overdueTrip = onTripAll.filter(v => isOverdue(v));
  const atRepairAll = vehiclesCache.filter(v => v.tripStatus === 'repair-shop');
  const atRepair = atRepairAll.filter(v => !isOverdue(v));
  const overdueRepair = atRepairAll.filter(v => isOverdue(v));

  function isAtHome(v) {
    // photoExcluded only suppresses photo/cleaning prompts — vehicle is still treated as at-home for all other ops
    return v.tripStatus !== 'on-trip' && v.tripStatus !== 'private-trip' && v.tripStatus !== 'repair-shop';
  }
  function needsPhotosCheck(v) {
    if (v.photoExcluded) return false;
    const isOnTrip = v.tripStatus === 'on-trip' || v.tripStatus === 'private-trip';
    const isAtRepair = v.tripStatus === 'repair-shop';
    let withinGrace = false;
    if (v.cleaningFlaggedAt) {
      const flagTime = v.cleaningFlaggedAt.toDate ? v.cleaningFlaggedAt.toDate().getTime() : new Date(v.cleaningFlaggedAt).getTime();
      withinGrace = (Date.now() - flagTime) < MS_2H;
    }
    if (isOnTrip || isAtRepair || withinGrace) return false;
    return v.lastPhotoAge != null && v.lastPhotoAge > MS_24H;
  }

  const sortByReturn = (arr) => arr.sort((a, b) => {
    const aT = a.tripReturnDate ? (a.tripReturnDate.toDate ? a.tripReturnDate.toDate().getTime() : new Date(a.tripReturnDate).getTime()) : Infinity;
    const bT = b.tripReturnDate ? (b.tripReturnDate.toDate ? b.tripReturnDate.toDate().getTime() : new Date(b.tripReturnDate).getTime()) : Infinity;
    return aT - bT;
  });
  sortByReturn(onTrip);
  sortByReturn(atRepair);

  const knownLocations = ['HNL', '1585 Kapiolani', '94-530 Lumiauau'];
  const allHomeVehicles = [...vehiclesCache.filter(v => isAtHome(v)), ...overdueTrip, ...overdueRepair];
  const otherLocations = [...new Set(allHomeVehicles.filter(v => v.homeLocation && !knownLocations.includes(v.homeLocation)).map(v => v.homeLocation))];
  const allLocations = [...knownLocations, ...otherLocations];

  let html = '';

  // ── Per-location combined sections ──────────────────────────────
  for (const loc of allLocations) {
    const cleaning = vehiclesCache.filter(v => isAtHome(v) && v.needsCleaning && !v.photoExcluded && v.homeLocation === loc);
    const photosOnly = vehiclesCache.filter(v => isAtHome(v) && !v.needsCleaning && needsPhotosCheck(v) && v.homeLocation === loc);
    const atHomeClean = vehiclesCache.filter(v => isAtHome(v) && !v.needsCleaning && !needsPhotosCheck(v) && v.homeLocation === loc);
    const overdueHere = [...overdueTrip, ...overdueRepair].filter(v => (v.homeLocation || '') === loc);
    const total = cleaning.length + photosOnly.length + atHomeClean.length + overdueHere.length;
    if (total === 0) continue;

    const isKapiolani = loc === '1585 Kapiolani';

    html += `<div class="location-group location-group-combined">
      <div class="location-group-header">
        <span class="location-group-name">🏠 ${escapeHtml(loc)}</span>
        <span class="location-group-count">${total}</span>
      </div>`;

    // Overdue / awaiting return sub-section
    if (overdueHere.length > 0) {
      html += `<div class="loc-sub-header loc-sub-overdue">⏰ Awaiting Return <span class="loc-sub-count">${overdueHere.length}</span></div>
        <div class="location-group-vehicles trip-list">`;
      for (const v of overdueHere) {
        const rd = v.tripReturnDate ? (v.tripReturnDate.toDate ? v.tripReturnDate.toDate() : new Date(v.tripReturnDate)) : null;
        const returnLabel = rd ? `<span class="trip-return-label trip-overdue">↩ ${rd.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: APP_TIMEZONE })} OVERDUE</span>` : '';
        const returnBtn = `<button class="btn btn-sm btn-returned" onclick="event.stopPropagation(); vehicleReturned('${v.id}')">🏠 Returned</button>`;
        html += `<div class="trip-item">
          <span class="location-vehicle-chip" data-vid="${v.id}">${escapeHtml(v.plate)}</span>
          <span class="trip-meta">${escapeHtml(v.make)} ${escapeHtml(v.model)}</span>
          ${returnLabel}
          ${returnBtn}
        </div>`;
      }
      html += '</div>';
    }

    // Needs Cleaning sub-section
    if (cleaning.length > 0) {
      html += `<div class="loc-sub-header loc-sub-cleaning">🧹 Needs Cleaning <span class="loc-sub-count">${cleaning.length}</span></div>
        <div class="location-group-vehicles cleaning-list">`;
      for (const v of cleaning) {
        const needsDamage = v.needsDamageCheck;
        const alsoNeedsPhotos = needsPhotosCheck(v);
        let photoTag = '';
        if (alsoNeedsPhotos) {
          let ageText = '';
          if (v.lastPhotoAge === Infinity) { ageText = 'No photos yet'; }
          else { const hrs = Math.floor(v.lastPhotoAge / (1000 * 60 * 60)); const days = Math.floor(hrs / 24); ageText = days > 0 ? `${days}d ${hrs % 24}h ago` : `${hrs}h ago`; }
          photoTag = `<span class="photo-age-tag">${ageText}</span>`;
        }
        const parkingBtn = (isKapiolani && v.needsParking)
          ? `<button class="btn btn-sm btn-parking parking-done-btn" data-vid="${v.id}">🅿️ Paid</button>` : '';
        html += `<div class="cleaning-item" data-vid="${v.id}">
          <div class="cleaning-vehicle-info">
            <span class="location-vehicle-chip" data-vid="${v.id}">${escapeHtml(v.plate)}</span>
            <span class="cleaning-meta">${escapeHtml(v.make)} ${escapeHtml(v.model)}</span>
            ${photoTag}
          </div>
          <div class="cleaning-actions">
            ${needsDamage ? `<button class="btn btn-sm btn-outline damage-check-btn" data-vid="${v.id}">🔍 Inspect</button>` : '<span class="damage-ok-badge">✅ Inspected</span>'}
            <button class="btn btn-sm btn-primary cleaning-done-btn" data-vid="${v.id}" ${needsDamage ? 'disabled title="Complete inspection first"' : ''}>✓ Cleaned</button>
            ${alsoNeedsPhotos ? `<button class="btn btn-sm btn-outline photo-done-btn" data-vid="${v.id}">📷</button>` : ''}
            ${parkingBtn}
          </div>
        </div>`;
      }
      html += '</div>';
    }

    // Needs Photos sub-section
    if (photosOnly.length > 0) {
      html += `<div class="loc-sub-header loc-sub-photos">📷 Needs Photos <span class="loc-sub-count">${photosOnly.length}</span></div>
        <div class="location-group-vehicles cleaning-list">`;
      for (const v of photosOnly) {
        let ageText = '';
        if (v.lastPhotoAge === Infinity) { ageText = 'No photos yet'; }
        else { const hrs = Math.floor(v.lastPhotoAge / (1000 * 60 * 60)); const days = Math.floor(hrs / 24); ageText = days > 0 ? `${days}d ${hrs % 24}h ago` : `${hrs}h ago`; }
        html += `<div class="cleaning-item" data-vid="${v.id}">
          <div class="cleaning-vehicle-info">
            <span class="location-vehicle-chip" data-vid="${v.id}">${escapeHtml(v.plate)}</span>
            <span class="cleaning-meta">${escapeHtml(v.make)} ${escapeHtml(v.model)}</span>
            <span class="photo-age-tag">${ageText}</span>
          </div>
          <button class="btn btn-sm btn-primary photo-done-btn" data-vid="${v.id}">📷 Done</button>
        </div>`;
      }
      html += '</div>';
    }

    // Ready chips sub-section
    if (atHomeClean.length > 0) {
      html += `<div class="loc-sub-header loc-sub-home">✅ Ready <span class="loc-sub-count">${atHomeClean.length}</span></div>
        <div class="location-group-vehicles">`;
      for (const v of atHomeClean) {
        const parkBadge = (isKapiolani && v.needsParking) ? '<span class="parking-badge">🅿️</span>' : '';
        html += `<div class="location-vehicle-chip-wrap"><div class="location-vehicle-chip" data-vid="${v.id}">${escapeHtml(v.plate)}</div>${parkBadge}</div>`;
      }
      html += '</div>';
    }

    html += '</div>'; // end location-group-combined
  }

  // No location set
  const noLocation = vehiclesCache.filter(v => isAtHome(v) && !v.homeLocation);
  if (noLocation.length > 0) {
    const needsCleaningNoLoc = noLocation.filter(v => v.needsCleaning && !v.photoExcluded);
    const cleanNoLoc = noLocation.filter(v => !v.needsCleaning && !needsPhotosCheck(v));
    html += `<div class="location-group">
      <div class="location-group-header" style="background:#6b7280;">
        <span class="location-group-name">❓ No Location Set</span>
        <span class="location-group-count">${noLocation.length}</span>
      </div>`;
    if (needsCleaningNoLoc.length > 0) {
      html += `<div class="loc-sub-header loc-sub-cleaning">🧹 Needs Cleaning <span class="loc-sub-count">${needsCleaningNoLoc.length}</span></div><div class="location-group-vehicles cleaning-list">`;
      for (const v of needsCleaningNoLoc) {
        const needsDamage = v.needsDamageCheck;
        html += `<div class="cleaning-item" data-vid="${v.id}">
          <div class="cleaning-vehicle-info"><span class="location-vehicle-chip" data-vid="${v.id}">${escapeHtml(v.plate)}</span><span class="cleaning-meta">${escapeHtml(v.make)} ${escapeHtml(v.model)}</span></div>
          <div class="cleaning-actions">
            ${needsDamage ? `<button class="btn btn-sm btn-outline damage-check-btn" data-vid="${v.id}">🔍 Inspect</button>` : '<span class="damage-ok-badge">✅ Inspected</span>'}
            <button class="btn btn-sm btn-primary cleaning-done-btn" data-vid="${v.id}" ${needsDamage ? 'disabled' : ''}>✓ Cleaned</button>
          </div>
        </div>`;
      }
      html += '</div>';
    }
    if (cleanNoLoc.length > 0) {
      html += `<div class="location-group-vehicles">`;
      for (const v of cleanNoLoc) html += `<div class="location-vehicle-chip" data-vid="${v.id}">${escapeHtml(v.plate)}</div>`;
      html += '</div>';
    }
    html += '</div>';
  }

  // On the Road (non-overdue only)
  if (onTrip.length > 0) {
    html += `<div class="location-group">
      <div class="location-group-header" style="background:#2563eb;">
        <span class="location-group-name">🚗 On the Road</span>
        <span class="location-group-count">${onTrip.length}</span>
      </div>
      <div class="location-group-vehicles trip-list">`;
    for (const v of onTrip) {
      let returnLabel = '';
      if (v.tripReturnDate) {
        const rd = v.tripReturnDate.toDate ? v.tripReturnDate.toDate() : new Date(v.tripReturnDate);
        returnLabel = `<span class="trip-return-label">↩ ${rd.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: APP_TIMEZONE })}</span>`;
      }
      html += `<div class="trip-item">
        <span class="location-vehicle-chip" data-vid="${v.id}">${escapeHtml(v.plate)}</span>
        <span class="trip-meta">${escapeHtml(v.make)} ${escapeHtml(v.model)}</span>
        ${returnLabel}
      </div>`;
    }
    html += '</div></div>';
  }

  // Repair Shop (non-overdue only)
  if (atRepair.length > 0) {
    html += `<div class="location-group">
      <div class="location-group-header" style="background:#dc2626;">
        <span class="location-group-name">🔧 Repair Shop</span>
        <span class="location-group-count">${atRepair.length}</span>
      </div>
      <div class="location-group-vehicles trip-list">`;
    for (const v of atRepair) {
      let returnLabel = '';
      if (v.tripReturnDate) {
        const rd = v.tripReturnDate.toDate ? v.tripReturnDate.toDate() : new Date(v.tripReturnDate);
        returnLabel = `<span class="trip-return-label">↩ ${rd.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: APP_TIMEZONE })}</span>`;
      }
      let partsInfo = '';
      if (v.repairShopName) partsInfo += `<span class="repair-parts-tag">🏥 ${escapeHtml(v.repairShopName)}</span>`;
      if (v.repairOrderNumber) partsInfo += `<span class="repair-parts-tag">📦 ${escapeHtml(v.repairOrderNumber)}</span>`;
      if (v.repairPartsEta) partsInfo += `<span class="repair-parts-tag">📅 Parts ETA: ${v.repairPartsEta}</span>`;
      html += `<div class="trip-item">
        <span class="location-vehicle-chip" data-vid="${v.id}">${escapeHtml(v.plate)}</span>
        <span class="trip-meta">${escapeHtml(v.make)} ${escapeHtml(v.model)}</span>
        ${returnLabel}
        ${partsInfo}
      </div>`;
    }
    html += '</div></div>';
  }

  // Overdue with no home location
  const overdueNoLoc = [...overdueTrip, ...overdueRepair].filter(v => !v.homeLocation);
  if (overdueNoLoc.length > 0) {
    html += `<div class="location-group">
      <div class="location-group-header" style="background:#6b7280;">
        <span class="location-group-name">⏰ Overdue — No Location Set</span>
        <span class="location-group-count">${overdueNoLoc.length}</span>
      </div>
      <div class="location-group-vehicles trip-list">`;
    for (const v of overdueNoLoc) {
      const rd = v.tripReturnDate ? (v.tripReturnDate.toDate ? v.tripReturnDate.toDate() : new Date(v.tripReturnDate)) : null;
      const returnLabel = rd ? `<span class="trip-return-label trip-overdue">↩ ${rd.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: APP_TIMEZONE })} OVERDUE</span>` : '';
      html += `<div class="trip-item">
        <span class="location-vehicle-chip" data-vid="${v.id}">${escapeHtml(v.plate)}</span>
        <span class="trip-meta">${escapeHtml(v.make)} ${escapeHtml(v.model)}</span>
        ${returnLabel}
        <button class="btn btn-sm btn-returned" onclick="event.stopPropagation(); vehicleReturned('${v.id}')">🏠 Returned</button>
      </div>`;
    }
    html += '</div></div>';
  }

  if (!html) html = '<p class="hint">No vehicles to display.</p>';
  container.innerHTML = html;

  // Click chip to open vehicle
  container.querySelectorAll('.location-vehicle-chip').forEach(chip => {
    let chipTouchMoved = false;
    chip.addEventListener('touchstart', () => { chipTouchMoved = false; }, { passive: true });
    chip.addEventListener('touchmove', () => { chipTouchMoved = true; }, { passive: true });
    chip.addEventListener('touchend', (e) => {
      if (chipTouchMoved) return;
      e.preventDefault();
      openVehiclePage(chip.dataset.vid);
    });
    chip.addEventListener('click', () => openVehiclePage(chip.dataset.vid));
  });

  // Damage inspection button handler
  container.querySelectorAll('.damage-check-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const vid = btn.dataset.vid;
      const v = vehiclesCache.find(x => x.id === vid);
      showDamageCheckModal(vid, v ? v.plate : 'Vehicle');
    });
  });

  // Cleaned button handler
  container.querySelectorAll('.cleaning-done-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (btn.disabled) return;
      const vid = btn.dataset.vid;
      try {
        await db.collection('vehicles').doc(vid).update({
          needsCleaning: false,
          needsDamageCheck: false,
          lastCleanedAt: firebase.firestore.FieldValue.serverTimestamp(),
          lastCleanedBy: currentUser.displayName || currentUser.email
        });
        const cached = vehiclesCache.find(v => v.id === vid);
        if (cached) {
          cached.needsCleaning = false;
          cached.needsDamageCheck = false;
        }
        toast('Marked as cleaned! ✓', 'success');
        renderLocationsWidget();
      } catch (err) {
        console.error('Mark cleaned error:', err);
        toast('Failed to update.', 'error');
      }
    });
  });

  // Photo done button handler
  container.querySelectorAll('.photo-done-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openVehiclePage(btn.dataset.vid);
    });
  });

  // Parking paid button handler
  container.querySelectorAll('.parking-done-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const vid = btn.dataset.vid;
      try {
        await db.collection('vehicles').doc(vid).update({ needsParking: false });
        const cached = vehiclesCache.find(v => v.id === vid);
        if (cached) cached.needsParking = false;
        toast('Parking marked as paid! 🅿️✓', 'success');
        renderLocationsWidget();
      } catch (err) {
        console.error('Mark parking error:', err);
        toast('Failed to update.', 'error');
      }
    });
  });

  // Collapsible group headers
  container.querySelectorAll('.location-group-header').forEach(header => {
    header.addEventListener('click', (e) => {
      if (e.target.closest('.location-vehicle-chip, button')) return;
      const group = header.closest('.location-group, .location-group-combined');
      if (group) group.classList.toggle('loc-collapsed');
    });
  });
}
// Damage check modal � Pass / Fail per item
function showDamageCheckModal(vid, plate) {
  const existing = document.querySelector('.damage-check-overlay');
  if (existing) existing.remove();

  // Per-item state: 'none' | 'pass' | 'fail'
  const itemState = {};
  INSPECTION_ITEMS.forEach(i => { itemState[i.key] = 'none'; });
  const failFiles = {}; // key -> File[]
  const bugUrgency = {}; // yesno key -> 'urgent' | 'monitoring' | null
  INSPECTION_ITEMS.forEach(i => { if (i.yesno) bugUrgency[i.key] = null; });

  const overlay = document.createElement('div');
  overlay.className = 'damage-check-overlay';

  function buildItemHTML(item) {
    // Yes/No style (no fail notes needed)
    if (item.yesno) {
      return `
      <div class="dmg-item" id="dmg-item-${item.key}">
        <div class="dmg-item-header">
          <span class="dmg-item-label">${escapeHtml(item.label)}</span>
          <div class="dmg-pf-btns">
            <button class="dmg-pass-btn" data-check="${item.key}" style="background:#fef9c3;border-color:#ca8a04;color:#92400e;">Yes 🐞</button>
            <button class="dmg-fail-btn" data-check="${item.key}" style="background:#f0fdf4;border-color:#16a34a;color:#15803d;">No ✅</button>
          </div>
        </div>
        <div class="dmg-bug-urgency" id="dmg-bug-urgency-${item.key}" style="display:none;">
          <p class="dmg-bug-urgency-label">🐞 How should this be handled?</p>
          <div class="dmg-bug-urgency-btns">
            <button class="dmg-bug-now-btn" data-check="${item.key}">🚨 Address Now</button>
            <button class="dmg-bug-later-btn" data-check="${item.key}">👁️ Follow Up</button>
          </div>
        </div>
      </div>`;
    }
    return `
      <div class="dmg-item" id="dmg-item-${item.key}">
        <div class="dmg-item-header">
          <span class="dmg-item-label">${escapeHtml(item.label)}</span>
          <div class="dmg-pf-btns">
            <button class="dmg-pass-btn" data-check="${item.key}">Pass</button>
            <button class="dmg-fail-btn" data-check="${item.key}">Fail</button>
          </div>
        </div>
        <div class="dmg-fail-details" id="dmg-fail-${item.key}" style="display:none;">
          <textarea class="dmg-fail-notes" id="dmg-notes-${item.key}" placeholder="Describe the issue..." rows="2"></textarea>
          <div class="dmg-fail-upload-row">
            <label class="dmg-fail-upload-label">
              📁 Upload / Photos
              <input type="file" class="dmg-fail-photos" id="dmg-photos-${item.key}" accept="image/*" multiple style="display:none;" data-check="${item.key}">
            </label>
            <label class="dmg-fail-upload-label dmg-fail-camera-label">
              📷 Camera
              <input type="file" class="dmg-fail-photos" id="dmg-camera-${item.key}" accept="image/*" capture="environment" style="display:none;" data-check="${item.key}">
            </label>
          </div>
          <div class="dmg-fail-photo-previews" id="dmg-previews-${item.key}"></div>
        </div>
      </div>`;
  }

  overlay.innerHTML = `
    <div class="damage-check-modal dmg-modal-pf">
      <div class="dmg-modal-header">
        <h4>Vehicle Inspection - ${escapeHtml(plate)}</h4>
        <p>Mark each item Pass or Fail. Issues will be logged as urgent follow-ups.</p>
      </div>
      <div class="damage-checklist dmg-pf-list">
        ${INSPECTION_ITEMS.map(buildItemHTML).join('')}
      </div>
      <div class="dmg-all-pass-row">
        <button class="btn btn-primary dmg-all-pass-btn">✅ All Pass — No Issues</button>
      </div>
      <div class="damage-check-actions">
        <button class="btn btn-sm btn-outline dmg-cancel-btn">Cancel</button>
        <button class="btn btn-sm btn-primary dmg-confirm-btn" disabled>Submit Inspection</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const confirmBtn = overlay.querySelector('.dmg-confirm-btn');

  function refreshConfirmBtn() {
    const allDecided = INSPECTION_ITEMS.every(i => {
      if (itemState[i.key] === 'none') return false;
      if (i.yesno && itemState[i.key] === 'pass') return bugUrgency[i.key] !== null;
      return true;
    });
    confirmBtn.disabled = !allDecided;
    const failCount = INSPECTION_ITEMS.filter(i => !i.yesno && itemState[i.key] === 'fail').length;
    const bugsYes = INSPECTION_ITEMS.filter(i => i.yesno).some(i => itemState[i.key] === 'pass');
    const bugsNow = bugsYes && INSPECTION_ITEMS.filter(i => i.yesno).some(i => bugUrgency[i.key] === 'urgent');
    const extras = bugsNow ? ' +🚨 bugs' : (bugsYes && bugUrgency[INSPECTION_ITEMS.find(i=>i.yesno)?.key] === 'monitoring' ? ' +👁️ bugs' : '');
    confirmBtn.textContent = failCount > 0
      ? `Submit (${failCount} issue${failCount > 1 ? 's' : ''}${extras})`
      : (bugsYes ? `Submit — Bugs Noted${extras}` : 'Submit — All Clear');
  }

  overlay.querySelectorAll('.dmg-pass-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.check;
      itemState[key] = 'pass';
      const itemEl = overlay.querySelector('#dmg-item-' + key);
      itemEl.classList.remove('dmg-state-fail');
      itemEl.classList.add('dmg-state-pass');
      const failEl = overlay.querySelector('#dmg-fail-' + key);
      if (failEl) failEl.style.display = 'none';
      const bugUrgencyEl = overlay.querySelector('#dmg-bug-urgency-' + key);
      if (bugUrgencyEl) {
        bugUrgencyEl.style.display = '';
        bugUrgency[key] = null; // reset choice
        // Reset active state on both urgency buttons
        overlay.querySelectorAll(`.dmg-bug-now-btn[data-check="${key}"], .dmg-bug-later-btn[data-check="${key}"]`).forEach(b => b.classList.remove('dmg-bug-active'));
      }
      refreshConfirmBtn();
    });
  });

  overlay.querySelectorAll('.dmg-fail-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.check;
      itemState[key] = 'fail';
      const itemEl = overlay.querySelector('#dmg-item-' + key);
      itemEl.classList.remove('dmg-state-pass');
      itemEl.classList.add('dmg-state-fail');
      // For yesno items ("No" = bug-free): hide urgency panel and reset
      const bugUrgencyEl = overlay.querySelector('#dmg-bug-urgency-' + key);
      if (bugUrgencyEl) {
        bugUrgencyEl.style.display = 'none';
        bugUrgency[key] = null;
        overlay.querySelectorAll(`.dmg-bug-now-btn[data-check="${key}"], .dmg-bug-later-btn[data-check="${key}"]`).forEach(b => b.classList.remove('dmg-bug-active'));
      }
      // For regular fail items: show notes panel
      const failEl = overlay.querySelector('#dmg-fail-' + key);
      if (failEl) {
        failEl.style.display = '';
        const notesEl = overlay.querySelector('#dmg-notes-' + key);
        if (notesEl) notesEl.focus();
      }
      refreshConfirmBtn();
    });
  });

  overlay.querySelectorAll('.dmg-fail-notes').forEach(ta => {
    ta.addEventListener('input', refreshConfirmBtn);
  });

  overlay.querySelectorAll('.dmg-fail-photos').forEach(input => {
    input.addEventListener('change', () => {
      const key = input.dataset.check;
      const files = Array.from(input.files);
      if (!failFiles[key]) failFiles[key] = [];
      failFiles[key].push(...files);
      const previewEl = overlay.querySelector('#dmg-previews-' + key);
      files.forEach(f => {
        const img = document.createElement('img');
        img.src = URL.createObjectURL(f);
        img.className = 'dmg-fail-preview-img';
        previewEl.appendChild(img);
      });
      input.value = '';
    });
  });

  overlay.querySelectorAll('.dmg-bug-now-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.check;
      bugUrgency[key] = 'urgent';
      btn.classList.add('dmg-bug-active');
      const laterBtn = overlay.querySelector(`.dmg-bug-later-btn[data-check="${key}"]`);
      if (laterBtn) laterBtn.classList.remove('dmg-bug-active');
      refreshConfirmBtn();
    });
  });

  overlay.querySelectorAll('.dmg-bug-later-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.check;
      bugUrgency[key] = 'monitoring';
      btn.classList.add('dmg-bug-active');
      const nowBtn = overlay.querySelector(`.dmg-bug-now-btn[data-check="${key}"]`);
      if (nowBtn) nowBtn.classList.remove('dmg-bug-active');
      refreshConfirmBtn();
    });
  });

  overlay.querySelector('.dmg-cancel-btn').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  // All Pass — set every item to pass/no-bugs in one click
  overlay.querySelector('.dmg-all-pass-btn').addEventListener('click', () => {
    INSPECTION_ITEMS.forEach(item => {
      if (item.yesno) {
        // "No" = no bugs = the fail button for yesno items
        itemState[item.key] = 'fail';
        const itemEl = overlay.querySelector('#dmg-item-' + item.key);
        if (itemEl) { itemEl.classList.remove('dmg-state-pass'); itemEl.classList.add('dmg-state-fail'); }
        const bugUrgencyEl = overlay.querySelector('#dmg-bug-urgency-' + item.key);
        if (bugUrgencyEl) bugUrgencyEl.style.display = 'none';
        bugUrgency[item.key] = null;
      } else {
        itemState[item.key] = 'pass';
        const itemEl = overlay.querySelector('#dmg-item-' + item.key);
        if (itemEl) { itemEl.classList.remove('dmg-state-fail'); itemEl.classList.add('dmg-state-pass'); }
        const failEl = overlay.querySelector('#dmg-fail-' + item.key);
        if (failEl) failEl.style.display = 'none';
      }
    });
    refreshConfirmBtn();
  });

  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Submitting...';
    const failItems = INSPECTION_ITEMS.filter(i => {
      if (i.yesno) return itemState[i.key] === 'pass'; // 'pass' = yes bugs spotted
      return itemState[i.key] === 'fail';
    });
    const st = getStorage();
    const vehicleObj = vehiclesCache.find(v => v.id === vid);
    const safePlate = vehicleObj ? sanitizePlate(vehicleObj.plate) : 'unknown';

    try {
      let newIncCount = 0, reusedCount = 0, newTaskCount = 0;

      for (const item of failItems) {
        // ── Bugs-spotted: monitoring/urgent vehicleNotes task, no incident ──
        if (item.yesno) {
          const isNow = bugUrgency[item.key] === 'urgent';
          await db.collection('vehicleNotes').add({
            vehicleId: vid,
            text: 'Bugs spotted during inspection — treatment needed.',
            isFollowUp: true, done: false,
            urgent: isNow,
            taskStatus: isNow ? 'urgent' : 'monitoring',
            sourceType: 'inspection', inspectionKey: item.key,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            createdBy: currentUser.uid,
            createdByName: currentUser.displayName || currentUser.email,
          });
          continue;
        }

        const notes = (overlay.querySelector('#dmg-notes-' + item.key) || {}).value.trim() || '';
        const photoFiles = failFiles[item.key] || [];
        const photoUrls = [];

        if (st && photoFiles.length > 0) {
          for (const file of photoFiles) {
            try {
              const compressed = await compressImage(file);
              const fileName = 'insp_' + item.key + '_' + Date.now() + '_' + Math.random().toString(36).slice(2,6) + '.jpg';
              const ref = st.ref('vehicles/' + safePlate + '/inspection/' + fileName);
              await ref.put(compressed, { contentType: 'image/jpeg' });
              photoUrls.push(await ref.getDownloadURL());
            } catch(e) { console.error('Inspection photo upload error:', e); }
          }
        }

        if (item.incidentType) {
          // ── CLOSED-LOOP: create incident + Turo task (with deduplication) ──
          const vehicleObj2 = vehiclesCache.find(v => v.id === vid);
          const plate = vehicleObj2 ? (vehicleObj2.plate || '') : '';

          // Check for an already-open incident for this exact inspection item on this vehicle
          const existSnap = await db.collection('incidents')
            .where('vehicleId', '==', vid)
            .where('inspectionKey', '==', item.key)
            .where('status', 'in', ['open', 'in-progress'])
            .get();

          if (!existSnap.empty) {
            // Re-flag existing incident — no duplicate
            const existRef = existSnap.docs[0].ref;
            const updatePayload = {
              urgent: true,
              updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
            };
            if (notes) updatePayload.lastInspectionNote = notes;
            if (photoUrls.length) updatePayload.photoUrls = firebase.firestore.FieldValue.arrayUnion(...photoUrls);
            await existRef.update(updatePayload);
            reusedCount++;
          } else {
            // Create fresh incident
            const isTuro = TURO_ELIGIBLE_INCIDENT_TYPES.includes(item.incidentType);
            const nowSec = Math.floor(Date.now() / 1000);
            const turoDeadlineAt = isTuro
              ? new firebase.firestore.Timestamp(nowSec + 86400, 0)
              : null;
            const title = item.label + (notes ? ' — ' + notes : '');

            const incRef = await db.collection('incidents').add({
              vehicleId: vid,
              vehiclePlate: plate,
              type: item.incidentType,
              title: title,
              description: notes || ('Inspection fail: ' + item.label),
              urgent: true,
              status: 'open',
              resolution: '',
              resolvedBy: '', resolvedByName: '', resolvedAt: null,
              followUpDate: '',
              photoUrls: photoUrls,
              reportedBy: currentUser.uid,
              reportedByName: currentUser.displayName || currentUser.email,
              createdAt: firebase.firestore.FieldValue.serverTimestamp(),
              updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
              sourceType: 'inspection',
              inspectionKey: item.key,
              ...(turoDeadlineAt ? { turoDeadlineAt } : {}),
            });

            // Auto-create Turo 24h claim task so it surfaces in homepage urgent banner
            if (isTuro) {
              await db.collection('generalNotes').add({
                text: '🛡️ FILE TURO CLAIM: ' + title + (plate ? ' [' + plate + ']' : ''),
                isFollowUp: true, done: false,
                urgent: true, taskStatus: 'urgent',
                dueDate: todayDateString(),
                sourceType: 'incident_turo',
                incidentDocId: incRef.id,
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                createdBy: currentUser.uid,
                createdByName: currentUser.displayName || currentUser.email,
              });
            }
            newIncCount++;
          }
        } else {
          // ── Non-incident ops items (clean, refueled): plain urgent task ──
          const noteData = {
            vehicleId: vid,
            text: 'INSPECTION FAIL - ' + item.label + (notes ? ': ' + notes : ''),
            isFollowUp: true, done: false,
            urgent: true, taskStatus: 'urgent',
            sourceType: 'inspection', inspectionKey: item.key,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            createdBy: currentUser.uid,
            createdByName: currentUser.displayName || currentUser.email,
          };
          if (photoUrls.length > 0) noteData.photos = photoUrls;
          await db.collection('vehicleNotes').add(noteData);
          newTaskCount++;
        }
      }

      await db.collection('vehicles').doc(vid).update({
        needsDamageCheck: false,
        lastInspectedAt: firebase.firestore.FieldValue.serverTimestamp(),
        lastInspectedBy: currentUser.displayName || currentUser.email,
      });
      const cached = vehiclesCache.find(v => v.id === vid);
      if (cached) cached.needsDamageCheck = false;

      if (failItems.length > 0) {
        const parts = [];
        if (newIncCount > 0)   parts.push(newIncCount + ' incident(s) created' + (TURO_ELIGIBLE_INCIDENT_TYPES.includes(failItems.find(i => i.incidentType)?.incidentType) ? ' — Turo claim task added' : ''));
        if (reusedCount > 0)   parts.push(reusedCount + ' existing incident(s) re-flagged');
        if (newTaskCount > 0)  parts.push(newTaskCount + ' task(s) logged');
        toast('Inspection submitted. ' + parts.join(', ') + '.', 'warning');
        loadDashboardFollowUps();
        loadAllOpenIncidentsDashboard();
      } else {
        toast('Inspection complete - All Clear', 'success');
      }
      overlay.remove();
      renderLocationsWidget();
    } catch(err) {
      console.error('Inspection submit error:', err);
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Submit Inspection';
      toast('Failed to submit inspection.', 'error');
    }
  });
}

// INSPECTION ITEMS LIST
// ================================================================
// incidentType: if set, a failed item auto-creates an Incident Report + (if Turo-eligible) a 24h claim task.
// Items without incidentType (clean, refueled) create a plain vehicleNotes urgent task.
const INSPECTION_ITEMS = [
  { key: 'exterior', label: 'Exterior - No new damage',        incidentType: 'damage'  },
  { key: 'interior', label: 'Interior - No new damage',        incidentType: 'damage'  },
  { key: 'tires',    label: 'Tires - Good condition',          incidentType: 'damage'  },
  { key: 'smoking',  label: 'Smoking / Odor - None detected',  incidentType: 'smoking' },
  { key: 'clean',    label: 'Vehicle Cleaned' },
  { key: 'refueled', label: 'Vehicle Refueled ⛽' },
  { key: 'bugs',     label: 'Bugs Spotted?', yesno: true },
];

// Open the vehicle detail page
async function openVehiclePage(vid) {
  selectedVehicle = vehiclesCache.find(v => v.id === vid);
  if (!selectedVehicle) return;

  // Populate & sync the fleet dropdown
  const fleetSel = $('vehicle-fleet-select');
  if (fleetSel) {
    fleetSel.innerHTML = '';
    vehiclesCache.forEach(v => {
      const opt = document.createElement('option');
      opt.value = v.id;
      opt.textContent = v.plate + (v.make ? ' – ' + v.make + (v.model ? ' ' + v.model : '') : '');
      fleetSel.appendChild(opt);
    });
    fleetSel.value = vid;
  }

  // Set page title
  $('vehicle-page-title').textContent = `${selectedVehicle.plate}`;
  $('vehicle-make-model').textContent = `${selectedVehicle.make} ${selectedVehicle.model}` +
    (selectedVehicle.year ? ` (${selectedVehicle.year})` : '') +
    (selectedVehicle.color ? ` - ${selectedVehicle.color}` : '');

  // Set location dropdowns
  const homeLocSelect = $('vehicle-home-location');
  const tripStatusSelect = $('vehicle-trip-status');
  const tripReturnRow = $('trip-return-row');
  const tripReturnInput = $('vehicle-trip-return');
  const repairPartsRow = $('repair-parts-row');
  if (homeLocSelect) {
    homeLocSelect.value = selectedVehicle.homeLocation || '';
    tripStatusSelect.value = selectedVehicle.tripStatus || 'home';
    const ts = tripStatusSelect.value;
    // Show/hide rows based on status
    $('trip-scheduled-row').style.display = ts === 'scheduled' ? '' : 'none';
    $('trip-expected-end-row').style.display = ts === 'scheduled' ? '' : 'none';
    tripReturnRow.style.display = (ts === 'on-trip' || ts === 'repair-shop') ? '' : 'none';
    $('on-trip-revenue-row').style.display = (ts === 'on-trip' || ts === 'scheduled') ? '' : 'none';
    repairPartsRow.style.display = ts === 'repair-shop' ? '' : 'none';
    $('hnl-parking-row').style.display = (homeLocSelect.value === 'HNL') ? '' : 'none';
    $('hnl-parking-row-val').value = selectedVehicle.parkingRow || '';
    $('hnl-parking-level').value = selectedVehicle.parkingLevel || '';
    $('private-trip-row').style.display = ts === 'private-trip' ? '' : 'none';
    // Populate private trip fields
    if (ts === 'private-trip') {
      $('private-customer-name').value = selectedVehicle.privateTripCustomerName || '';
      $('private-customer-phone').value = selectedVehicle.privateTripCustomerPhone || '';
      $('private-customer-email').value = selectedVehicle.privateTripCustomerEmail || '';
      $('private-trip-cost').value = selectedVehicle.privateTripDailyRate || '';
      $('private-trip-get').value = selectedVehicle.privateTripGET ?? '4.712';
      $('private-trip-daily-tax').value = selectedVehicle.privateTripDailyTax || '';
      if (selectedVehicle.tripScheduledStart) {
        setDTValue('private-trip-start-date', 'private-trip-start-time', selectedVehicle.tripScheduledStart);
      } else {
        setDTValue('private-trip-start-date', 'private-trip-start-time', null);
      }
      if (selectedVehicle.tripExpectedEnd) {
        setDTValue('private-trip-end-date', 'private-trip-end-time', selectedVehicle.tripExpectedEnd);
      } else {
        setDTValue('private-trip-end-date', 'private-trip-end-time', null);
      }
      if (selectedVehicle.tripReturnDate) {
        const rd = selectedVehicle.tripReturnDate.toDate ? selectedVehicle.tripReturnDate.toDate() : new Date(selectedVehicle.tripReturnDate);
        $('private-trip-return').value = rd.toLocaleString('sv-SE', { timeZone: APP_TIMEZONE }).slice(0, 16).replace(' ', 'T');
      }
      // Show contract if already uploaded
      const preview = $('private-contract-preview');
      if (preview) preview.innerHTML = selectedVehicle.privateTripContractUrl
        ? `<a href="${escapeHtml(selectedVehicle.privateTripContractUrl)}" target="_blank" class="compliance-doc-anchor">📄 View Contract</a>` : '';
    }
    // Populate scheduled start
    setDTValue('vehicle-trip-scheduled-start-date', 'vehicle-trip-scheduled-start-time', selectedVehicle.tripScheduledStart || null);
    // Populate expected end
    setDTValue('vehicle-trip-expected-end-date', 'vehicle-trip-expected-end-time', selectedVehicle.tripExpectedEnd || null);
    if (selectedVehicle.tripReturnDate) {
      const rd = selectedVehicle.tripReturnDate.toDate ? selectedVehicle.tripReturnDate.toDate() : new Date(selectedVehicle.tripReturnDate);
      tripReturnInput.value = rd.toLocaleString('sv-SE', { timeZone: APP_TIMEZONE }).slice(0, 16).replace(' ', 'T');
    } else {
      tripReturnInput.value = '';
    }
    // Repair parts fields
    $('repair-shop-name').value = selectedVehicle.repairShopName || '';
    $('repair-order-number').value = selectedVehicle.repairOrderNumber || '';
    $('repair-parts-eta').value = selectedVehicle.repairPartsEta || '';
    $('repair-cost').value = selectedVehicle.repairCost || '';
    $('repair-description').value = selectedVehicle.repairDescription || '';
    // On-trip revenue
    $('on-trip-revenue').value = selectedVehicle.tripRevenue != null ? selectedVehicle.tripRevenue : '';
    // On-trip & private-trip extras (multi-extras lists)
    ['on-trip-extras-list', 'private-trip-extras-list'].forEach(listId => {
      const list = $(listId);
      if (!list) return;
      list.innerHTML = '';
      const arr = Array.isArray(selectedVehicle.extras) ? selectedVehicle.extras
        : (selectedVehicle.extrasType ? [{ type: selectedVehicle.extrasType, amount: selectedVehicle.extrasAmount || 0 }] : []);
      arr.forEach(e => addExtraRow(listId, e.type, e.amount));
    });
    // Private trip revenue override
    $('private-trip-revenue-override').value = selectedVehicle.privateTripRevenueOverride != null ? selectedVehicle.privateTripRevenueOverride : '';
    _calcPrivateTripRevenue();
    // React to trip status dropdown changes
    tripStatusSelect.onchange = function() {
      const v = this.value;
      $('trip-scheduled-row').style.display = v === 'scheduled' ? '' : 'none';
      $('trip-expected-end-row').style.display = v === 'scheduled' ? '' : 'none';
      tripReturnRow.style.display = (v === 'on-trip' || v === 'repair-shop') ? '' : 'none';
      $('on-trip-revenue-row').style.display = (v === 'on-trip' || v === 'scheduled') ? '' : 'none';
      repairPartsRow.style.display = v === 'repair-shop' ? '' : 'none';
    };
  }

  // Show "Needs Cleaning" button if vehicle is home and not already flagged
  const needsCleanBtn = $('btn-needs-cleaning');
  if (needsCleanBtn) {
    const showCleanBtn = selectedVehicle.tripStatus !== 'on-trip' && selectedVehicle.tripStatus !== 'repair-shop' && !selectedVehicle.needsCleaning;
    needsCleanBtn.style.display = showCleanBtn ? '' : 'none';
  }

  // Show hero image if set
  const heroWrap = $('vehicle-hero-wrap');
  const heroImg = $('vehicle-hero-img');
  if (selectedVehicle.defaultImageUrl) {
    heroImg.src = selectedVehicle.defaultImageUrl;
    heroWrap.style.display = 'block';
  } else {
    heroWrap.style.display = 'none';
    heroImg.src = '';
  }

  // Show last photo timestamp
  const lastPhotoEl = $('last-photo-time');
  if (selectedVehicle.lastPhotoDate) {
    lastPhotoEl.textContent = '📷 Last photo: ' + selectedVehicle.lastPhotoDate.toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true,
      timeZone: APP_TIMEZONE
    });
    lastPhotoEl.style.display = 'block';
  } else if (selectedVehicle.lastPhotoAge === Infinity) {
    lastPhotoEl.textContent = '📷 No photos taken yet';
    lastPhotoEl.style.display = 'block';
  } else {
    lastPhotoEl.style.display = 'none';
  }

  // Show stale photo alert — suppress for on-trip, needs-cleaning, and 2hr grace after return
  const MS_24H = 24 * 60 * 60 * 1000;
  const MS_2H = 2 * 60 * 60 * 1000;
  const staleAlert = $('stale-alert');
  const isOnTrip = selectedVehicle.tripStatus === 'on-trip' || selectedVehicle.tripStatus === 'private-trip';
  const isAtRepairShop = selectedVehicle.tripStatus === 'repair-shop';
  const stillNeedsCleaning = selectedVehicle.needsCleaning;
  const isExcluded = !!selectedVehicle.photoExcluded;
  // Grace: 2 hours after cleaning was flagged (vehicle returned)
  let withinGrace = false;
  if (selectedVehicle.cleaningFlaggedAt) {
    const flagTime = selectedVehicle.cleaningFlaggedAt.toDate ? selectedVehicle.cleaningFlaggedAt.toDate().getTime() : new Date(selectedVehicle.cleaningFlaggedAt).getTime();
    withinGrace = (Date.now() - flagTime) < MS_2H;
  }
  const suppressStale = isOnTrip || isAtRepairShop || stillNeedsCleaning || withinGrace || isExcluded;

  if (!suppressStale && selectedVehicle.lastPhotoAge != null && selectedVehicle.lastPhotoAge > MS_24H) {
    if (selectedVehicle.lastPhotoAge === Infinity) {
      staleAlert.textContent = '\u26A0\uFE0F No photos have been taken for this vehicle.';
    } else {
      const hoursAgo = Math.floor(selectedVehicle.lastPhotoAge / (1000 * 60 * 60));
      const daysAgo = Math.floor(hoursAgo / 24);
      const ageText = daysAgo > 0 ? `${daysAgo}d ${hoursAgo % 24}h ago` : `${hoursAgo}h ago`;
      staleAlert.textContent = `\u26A0\uFE0F Last photo was ${ageText} \u2014 photos may be outdated.`;
    }
    staleAlert.style.display = 'block';
  } else if (isOnTrip) {
    staleAlert.textContent = '🚗 Vehicle is on a trip — photos not required until after return & cleaning.';
    staleAlert.style.display = 'block';
    staleAlert.className = 'stale-alert stale-info';
  } else {
    staleAlert.style.display = 'none';
    staleAlert.className = 'stale-alert';
  }

  // Role-gate upload and maintenance
  const canUpload = (currentUserRole === 'admin' || currentUserRole === 'manager');
  $('upload-section').style.display = canUpload ? 'block' : 'none';
  $('recent-photos-section').style.display = 'block';
  $('maintenance-section').style.display = 'block';

  // Photo override button — show when stale and admin/manager (top of info card)
  const photoOverrideWrap = $('photo-override-wrap');
  const isStaleNow = !suppressStale && selectedVehicle.lastPhotoAge != null && selectedVehicle.lastPhotoAge > MS_24H;
  const showOverride = canUpload && !isExcluded && (isStaleNow || selectedVehicle.lastPhotoAge === Infinity);
  photoOverrideWrap.style.display = showOverride ? 'block' : 'none';

  // Upload-section override button — same logic, shown inside the photo section
  const uploadOverrideWrap = $('upload-override-wrap');
  if (uploadOverrideWrap) uploadOverrideWrap.style.display = showOverride ? 'block' : 'none';

  // Exclude toggle — restricted to matthew.fetterman@gmail.com only
  const photoExcludeWrap = $('photo-exclude-wrap');
  const canExclude = !!(currentUser && currentUser.email && currentUser.email.toLowerCase() === 'matthew.fetterman@gmail.com');
  if (photoExcludeWrap) {
    photoExcludeWrap.style.display = canExclude ? 'block' : 'none';
    const excludeBtn = $('btn-photo-exclude');
    if (excludeBtn) {
      if (isExcluded) {
        excludeBtn.textContent = '✅ Excluded This Trip — Click to Re-enable';
        excludeBtn.classList.add('btn-exclude-active');
        excludeBtn.classList.remove('btn-exclude');
      } else {
        excludeBtn.textContent = '🚫 Exclude This Trip (Photos & Cleaning)';
        excludeBtn.classList.add('btn-exclude');
        excludeBtn.classList.remove('btn-exclude-active');
      }
    }
  }

  // Reset mileage prompt for this vehicle
  if (canUpload) {
    resetMileagePrompt();
  }

  const canMaintain = (currentUserRole === 'admin' || currentUserRole === 'manager');
  $('btn-add-maintenance').style.display = canMaintain ? '' : 'none';
  $('mileage-edit-row').style.display = canMaintain ? '' : 'none';

  // Show notes section
  $('notes-section').style.display = 'block';

  // Show incidents section and load
  $('incidents-section').style.display = 'block';
  loadVehicleIncidents(vid);

  // Show Vehicle Info section
  $('vehicle-info-section').style.display = 'block';
  loadVehicleInfoSection(selectedVehicle);

  // Show admin button if admin
  $('btn-admin-from-vehicle').style.display = currentUserRole === 'admin' ? '' : 'none';

  // Navigate to vehicle page
  showPage('vehicle');

  // Load photos for selected date
  selectedDate = todayDateString();
  updateDateDisplay();
  $('mini-calendar').style.display = 'none';
  await loadPhotosForDate(vid, selectedDate);
  loadPhotoDates(vid, selectedDate);

  // Resume any pending photo uploads that didn't finish (IndexedDB recovery)
  resumePendingUploads(selectedVehicle);

  // Load maintenance data
  loadMileage(vid);
  loadMaintenanceHistory(vid);
  loadVehicleNotes(vid);

  // Load compliance data
  loadComplianceData(selectedVehicle);
}

// ================================================================
// MILEAGE PROMPT — required before photo upload
// ================================================================

let mileageConfirmed = false;

function resetMileagePrompt() {
  mileageConfirmed = false;
  $('mileage-prompt').style.display = '';
  $('upload-controls-wrap').style.display = 'none';
  const input = $('mileage-prompt-input');
  input.value = '';

  // Show previous mileage as hint
  const prev = selectedVehicle && selectedVehicle.mileage;
  const prevEl = $('mileage-prompt-prev');
  if (prev) {
    prevEl.textContent = `Last recorded: ${prev.toLocaleString()} mi`;
  } else {
    prevEl.textContent = 'No mileage on file yet';
  }
}

function confirmMileage() {
  const input = $('mileage-prompt-input');
  const val = parseInt(input.value);
  if (!val || val < 1) {
    toast('Enter the current odometer reading to continue.', 'warning');
    input.focus();
    return;
  }
  mileageConfirmed = true;

  // Save mileage to Firestore
  if (selectedVehicle) {
    db.collection('vehicles').doc(selectedVehicle.id).update({ mileage: val }).then(async () => {
      selectedVehicle.mileage = val;
      const cached = vehiclesCache.find(v => v.id === selectedVehicle.id);
      if (cached) cached.mileage = val;
      // Also update the maintenance mileage input
      $('vehicle-mileage').value = val;
      updateRecommendedServices(selectedVehicle.id);

      // Auto-flag mileage-based follow-ups as urgent when within 500 miles
      try {
        const miSnap = await db.collection('vehicleNotes')
          .where('vehicleId', '==', selectedVehicle.id)
          .where('autoCreated', '==', true)
          .where('intervalType', '==', 'mileage')
          .where('done', '==', false)
          .get();
        const urgentBatch = db.batch();
        let anyUrgent = false;
        miSnap.forEach(doc => {
          const d = doc.data();
          if (!d.nextDueMileage) return;
          const milesLeft = d.nextDueMileage - val;
          if (milesLeft <= 500 && !d.urgent) {
            urgentBatch.update(doc.ref, { urgent: true });
            anyUrgent = true;
          }
        });
        if (anyUrgent) {
          await urgentBatch.commit();
          toast('⚠️ Service coming up within 500 miles!', 'warning');
          loadDashboardFollowUps();
        }
      } catch (e) { /* ignore */ }
    }).catch(err => console.error('Mileage save error:', err));
  }

  // Show upload controls, hide prompt
  $('mileage-prompt').style.display = 'none';
  $('upload-controls-wrap').style.display = '';
  $('mileage-confirmed-value').textContent = val.toLocaleString();
}

$('btn-mileage-confirm').addEventListener('click', confirmMileage);

// Photo override — mark photos as up to date without uploading
async function doPhotoOverride() {
  if (!selectedVehicle) return;
  const ok = await confirm('Mark Photos Up to Date', `Mark ${selectedVehicle.plate} photos as current? Use this when photos were taken locally and not uploaded, or data was kept from a previous session.`);
  if (!ok) return;
  try {
    await db.collection('vehicles').doc(selectedVehicle.id).update({
      lastPhotoOverrideAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    const now = Date.now();
    selectedVehicle.lastPhotoOverrideAt = { toDate: () => new Date(now) };
    selectedVehicle.lastPhotoAge = 0;
    selectedVehicle.lastPhotoDate = new Date(now);
    const cached = vehiclesCache.find(v => v.id === selectedVehicle.id);
    if (cached) {
      cached.lastPhotoOverrideAt = selectedVehicle.lastPhotoOverrideAt;
      cached.lastPhotoAge = 0;
      cached.lastPhotoDate = new Date(now);
    }
    $('photo-override-wrap').style.display = 'none';
    if ($('upload-override-wrap')) $('upload-override-wrap').style.display = 'none';
    $('stale-alert').style.display = 'none';
    $('last-photo-time').textContent = '📷 Photos marked up to date just now';
    $('last-photo-time').style.display = 'block';
    toast('Photos marked as up to date ✓', 'success');
    renderLocationsWidget();
  } catch (err) {
    console.error('Photo override error:', err);
    toast('Failed to update.', 'error');
  }
}
$('btn-photo-override').addEventListener('click', doPhotoOverride);
$('btn-upload-override').addEventListener('click', doPhotoOverride);

// Exclude toggle — admin only — bypass photos & cleaning prompts
$('btn-photo-exclude').addEventListener('click', async () => {
  if (!selectedVehicle) return;
  if (!currentUser || currentUser.email.toLowerCase() !== 'matthew.fetterman@gmail.com') {
    toast('Only the fleet owner can change this setting.', 'warning');
    return;
  }
  const isCurrentlyExcluded = !!selectedVehicle.photoExcluded;
  const action = isCurrentlyExcluded ? 'Re-enable' : 'Exclude';
  const msg = isCurrentlyExcluded
    ? `Re-enable photo and cleaning prompts for ${selectedVehicle.plate}?`
    : `Exclude ${selectedVehicle.plate} from photo and cleaning prompts for this trip?\n\nThe exclusion will automatically clear when the vehicle is returned home.`;
  const ok = await confirm(`${action} ${selectedVehicle.plate}`, msg);
  if (!ok) return;
  try {
    const newVal = !isCurrentlyExcluded;
    await db.collection('vehicles').doc(selectedVehicle.id).update({ photoExcluded: newVal });
    selectedVehicle.photoExcluded = newVal;
    const cached = vehiclesCache.find(v => v.id === selectedVehicle.id);
    if (cached) cached.photoExcluded = newVal;
    // Refresh UI
    const excludeBtn = $('btn-photo-exclude');
    if (newVal) {
      excludeBtn.textContent = '✅ Excluded This Trip — Click to Re-enable';
      excludeBtn.classList.add('btn-exclude-active');
      excludeBtn.classList.remove('btn-exclude');
      $('stale-alert').style.display = 'none';
      $('photo-override-wrap').style.display = 'none';
      if ($('upload-override-wrap')) $('upload-override-wrap').style.display = 'none';
      toast(`${selectedVehicle.plate} excluded from photos & cleaning ✓`, 'success');
    } else {
      excludeBtn.textContent = '🚫 Exclude This Trip (Photos & Cleaning)';
      excludeBtn.classList.remove('btn-exclude-active');
      excludeBtn.classList.add('btn-exclude');
      toast(`${selectedVehicle.plate} prompts re-enabled ✓`, 'success');
    }
    renderLocationsWidget();
  } catch (err) {
    console.error('Exclude toggle error:', err);
    toast('Failed to update.', 'error');
  }
});

$('mileage-prompt-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    confirmMileage();
  }
});

$('btn-mileage-edit').addEventListener('click', () => {
  resetMileagePrompt();
  // Pre-fill with current value
  if (selectedVehicle && selectedVehicle.mileage) {
    $('mileage-prompt-input').value = selectedVehicle.mileage;
  }
  $('mileage-prompt-input').focus();
});

// ================================================================
// PHOTO UPLOAD — background parallel uploads
// ================================================================

$('file-input').addEventListener('change', handlePhotoFiles);

let bgUploadTotal = 0;
let bgUploadDone = 0;
let bgUploadActive = false;

function bgUploadShow(total) {
  bgUploadTotal = total;
  bgUploadDone = 0;
  bgUploadActive = true;
  const toast = $('bg-upload-toast');
  if (toast) {
    toast.style.display = '';
    toast.classList.remove('bg-upload-minimized');
    $('bg-upload-title').textContent = `⬆️ Uploading ${total} photo${total > 1 ? 's' : ''}…`;
    $('bg-upload-text').textContent = `0 / ${total}`;
    $('bg-upload-fill').style.width = '0%';
  }
}

function bgUploadTick(success) {
  bgUploadDone++;
  const pct = Math.round((bgUploadDone / bgUploadTotal) * 100);
  const fillEl = $('bg-upload-fill');
  const textEl = $('bg-upload-text');
  if (fillEl) fillEl.style.width = pct + '%';
  if (textEl) textEl.textContent = `${bgUploadDone} / ${bgUploadTotal}`;
  if (bgUploadDone >= bgUploadTotal) {
    bgUploadActive = false;
    $('bg-upload-title').textContent = `✅ Upload complete`;
    setTimeout(() => {
      const t = $('bg-upload-toast');
      if (t) t.style.display = 'none';
    }, 3000);
  }
}

async function handlePhotoFiles(e) {
  const files = Array.from(e.target.files);
  if (!files.length || !selectedVehicle) return;
  // Capture vehicle reference immediately — user may navigate away before uploads finish
  const capturedVehicle = selectedVehicle;
  const capturedDate = selectedDate;

  if (!getStorage()) {
    toast('Photo uploads not available — Firebase Storage is not enabled yet. Contact your admin.', 'error');
    e.target.value = '';
    return;
  }

  const total = files.length;
  bgUploadShow(total);
  e.target.value = '';

  // Add thumbnail previews immediately (UI feedback before upload completes)
  const queue = $('photo-queue');
  const thumbMap = new Map();
  files.forEach(file => {
    const item = document.createElement('div');
    item.className = 'photo-queue-item';
    const thumb = document.createElement('img');
    thumb.src = URL.createObjectURL(file);
    item.appendChild(thumb);
    const statusIcon = document.createElement('div');
    statusIcon.className = 'status-icon status-uploading';
    statusIcon.textContent = '⏳';
    item.appendChild(statusIcon);
    queue.prepend(item);
    thumbMap.set(file, { item, statusIcon });
  });

  // Upload all files in parallel (background)
  const uploadPromises = files.map(async file => {
    const { item, statusIcon } = thumbMap.get(file);
    try {
      const compressed = await compressImage(file);
      await uploadPhoto(compressed, capturedVehicle);
      statusIcon.className = 'status-icon status-done';
      statusIcon.textContent = '✓';
      bgUploadTick(true);
    } catch (err) {
      console.error('Upload error:', err);
      statusIcon.className = 'status-icon status-error';
      statusIcon.textContent = '✗';
      bgUploadTick(false);
    }
  });

  // Refresh photos for the current date when all uploads finish
  Promise.all(uploadPromises).then(async () => {
    if (capturedVehicle && selectedVehicle && capturedVehicle.id === selectedVehicle.id) {
      await loadPhotosForDate(capturedVehicle.id, capturedDate);
    }
  });
}

// Core upload function — used by both file picker and camera
async function uploadPhoto(blobOrFile, vehicleOverride) {
  const st = getStorage();
  if (!st) {
    throw new Error('Firebase Storage is not enabled yet. Contact your admin to enable billing.');
  }
  const v = vehicleOverride || selectedVehicle;
  const plate = sanitizePlate(v.plate);
  const date = todayDateString();
  const timestamp = Date.now();
  const fileName = `${timestamp}_${Math.random().toString(36).substring(2, 8)}.jpg`;
  const storagePath = `vehicles/${plate}/${date}/${fileName}`;

  const ref = st.ref(storagePath);
  await ref.put(blobOrFile, { contentType: 'image/jpeg' });
  const downloadURL = await ref.getDownloadURL();

  await db.collection('photos').add({
    vehicleId: v.id,
    plate: v.plate,
    storagePath: storagePath,
    url: downloadURL,
    date: date,
    timestamp: firebase.firestore.FieldValue.serverTimestamp(),
    uploadedBy: currentUser.uid,
    uploaderName: currentUser.displayName || currentUser.email,
  });

  return downloadURL;
}

function updateProgress(uploaded, total) {
  const pct = total > 0 ? Math.round((uploaded / total) * 100) : 0;
  $('progress-fill').style.width = pct + '%';
  $('progress-text').textContent = `${uploaded} / ${total} uploaded`;
}

// ================================================================
// RAPID-FIRE IN-BROWSER CAMERA
// ================================================================

// ── IndexedDB: persist compressed photo blobs so uploads survive
//    page reloads, iOS backgrounding, and camera re-opens ──────
const _PHOTO_DB_NAME    = 'alohaFleetPendingPhotos';
const _PHOTO_DB_VER     = 1;
const _PHOTO_STORE      = 'pending';
let   _photoIDB         = null;

function _openPhotoDB() {
  if (_photoIDB) return Promise.resolve(_photoIDB);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(_PHOTO_DB_NAME, _PHOTO_DB_VER);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(_PHOTO_STORE)) {
        const store = db.createObjectStore(_PHOTO_STORE, { keyPath: 'idbId', autoIncrement: true });
        store.createIndex('vehicleId', 'vehicleId', { unique: false });
      }
    };
    req.onsuccess = e => { _photoIDB = e.target.result; resolve(_photoIDB); };
    req.onerror   = e => reject(e.target.error);
  });
}

async function _idbSavePhoto(blob, vehicle) {
  try {
    const db = await _openPhotoDB();
    return await new Promise((resolve, reject) => {
      const tx  = db.transaction(_PHOTO_STORE, 'readwrite');
      const req = tx.objectStore(_PHOTO_STORE).add({
        vehicleId: vehicle.id,
        vehiclePlate: vehicle.plate || '',
        blob,
        createdAt: Date.now(),
      });
      req.onsuccess = () => resolve(req.result);  // auto-incremented idbId
      req.onerror   = e => reject(e.target.error);
    });
  } catch(e) { console.warn('IDB save failed:', e); return null; }
}

async function _idbDeletePhoto(idbId) {
  if (idbId == null) return;
  try {
    const db = await _openPhotoDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(_PHOTO_STORE, 'readwrite');
      tx.objectStore(_PHOTO_STORE).delete(idbId);
      tx.oncomplete = resolve;
      tx.onerror    = e => reject(e.target.error);
    });
  } catch(e) { console.warn('IDB delete failed:', e); }
}

async function _idbGetPending(vehicleId) {
  try {
    const db = await _openPhotoDB();
    return await new Promise((resolve, reject) => {
      const tx    = db.transaction(_PHOTO_STORE, 'readonly');
      const store = tx.objectStore(_PHOTO_STORE);
      const req   = vehicleId ? store.index('vehicleId').getAll(vehicleId) : store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror   = () => resolve([]);
    });
  } catch(e) { return []; }
}

async function _idbCount() {
  try {
    const db = await _openPhotoDB();
    return await new Promise(resolve => {
      const req = db.transaction(_PHOTO_STORE, 'readonly').objectStore(_PHOTO_STORE).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => resolve(0);
    });
  } catch(e) { return 0; }
}
// ─────────────────────────────────────────────────────────────

let cameraStream = null;
let cameraFacingMode = 'environment'; // back camera
let cameraFlashOn = false;
let cameraShotCount = 0;
let cameraUploadQueue = [];
let cameraUploading = false;
let cameraUploadedCount = 0;
let cameraTotalQueued = 0;
let cameraUploadedUrls = [];

// Zoom state — software zoom is the primary path (works on iOS Safari).
// Hardware zoom via applyConstraints is tried first but only works on Android Chrome.
let cameraZoomLevel  = 1.0;
let cameraZoomMin    = 1.0;
let cameraZoomMax    = 5.0;   // overridden from caps when hardware zoom available
let _cameraHwZoom    = false; // true when the track supports hardware zoom

function _setCameraZoom(level) {
  level = Math.max(cameraZoomMin, Math.min(cameraZoomMax, level));
  // Round to 1 decimal to avoid floating-point drift from repeated pinches
  level = Math.round(level * 10) / 10;
  cameraZoomLevel = level;

  if (_cameraHwZoom && cameraStream) {
    const [t] = cameraStream.getVideoTracks();
    if (t) t.applyConstraints({ advanced: [{ zoom: level }] }).catch(() => _applySwZoom(level));
  }
  // Always apply software zoom — ensures the video display reflects the zoom on iOS
  _applySwZoom(level);
  _updateZoomUI();
}

function _applySwZoom(level) {
  const video = $('camera-video');
  if (!video) return;
  // scale() on the video; the wrapper clips overflow so it stays fullscreen
  video.style.transform = level > 1 ? `scale(${level})` : '';
  video.style.transformOrigin = 'center center';
}

function _updateZoomUI() {
  const lbl = $('camera-zoom-label');
  if (lbl) lbl.textContent = cameraZoomLevel.toFixed(1) + '×';
  const btnOut = $('camera-zoom-out');
  if (btnOut) btnOut.disabled = cameraZoomLevel <= cameraZoomMin;
  const btnIn = $('camera-zoom-in');
  if (btnIn) btnIn.disabled = cameraZoomLevel >= cameraZoomMax;
}

$('btn-open-camera').addEventListener('click', async () => {
  if (!selectedVehicle) {
    toast('Select a vehicle first.', 'warning');
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast('Camera not supported on this browser. Try Safari or Chrome.', 'error');
    return;
  }
  await openCamera();
});

// Pinch-to-zoom handler for the in-browser camera
// Reads current zoom from the active track, scales it by the pinch ratio, then clamps to [min, max]
let _cameraPinchZoomInit = false;
function _initCameraPinchZoom() {
  if (_cameraPinchZoomInit) return; // only attach once — listeners persist on the element
  _cameraPinchZoomInit = true;

  const overlay = $('camera-overlay');
  let pinchStartDist = null;
  let pinchStartZoom = 1;

  function _pinchDist(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  overlay.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      pinchStartDist = _pinchDist(e.touches);
      pinchStartZoom = cameraZoomLevel; // snapshot current logical zoom
    }
  }, { passive: true });

  overlay.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2) {
      // MUST preventDefault to stop iOS Safari from zoom-scaling the entire viewport.
      // This requires passive: false (set below).
      e.preventDefault();
    }
    if (e.touches.length !== 2 || pinchStartDist === null) return;
    const scale = _pinchDist(e.touches) / pinchStartDist;
    _setCameraZoom(pinchStartZoom * scale);
  }, { passive: false });

  overlay.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) pinchStartDist = null;
  }, { passive: true });
}

async function openCamera() {
  // Reset session display counters — but do NOT clear cameraUploadQueue.
  // Any uploads still running from a previous session must continue uninterrupted.
  cameraShotCount = 0;
  cameraUploadedCount = 0;
  cameraTotalQueued = 0;
  cameraUploadedUrls = [];
  cameraFlashOn = false;
  $('camera-thumbs').innerHTML = '';
  $('camera-count').textContent = '0 photos';
  $('camera-upload-bar').style.display = 'none';
  updateFlashButton();
  $('camera-overlay').style.display = 'flex';

  // Pinch-to-zoom on the camera video feed
  // Auto-zoom is forced to minimum on stream open; user can pinch to zoom in/out freely
  _initCameraPinchZoom();

  try {
    await startCameraStream();
  } catch (err) {
    console.error('Camera error:', err);
    $('camera-overlay').style.display = 'none';
    toast('Could not access camera. Check permissions.', 'error');
  }
}

async function startCameraStream() {
  // Stop existing stream
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
  }

  // Use 'exact' facingMode to force the wide-angle (1x) lens on multi-camera iPhones
  // Request specific resolution to avoid telephoto lens selection
  // Fall back step by step if the device doesn't support it
  let stream = null;
  const attempts = [
    // Note: zoom is NOT included in getUserMedia constraints (non-standard, causes failures)
    // It is applied via applyConstraints AFTER the stream starts
    { video: { facingMode: { exact: cameraFacingMode }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false },
    { video: { facingMode: { exact: cameraFacingMode } }, audio: false },
    { video: { facingMode: cameraFacingMode }, audio: false },
    { video: true, audio: false },
  ];

  for (const constraints of attempts) {
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
      break;
    } catch (err) {
      // Try next set of constraints
    }
  }

  if (!stream) {
    throw new Error('Could not access any camera.');
  }

  cameraStream = stream;

  // Detect hardware zoom support (Android Chrome) and reset zoom to minimum.
  // On iOS Safari, getCapabilities() won't include 'zoom' — we rely on software zoom instead.
  _cameraHwZoom = false;
  const [track] = cameraStream.getVideoTracks();
  if (track && track.getCapabilities) {
    try {
      const caps = track.getCapabilities();
      if (caps.zoom) {
        _cameraHwZoom = true;
        cameraZoomMin = caps.zoom.min;
        cameraZoomMax = caps.zoom.max;
      }
      // Apply torch state if supported
      const constraintUpdates = {};
      if (caps.zoom) constraintUpdates.zoom = caps.zoom.min;
      if (caps.torch) constraintUpdates.torch = cameraFlashOn;
      if (Object.keys(constraintUpdates).length) {
        await track.applyConstraints({ advanced: [constraintUpdates] });
      }
    } catch (e) { /* zoom/torch not supported — ok */ }
  }
  // Always reset to 1× when starting a new stream (flip, or first open)
  cameraZoomLevel = 1.0;
  _applySwZoom(1.0);
  _updateZoomUI();
  updateFlashButton();

  const video = $('camera-video');
  video.srcObject = cameraStream;
  // iOS Safari needs setAttribute for playsinline to take effect
  video.setAttribute('playsinline', 'true');
  video.setAttribute('muted', 'true');
  video.muted = true;

  try {
    await video.play();
  } catch (playErr) {
    console.warn('video.play() rejected, attempting again:', playErr);
    // Some iOS versions reject the first play — short delay and retry
    await new Promise(r => setTimeout(r, 300));
    await video.play();
  }
}

// Resume any photos saved to IndexedDB that didn't finish uploading
// Called when opening a vehicle page — catches any photos left over from:
//   • interrupted sessions, iOS app suspension, page reloads, or upload errors
async function resumePendingUploads(vehicle) {
  if (!vehicle) return;
  try {
    const pending = await _idbGetPending(vehicle.id);
    // Update banner regardless
    _updatePendingBanner(pending.length, vehicle.plate);

    if (!pending.length) return;

    // Find IDB IDs already in the in-memory queue so we don't double-queue
    const queuedIds = new Set(cameraUploadQueue.map(i => i.idbId).filter(Boolean));
    const toResume = pending.filter(p => !queuedIds.has(p.idbId));
    if (!toResume.length) return;

    toast(`📤 Resuming ${toResume.length} unfinished upload${toResume.length !== 1 ? 's' : ''} for ${vehicle.plate}…`, 'info');
    toResume.forEach(p => {
      cameraUploadQueue.push({ blob: p.blob, vehicle, idbId: p.idbId });
      cameraTotalQueued++;
    });
    updateCameraUploadBar();
    processCameraQueue();
  } catch(e) { console.warn('resumePendingUploads error:', e); }
}

function _updatePendingBanner(count, plate) {
  const banner = $('pending-uploads-banner');
  if (!banner) return;
  if (count > 0) {
    banner.style.display = '';
    banner.textContent = `📤 ${count} photo${count !== 1 ? 's' : ''} pending upload for ${plate} — will upload automatically.`;
  } else {
    banner.style.display = 'none';
  }
}

// Periodically restart the queue if it stalls (safety net for stuck cameraUploading flag)
setInterval(() => {
  if (!cameraUploading && cameraUploadQueue.length > 0) {
    processCameraQueue();
  }
}, 8000);

// Shutter button — captures frame and queues upload
$('camera-shutter').addEventListener('click', () => {
  const video = $('camera-video');
  const canvas = $('camera-canvas');

  // Capture at full sensor resolution, but crop to the zoomed region when using software zoom.
  // Software zoom shows a scaled-up center crop on screen — we replicate that in the canvas so
  // the saved photo matches exactly what the user saw in the viewfinder.
  canvas.width  = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  const z = cameraZoomLevel;
  if (z > 1) {
    // Crop center (1/z × 1/z) of the sensor frame and stretch it to full canvas
    const srcW = video.videoWidth  / z;
    const srcH = video.videoHeight / z;
    const srcX = (video.videoWidth  - srcW) / 2;
    const srcY = (video.videoHeight - srcH) / 2;
    ctx.drawImage(video, srcX, srcY, srcW, srcH, 0, 0, canvas.width, canvas.height);
  } else {
    ctx.drawImage(video, 0, 0);
  }

  // Flash effect
  video.classList.add('camera-shutter-flash');
  setTimeout(() => video.classList.remove('camera-shutter-flash'), 200);

  // Get blob
  canvas.toBlob(async (blob) => {
    if (!blob) return;

    cameraShotCount++;
    $('camera-count').textContent = `${cameraShotCount} photo${cameraShotCount !== 1 ? 's' : ''}`;

    // Add thumbnail
    const thumbUrl = URL.createObjectURL(blob);
    const thumbImg = document.createElement('img');
    thumbImg.src = thumbUrl;
    $('camera-thumbs').prepend(thumbImg);

    // Queue for upload in background
    queueCameraUpload(blob);
  }, 'image/jpeg', 0.85);
});

async function queueCameraUpload(blob) {
  const capturedVehicle = selectedVehicle; // snapshot before any async gap
  const compressed = await compressBlob(blob, 1920, 0.82);

  // 1. Persist to IndexedDB FIRST — survives page reload, iOS backgrounding, camera re-open
  const idbId = await _idbSavePhoto(compressed, capturedVehicle);

  // 2. Add to in-memory queue
  cameraUploadQueue.push({ blob: compressed, vehicle: capturedVehicle, idbId });
  cameraTotalQueued++;
  updateCameraUploadBar();
  processCameraQueue();
}

function updateCameraUploadBar() {
  const bar = $('camera-upload-bar');
  if (cameraTotalQueued === 0) {
    bar.style.display = 'none';
    return;
  }
  bar.style.display = 'flex';
  const pending = cameraTotalQueued - cameraUploadedCount;
  if (pending > 0) {
    $('camera-upload-text').textContent = `Uploading... ${cameraUploadedCount}/${cameraTotalQueued}`;
  } else {
    $('camera-upload-text').textContent = `All ${cameraTotalQueued} uploaded ✓`;
  }
  const pct = cameraTotalQueued > 0 ? (cameraUploadedCount / cameraTotalQueued) * 100 : 0;
  $('camera-upload-fill').style.width = pct + '%';
}

let storageWarningShown = false;

async function processCameraQueue() {
  if (cameraUploading || cameraUploadQueue.length === 0) return;
  cameraUploading = true;

  try {
    while (cameraUploadQueue.length > 0) {
      // Peek — don't shift yet; only remove after confirmed upload
      const item = cameraUploadQueue[0];
      try {
        const url = await uploadPhoto(item.blob, item.vehicle);
        cameraUploadQueue.shift();          // remove only on success
        cameraUploadedUrls.push(url);
        cameraUploadedCount++;
        _idbDeletePhoto(item.idbId);       // remove from IndexedDB on success
        updateCameraUploadBar();
      } catch (uploadErr) {
        console.error('Camera upload error (will retry):', uploadErr);
        cameraUploadQueue.shift();          // remove from queue but LEAVE in IndexedDB
        // Item stays in IndexedDB — resumePendingUploads will re-queue it later
        if (!storageWarningShown) {
          storageWarningShown = true;
          toast('Upload failed — photos saved locally and will retry automatically.', 'warning');
        }
      }
    }
  } finally {
    cameraUploading = false;              // ALWAYS release the lock
    // Update pending banner after queue drains
    if (selectedVehicle) {
      _idbGetPending(selectedVehicle.id).then(p => _updatePendingBanner(p.length, selectedVehicle.plate)).catch(() => {});
    }
  }
}

// Flash toggle
function updateFlashButton() {
  const btn = $('camera-flash');
  if (!btn) return;
  btn.textContent = cameraFlashOn ? '⚡ On' : '⚡ Off';
  btn.classList.toggle('camera-flash-active', cameraFlashOn);

  // Hide flash button if torch not available
  if (cameraStream) {
    const [track] = cameraStream.getVideoTracks();
    if (track && track.getCapabilities) {
      const caps = track.getCapabilities();
      btn.style.display = caps.torch ? '' : 'none';
    }
  }
}

$('camera-flash').addEventListener('click', async () => {
  cameraFlashOn = !cameraFlashOn;
  updateFlashButton();
  if (cameraStream) {
    const [track] = cameraStream.getVideoTracks();
    if (track && track.getCapabilities) {
      try {
        const caps = track.getCapabilities();
        if (caps.torch) {
          await track.applyConstraints({ advanced: [{ torch: cameraFlashOn }] });
        }
      } catch (e) {
        console.warn('Torch toggle failed:', e);
        toast('Flash not supported on this device.', 'warning');
        cameraFlashOn = false;
        updateFlashButton();
      }
    }
  }
});

// Flip camera
$('camera-flip').addEventListener('click', async () => {
  cameraFacingMode = cameraFacingMode === 'environment' ? 'user' : 'environment';
  try {
    await startCameraStream();
  } catch (err) {
    console.error('Flip camera error:', err);
    toast('Could not switch camera.', 'warning');
  }
});

// Zoom buttons — step 0.5×, clamp to min/max
$('camera-zoom-in').addEventListener('click', () => _setCameraZoom(cameraZoomLevel + 0.5));
$('camera-zoom-out').addEventListener('click', () => _setCameraZoom(cameraZoomLevel - 0.5));

// Close camera
$('camera-close').addEventListener('click', async () => {
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
  }
  $('camera-video').srcObject = null;
  $('camera-overlay').style.display = 'none';

  // Wait for any remaining uploads
  if (cameraUploadQueue.length > 0 || cameraUploading) {
    toast(`Finishing ${cameraUploadQueue.length} upload(s) in background...`, 'info');
  }

  if (cameraShotCount > 0 && selectedVehicle) {
    toast(`${cameraShotCount} photo(s) taken!`, 'success');
    await loadPhotosForDate(selectedVehicle.id, selectedDate);
    loadPhotoDates(selectedVehicle.id, selectedDate);
  }
});

// ================================================================
// PHOTO DATE NAVIGATION
// ================================================================

function formatDisplayDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  // Use UTC noon so local timezone never causes an off-by-one when formatted in HST
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const opts = { weekday: 'short', month: 'short', day: 'numeric', timeZone: APP_TIMEZONE };
  const label = dt.toLocaleDateString('en-US', opts);
  return dateStr === todayDateString() ? label + ' (Today)' : label;
}

function updateDateDisplay() {
  $('btn-date-display').textContent = formatDisplayDate(selectedDate);
  $('btn-date-today').style.display = selectedDate === todayDateString() ? 'none' : '';
}

function shiftDate(days) {
  const [y, m, d] = selectedDate.split('-').map(Number);
  const dt = new Date(y, m - 1, d + days);
  selectedDate = `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
  updateDateDisplay();
  if (selectedVehicle) {
    loadPhotosForDate(selectedVehicle.id, selectedDate);
    // Refresh calendar if month changed
    loadPhotoDates(selectedVehicle.id, selectedDate);
  }
}

$('btn-date-prev').addEventListener('click', () => shiftDate(-1));
$('btn-date-next').addEventListener('click', () => shiftDate(1));
$('btn-date-today').addEventListener('click', () => {
  selectedDate = todayDateString();
  updateDateDisplay();
  if (selectedVehicle) {
    loadPhotosForDate(selectedVehicle.id, selectedDate);
    loadPhotoDates(selectedVehicle.id, selectedDate);
  }
});

// Toggle mini calendar on date display click
$('btn-date-display').addEventListener('click', () => {
  const cal = $('mini-calendar');
  cal.style.display = cal.style.display === 'none' ? '' : 'none';
});

// ================================================================
// MINI CALENDAR — shows month grid with dots on days that have photos
// ================================================================

async function loadPhotoDates(vehicleId, refDate) {
  const [y, m] = refDate.split('-').map(Number);
  const startDate = `${y}-${String(m).padStart(2,'0')}-01`;
  const endDay = new Date(y, m, 0).getDate();
  const endDate = `${y}-${String(m).padStart(2,'0')}-${String(endDay).padStart(2,'0')}`;

  try {
    const snap = await db.collection('photos')
      .where('vehicleId', '==', vehicleId)
      .where('date', '>=', startDate)
      .where('date', '<=', endDate)
      .get();
    photoDatesCache = new Set();
    snap.forEach(doc => photoDatesCache.add(doc.data().date));
  } catch (e) {
    console.error('loadPhotoDates error:', e);
    photoDatesCache = new Set();
  }
  renderMiniCalendar(refDate);
}

function renderMiniCalendar(refDate) {
  const cal = $('mini-calendar');
  const [y, m] = refDate.split('-').map(Number);
  const firstDay = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const todayStr = todayDateString();

  // Use UTC noon to avoid local-timezone midnight causing off-by-one day-of-week
  const monthLabel = new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

  let html = `<div class="cal-header">
    <button class="cal-nav" id="cal-prev-month">&lsaquo;</button>
    <span class="cal-month">${monthLabel}</span>
    <button class="cal-nav" id="cal-next-month">&rsaquo;</button>
  </div>`;
  html += '<div class="cal-grid">';
  ['S','M','T','W','T','F','S'].forEach(d => { html += `<div class="cal-day-label">${d}</div>`; });

  for (let i = 0; i < firstDay; i++) html += '<div class="cal-cell"></div>';

  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const hasPhotos = photoDatesCache.has(ds);
    const isSelected = ds === selectedDate;
    const isToday = ds === todayStr;
    let cls = 'cal-cell cal-day';
    if (hasPhotos) cls += ' cal-has-photos';
    if (isSelected) cls += ' cal-selected';
    if (isToday) cls += ' cal-today';
    html += `<div class="${cls}" data-date="${ds}">${d}${hasPhotos ? '<span class="cal-dot"></span>' : ''}</div>`;
  }

  html += '</div>';
  cal.innerHTML = html;

  // Day click
  cal.querySelectorAll('.cal-day').forEach(el => {
    el.addEventListener('click', () => {
      selectedDate = el.dataset.date;
      updateDateDisplay();
      loadPhotosForDate(selectedVehicle.id, selectedDate);
      renderMiniCalendar(selectedDate);
    });
  });

  // Month navigation
  const prevBtn = $('cal-prev-month');
  const nextBtn = $('cal-next-month');
  if (prevBtn) prevBtn.addEventListener('click', () => {
    const nd = new Date(y, m - 2, 1);
    const newRef = `${nd.getFullYear()}-${String(nd.getMonth()+1).padStart(2,'0')}-01`;
    loadPhotoDates(selectedVehicle.id, newRef);
  });
  if (nextBtn) nextBtn.addEventListener('click', () => {
    const nd = new Date(y, m, 1);
    const newRef = `${nd.getFullYear()}-${String(nd.getMonth()+1).padStart(2,'0')}-01`;
    loadPhotoDates(selectedVehicle.id, newRef);
  });
}

// ================================================================
// LOAD PHOTOS FOR DATE
// ================================================================

async function loadPhotosForDate(vehicleId, dateStr) {
  const snapshot = await db.collection('photos')
    .where('vehicleId', '==', vehicleId)
    .where('date', '==', dateStr)
    .orderBy('timestamp', 'desc')
    .get();

  const container = $('recent-photos');
  container.innerHTML = '';
  $('today-count').textContent = snapshot.size;
  $('vehicle-photo-count').textContent = `${snapshot.size} photos`;

  if (snapshot.empty) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">📷</div><p>No photos for this date</p></div>';
    return;
  }

  snapshot.forEach(doc => {
    const data = doc.data();
    const item = document.createElement('div');
    item.className = 'photo-grid-item' + (data.protected ? ' photo-kept' : '');
    item.dataset.lightboxInfo = `${data.plate} — ${data.date}`;
    const keepBadge = data.protected ? '<div class="keep-badge">🔒</div>' : '';
    const adminDelete = currentUserRole === 'admin' ? `<button class="photo-delete-btn" data-doc-id="${doc.id}" data-storage-path="${escapeHtml(data.storagePath || '')}" title="Delete photo">✕</button>` : '';
    item.innerHTML = `
      ${keepBadge}
      ${adminDelete}
      <img src="${escapeHtml(data.url)}" alt="Vehicle photo" loading="lazy">
      <div class="photo-time">${data.timestamp ? formatTime(data.timestamp.toDate()) : ''}</div>
    `;
    item.querySelector('img').addEventListener('click', () => openLightbox(data.url, `${data.plate} — ${data.date}`));
    const delBtn = item.querySelector('.photo-delete-btn');
    if (delBtn) {
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!(await confirm('Delete Photo', 'Delete this photo permanently? This cannot be undone.'))) return;
        try {
          const docId = delBtn.dataset.docId;
          const storagePath = delBtn.dataset.storagePath;
          await db.collection('photos').doc(docId).delete();
          if (storagePath) {
            try { await getStorage().ref(storagePath).delete(); } catch (se) { console.warn('Storage delete failed:', se); }
          }
          item.remove();
          toast('Photo deleted.', 'success');
          // Update count
          const remaining = container.querySelectorAll('.photo-grid-item').length;
          $('today-count').textContent = remaining;
          $('vehicle-photo-count').textContent = `${remaining} photos`;
        } catch (err) {
          console.error('Delete photo error:', err);
          toast('Failed to delete photo.', 'error');
        }
      });
    }
    container.appendChild(item);
  });
}

// ================================================================
// DOWNLOAD ALL PHOTOS FOR SELECTED VEHICLE
// ================================================================

$('btn-download-all').addEventListener('click', async () => {
  if (!selectedVehicle) return;

  const vid = selectedVehicle.id;
  const label = `${selectedVehicle.make}_${selectedVehicle.model}`.replace(/\s+/g, '_');
  const dateForDownload = selectedDate;

  showLoading('Fetching photo list...');
  try {
    const snapshot = await db.collection('photos')
      .where('vehicleId', '==', vid)
      .where('date', '==', dateForDownload)
      .orderBy('timestamp', 'desc')
      .get();

    if (snapshot.empty) {
      toast('No photos to download.', 'warning');
      hideLoading();
      return;
    }

    const photos = [];
    snapshot.forEach(doc => photos.push(doc.data()));

    showLoading(`Downloading ${photos.length} photos...`);

    // Download all photo blobs
    const files = [];
    let count = 0;
    for (const photo of photos) {
      try {
        const resp = await fetch(photo.url, { mode: 'cors' });
        if (!resp.ok) throw new Error('fetch ' + resp.status);
        const buf = await resp.arrayBuffer();
        // Re-encode as JPEG to guarantee format compatibility across devices
        const jpegBlob = await reencodeAsJpeg(buf);
        count++;
        const ts = photo.timestamp
          ? photo.timestamp.toDate().toISOString().replace(/[:.]/g, '-')
          : String(count).padStart(3, '0');
        const fileName = `${label}_${dateForDownload}_${ts}.jpg`;
        files.push({ name: fileName, buf: await jpegBlob.arrayBuffer() });
        showLoading(`Downloaded ${count} of ${photos.length}...`);
      } catch (dlErr) {
        console.error('Download error for photo:', photo.url, dlErr);
        count++;
      }
    }

    if (files.length === 0) {
      toast('Download failed — opening photos in new tabs instead. Right-click or long-press to save each.', 'warning');
      for (const photo of photos) { window.open(photo.url, '_blank'); }
      hideLoading();
      return;
    } else if (files.length < photos.length) {
      toast(`${photos.length - files.length} photo(s) could not be downloaded and were skipped.`, 'warning');
    }

    // Mobile: try to share/save all photos at once via native share sheet
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    if (isMobile) {
      hideLoading();

      const shareFiles = files.map(f => new File([new Uint8Array(f.buf)], f.name, { type: 'image/jpeg' }));

      // Try native share first — lets user "Save to Photos" all at once
      if (navigator.canShare && navigator.canShare({ files: shareFiles })) {
        try {
          await navigator.share({ files: shareFiles });
          toast(`${files.length} photos shared!`, 'success');
          return;
        } catch (err) {
          if (err.name === 'AbortError') return; // user cancelled, done
          // Share failed — fall through to gallery
        }
      }

      // Fallback: show gallery with save buttons
      const imageUrls = files.map(f => {
        const blob = new Blob([new Uint8Array(f.buf)], { type: 'image/jpeg' });
        return URL.createObjectURL(blob);
      });

      const overlay = document.createElement('div');
      overlay.id = 'photo-save-overlay';
      overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:#000;z-index:99999;overflow-y:auto;-webkit-overflow-scrolling:touch;';
      overlay.innerHTML = `
        <div style="position:sticky;top:0;background:#000;padding:12px 16px;z-index:1;border-bottom:1px solid #333;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <span style="color:#fff;font-size:17px;font-weight:600;">${files.length} Photos</span>
            <div style="display:flex;gap:8px;">
              <button id="save-gallery-share" style="background:#007AFF;color:#fff;border:none;border-radius:8px;padding:8px 14px;font-size:15px;font-weight:600;">📥 Save All to Photos</button>
              <button id="save-gallery-done" style="background:#333;color:#fff;border:none;border-radius:8px;padding:8px 14px;font-size:15px;font-weight:600;">Done</button>
            </div>
          </div>
          <div style="color:#aaa;font-size:13px;margin-top:6px;">Tap "Save All to Photos" or hold any image → Save</div>
        </div>
        <div id="save-gallery-grid" style="display:grid;grid-template-columns:repeat(2,1fr);gap:4px;padding:4px;"></div>
      `;
      document.body.appendChild(overlay);

      const grid = overlay.querySelector('#save-gallery-grid');
      for (let i = 0; i < imageUrls.length; i++) {
        const cell = document.createElement('div');
        cell.style.cssText = 'position:relative;';
        cell.innerHTML = `
          <img src="${imageUrls[i]}" style="width:100%;display:block;" />
          <a href="${imageUrls[i]}" download="${files[i].name}" style="position:absolute;bottom:4px;right:4px;background:rgba(0,122,255,0.85);color:#fff;border:none;border-radius:6px;padding:4px 8px;font-size:12px;font-weight:600;text-decoration:none;">Save</a>
        `;
        grid.appendChild(cell);
      }

      // "Save All to Photos" button
      overlay.querySelector('#save-gallery-share').addEventListener('click', async () => {
        if (navigator.canShare && navigator.canShare({ files: shareFiles })) {
          try {
            await navigator.share({ files: shareFiles });
            toast(`${files.length} photos saved!`, 'success');
            imageUrls.forEach(u => URL.revokeObjectURL(u));
            document.body.removeChild(overlay);
            return;
          } catch (err) {
            if (err.name === 'AbortError') return;
          }
        }
        // Fallback: trigger individual downloads
        for (let i = 0; i < imageUrls.length; i++) {
          const a = document.createElement('a');
          a.href = imageUrls[i];
          a.download = files[i].name;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
        }
        toast(`${files.length} photos downloading!`, 'success');
      });

      // "Done" button: close overlay and revoke URLs
      overlay.querySelector('#save-gallery-done').addEventListener('click', () => {
        imageUrls.forEach(u => URL.revokeObjectURL(u));
        document.body.removeChild(overlay);
      });
      return;
    }

    // Desktop: bundle into ZIP
    showLoading('Creating ZIP file...');
    const zip = new JSZip();
    for (const f of files) {
      zip.file(f.name, new Uint8Array(f.buf));
    }
    const zipBlob = await zip.generateAsync({ type: 'blob', mimeType: 'application/zip' });
    const zipName = `${label}_${dateForDownload}_${files.length}-photos.zip`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(zipBlob);
    a.download = zipName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);

    toast(`ZIP with ${files.length} photos ready!`, 'success');
  } catch (err) {
    console.error('Download all error:', err);
    toast('Failed to download photos.', 'error');
  } finally {
    hideLoading();
  }
});

// ================================================================
// LIGHTBOX WITH GALLERY NAVIGATION
// ================================================================

let lightboxPhotos = []; // array of { url, info }
let lightboxIndex = 0;

function openLightbox(url, info) {
  // Build gallery from currently visible photo grid
  lightboxPhotos = [];
  document.querySelectorAll('#recent-photos .photo-grid-item img, #admin-photos .photo-grid-item img').forEach(img => {
    const item = img.closest('.photo-grid-item');
    // Get the info from the click handler — store it as data attribute
    lightboxPhotos.push({
      url: img.src,
      info: item.dataset.lightboxInfo || ''
    });
  });

  // Find current index
  lightboxIndex = lightboxPhotos.findIndex(p => p.url === url);
  if (lightboxIndex < 0) {
    lightboxPhotos = [{ url, info }];
    lightboxIndex = 0;
  }

  showLightboxPhoto();
  $('lightbox').style.display = 'flex';
}

function showLightboxPhoto() {
  const photo = lightboxPhotos[lightboxIndex];
  if (!photo) return;
  $('lightbox-img').src = photo.url;
  $('lightbox-info-text').textContent = photo.info;
  $('lightbox').dataset.url = photo.url;
  $('lightbox').dataset.info = photo.info;

  const counter = $('lightbox-counter');
  if (lightboxPhotos.length > 1) {
    counter.textContent = `${lightboxIndex + 1} / ${lightboxPhotos.length}`;
    $('lightbox-prev').style.display = '';
    $('lightbox-next').style.display = '';
  } else {
    counter.textContent = '';
    $('lightbox-prev').style.display = 'none';
    $('lightbox-next').style.display = 'none';
  }
}

function lightboxNav(dir) {
  lightboxIndex += dir;
  if (lightboxIndex < 0) lightboxIndex = lightboxPhotos.length - 1;
  if (lightboxIndex >= lightboxPhotos.length) lightboxIndex = 0;
  showLightboxPhoto();
}

// Re-encode any image buffer as a guaranteed JPEG blob (handles HEIC, PNG, WebP, etc.)
function reencodeAsJpeg(arrayBuf) {
  return new Promise((resolve, reject) => {
    const blob = new Blob([new Uint8Array(arrayBuf)]);
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onerror = () => {
      URL.revokeObjectURL(url);
      // If re-encoding fails, return original as-is (already JPEG from upload)
      resolve(new Blob([new Uint8Array(arrayBuf)], { type: 'image/jpeg' }));
    };
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      canvas.toBlob((result) => {
        resolve(result || new Blob([new Uint8Array(arrayBuf)], { type: 'image/jpeg' }));
      }, 'image/jpeg', 0.95);
    };
    img.src = url;
  });
}

// Save a single photo — share sheet on mobile, direct download on desktop
async function saveOnePhoto(url, name) {
  try {
    const resp = await fetch(url, { mode: 'cors' });
    if (!resp.ok) throw new Error('fetch ' + resp.status);
    const buf = await resp.arrayBuffer();
    // Re-encode as JPEG for guaranteed cross-platform compatibility
    const jpegBlob = await reencodeAsJpeg(buf);
    const fileName = name.replace(/\s+/g, '_').replace(/\.[^.]+$/, '') + '.jpg';

    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    if (isMobile && navigator.canShare) {
      const file = new File([jpegBlob], fileName, { type: 'image/jpeg' });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file] });
        return;
      }
    }

    const a = document.createElement('a');
    a.href = URL.createObjectURL(jpegBlob);
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error('Save photo error:', err);
    // Fallback: open in new tab so user can long-press / right-click to save
    toast('Direct download failed — opening photo in new tab. Right-click or long-press to save.', 'warning');
    window.open(url, '_blank');
  }
}

$('lightbox-save').addEventListener('click', (e) => {
  e.stopPropagation();
  const url = $('lightbox').dataset.url;
  const info = $('lightbox').dataset.info || 'photo';
  saveOnePhoto(url, info);
});

$('lightbox-prev').addEventListener('click', (e) => { e.stopPropagation(); lightboxNav(-1); });
$('lightbox-next').addEventListener('click', (e) => { e.stopPropagation(); lightboxNav(1); });

// Arrow keys
document.addEventListener('keydown', (e) => {
  if ($('lightbox').style.display !== 'flex') return;
  if (e.key === 'ArrowLeft') lightboxNav(-1);
  else if (e.key === 'ArrowRight') lightboxNav(1);
  else if (e.key === 'Escape') { $('lightbox').style.display = 'none'; $('lightbox-img').src = ''; }
});

// Touch swipe — smooth iOS handling with visual slide
(function() {
  let startX = 0, startY = 0, moveX = 0, tracking = false;
  const lb = $('lightbox');
  const img = $('lightbox-img');

  lb.addEventListener('touchstart', (e) => {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    moveX = 0;
    tracking = true;
    img.style.transition = 'none';
  }, { passive: true });

  lb.addEventListener('touchmove', (e) => {
    if (!tracking) return;
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;
    // If mostly horizontal, take over the gesture
    if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) {
      e.preventDefault();
      moveX = dx;
      img.style.transform = `translateX(${dx}px)`;
    }
  }, { passive: false });

  lb.addEventListener('touchend', () => {
    if (!tracking) return;
    tracking = false;
    img.style.transition = 'transform 0.2s ease';
    if (Math.abs(moveX) > 60 && lightboxPhotos.length > 1) {
      // Slide off screen, then swap photo
      const dir = moveX < 0 ? 1 : -1;
      img.style.transform = `translateX(${dir * -window.innerWidth}px)`;
      setTimeout(() => {
        lightboxNav(dir);
        // Slide new photo in from opposite side
        img.style.transition = 'none';
        img.style.transform = `translateX(${dir * window.innerWidth}px)`;
        requestAnimationFrame(() => {
          img.style.transition = 'transform 0.2s ease';
          img.style.transform = 'translateX(0)';
        });
      }, 180);
    } else {
      img.style.transform = 'translateX(0)';
    }
    moveX = 0;
  }, { passive: true });
})();

$('lightbox-close').addEventListener('click', () => {
  $('lightbox').style.display = 'none';
  $('lightbox-img').src = '';
});

$('lightbox').addEventListener('click', (e) => {
  if (e.target === $('lightbox')) {
    $('lightbox').style.display = 'none';
    $('lightbox-img').src = '';
  }
});

// ================================================================
// ADMIN PAGE NAVIGATION
// ================================================================

$('btn-admin').addEventListener('click', () => {
  if (currentUserRole !== 'admin') return;
  showPage('admin');
  loadAdminVehicles();
  loadAdminUsers();
});

$('btn-admin-from-vehicle').addEventListener('click', () => {
  if (currentUserRole !== 'admin') return;
  showPage('admin');
  loadAdminVehicles();
  loadAdminUsers();
});

$('btn-back-dashboard').addEventListener('click', () => {
  showPage('dashboard');
});

$('btn-back-fleet').addEventListener('click', () => {
  selectedVehicle = null;
  showPage('dashboard');
});

$('btn-prev-vehicle').addEventListener('click', () => {
  if (!vehiclesCache.length) return;
  const idx = vehiclesCache.findIndex(v => v.id === selectedVehicle?.id);
  const prevIdx = (idx - 1 + vehiclesCache.length) % vehiclesCache.length;
  openVehiclePage(vehiclesCache[prevIdx].id);
});

$('btn-next-vehicle').addEventListener('click', () => {
  if (!vehiclesCache.length) return;
  const idx = vehiclesCache.findIndex(v => v.id === selectedVehicle?.id);
  const nextIdx = (idx + 1) % vehiclesCache.length;
  openVehiclePage(vehiclesCache[nextIdx].id);
});

$('vehicle-fleet-select').addEventListener('change', function() {
  if (this.value) openVehiclePage(this.value);
});

$('brand-home').addEventListener('click', () => {
  selectedVehicle = null;
  showPage('dashboard');
});
$('brand-home-vehicle').addEventListener('click', () => {
  selectedVehicle = null;
  showPage('dashboard');
});
$('brand-home-admin').addEventListener('click', () => {
  selectedVehicle = null;
  showPage('dashboard');
});

// Location dropdown handlers
$('vehicle-home-location').addEventListener('change', function() {
  $('hnl-parking-row').style.display = this.value === 'HNL' ? '' : 'none';
});

// ================================================================
// PRIVATE TRIP REVENUE CALCULATOR
// ================================================================
function _calcPrivateTripRevenue() {
  const display = $('private-trip-rev-display');
  if (!display) return;
  const startDate = $('private-trip-start-date')?.value;
  const endDate = $('private-trip-end-date')?.value;
  const dailyRate = parseFloat($('private-trip-cost')?.value) || 0;
  const getRate = parseFloat($('private-trip-get')?.value) || 0;
  const dailyTax = parseFloat($('private-trip-daily-tax')?.value) || 0;

  if (!startDate || !endDate || dailyRate === 0) {
    display.textContent = '— (enter dates & daily rate to calculate)';
    display.className = 'private-rev-calc-box';
    return;
  }
  // Count trip days (Turo-style: endDate excluded)
  const start = new Date(startDate + 'T00:00:00');
  const end = new Date(endDate + 'T00:00:00');
  if (end <= start) { display.textContent = '— (end date must be after start date)'; return; }
  const days = Math.round((end - start) / 86400000);
  const rentalRevenue = dailyRate * days;
  const getTaxAmt = rentalRevenue * (getRate / 100);
  const vehicleTaxAmt = dailyTax * days;
  const total = rentalRevenue + getTaxAmt + vehicleTaxAmt;

  display.innerHTML = `<strong>$${total.toFixed(2)}</strong> <span style="color:#6b7280;font-size:0.78rem;">($${dailyRate.toFixed(2)}/day × ${days}d + GET $${getTaxAmt.toFixed(2)} + vehicle tax $${vehicleTaxAmt.toFixed(2)})</span>`;
  display.className = 'private-rev-calc-box active';
}

// Wire up auto-calculation on private trip field changes
['private-trip-start-date','private-trip-end-date','private-trip-cost','private-trip-get','private-trip-daily-tax'].forEach(id => {
  document.addEventListener('change', function(e) {
    if (e.target && e.target.id === id) _calcPrivateTripRevenue();
  });
  document.addEventListener('input', function(e) {
    if (e.target && e.target.id === id) _calcPrivateTripRevenue();
  });
});

$('vehicle-trip-status').addEventListener('change', function() {
  const v = this.value;
  $('trip-return-row').style.display = (v === 'on-trip' || v === 'repair-shop') ? '' : 'none';
  $('on-trip-revenue-row').style.display = (v === 'on-trip' || v === 'scheduled') ? '' : 'none';
  $('repair-parts-row').style.display = v === 'repair-shop' ? '' : 'none';
  $('trip-scheduled-row').style.display = v === 'scheduled' ? '' : 'none';
  $('trip-expected-end-row').style.display = v === 'scheduled' ? '' : 'none';
  $('private-trip-row').style.display = v === 'private-trip' ? '' : 'none';
  // Hide needs-cleaning btn if switching to trip/repair
  const needsCleanBtn = $('btn-needs-cleaning');
  if (needsCleanBtn && selectedVehicle) {
    const showCleanBtn = v !== 'on-trip' && v !== 'repair-shop' && v !== 'private-trip' && !selectedVehicle.needsCleaning;
    needsCleanBtn.style.display = showCleanBtn ? '' : 'none';
  }
});

// Needs Cleaning button on vehicle page
$('btn-needs-cleaning').addEventListener('click', async () => {
  if (!selectedVehicle) return;
  try {
    await db.collection('vehicles').doc(selectedVehicle.id).update({
      needsCleaning: true,
      needsDamageCheck: true,
      cleaningFlaggedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    selectedVehicle.needsCleaning = true;
    selectedVehicle.needsDamageCheck = true;
    const cached = vehiclesCache.find(v => v.id === selectedVehicle.id);
    if (cached) { cached.needsCleaning = true; cached.needsDamageCheck = true; }
    $('btn-needs-cleaning').style.display = 'none';
    toast('Flagged for cleaning! \u2713', 'success');
  } catch (err) {
    console.error('Flag cleaning error:', err);
    toast('Failed to flag for cleaning.', 'error');
  }
});

$('btn-save-location').addEventListener('click', async () => {
  if (!selectedVehicle) return;
  const homeLocation = $('vehicle-home-location').value;
  const tripStatus = $('vehicle-trip-status').value;
  const tripReturnVal = $('vehicle-trip-return').value;
  const repairShopName = $('repair-shop-name').value.trim();
  const repairOrderNumber = $('repair-order-number').value.trim();
  const repairPartsEta = $('repair-parts-eta').value;
  const repairCostRaw = $('repair-cost').value.trim();
  const repairCost = repairCostRaw !== '' ? (parseFloat(repairCostRaw) || 0) : null;
  const repairDescription = $('repair-description').value.trim();
  // HNL parking
  const parkingRow = homeLocation === 'HNL' ? ($('hnl-parking-row-val').value.trim() || null) : null;
  const parkingLevel = homeLocation === 'HNL' ? ($('hnl-parking-level').value.trim() || null) : null;

  if (!homeLocation) {
    toast('Please select a home location.', 'warning');
    return;
  }

  const updateData = { homeLocation, tripStatus,
    parkingRow: parkingRow || firebase.firestore.FieldValue.delete(),
    parkingLevel: parkingLevel || firebase.firestore.FieldValue.delete(),
  };

  // Compute the display location for backward compat
  if (tripStatus === 'scheduled') {
    updateData.location = homeLocation;
    const schedVal = getDTValue('vehicle-trip-scheduled-start-date', 'vehicle-trip-scheduled-start-time');
    updateData.tripScheduledStart = schedVal ? firebase.firestore.Timestamp.fromDate(new Date(schedVal)) : firebase.firestore.FieldValue.delete();
    const endVal = getDTValue('vehicle-trip-expected-end-date', 'vehicle-trip-expected-end-time');
    updateData.tripExpectedEnd = endVal ? firebase.firestore.Timestamp.fromDate(new Date(endVal)) : firebase.firestore.FieldValue.delete();
    updateData.tripReturnDate = firebase.firestore.FieldValue.delete();
    updateData.repairShopName = firebase.firestore.FieldValue.delete();
    updateData.repairOrderNumber = firebase.firestore.FieldValue.delete();
    updateData.repairPartsEta = firebase.firestore.FieldValue.delete();
    // clear private fields
    ['privateTripCustomerName','privateTripCustomerPhone','privateTripCustomerEmail',
     'privateTripDailyRate','privateTripGET','privateTripDailyTax'].forEach(k => {
      updateData[k] = firebase.firestore.FieldValue.delete();
    });
    // Scheduled trip revenue (Turo payout — added when received)
    const schedRev = parseFloat($('on-trip-revenue').value);
    updateData.tripRevenue = isNaN(schedRev) ? firebase.firestore.FieldValue.delete() : schedRev;
    const schedExtrasList = getExtrasList('on-trip-extras-list');
    updateData.extras = schedExtrasList.length > 0 ? schedExtrasList : firebase.firestore.FieldValue.delete();
    updateData.extrasType = firebase.firestore.FieldValue.delete();
    updateData.extrasAmount = firebase.firestore.FieldValue.delete();
  } else if (tripStatus === 'private-trip') {
    updateData.location = 'Private Trip';
    const ptStart = getDTValue('private-trip-start-date', 'private-trip-start-time');
    const ptEnd = getDTValue('private-trip-end-date', 'private-trip-end-time');
    const ptReturn = $('private-trip-return').value;
    updateData.tripScheduledStart = ptStart ? firebase.firestore.Timestamp.fromDate(new Date(ptStart)) : firebase.firestore.FieldValue.delete();
    updateData.tripExpectedEnd = ptEnd ? firebase.firestore.Timestamp.fromDate(new Date(ptEnd)) : firebase.firestore.FieldValue.delete();
    updateData.tripReturnDate = ptReturn ? firebase.firestore.Timestamp.fromDate(new Date(ptReturn + ':00-10:00')) : firebase.firestore.FieldValue.delete();
    updateData.repairShopName = firebase.firestore.FieldValue.delete();
    updateData.repairOrderNumber = firebase.firestore.FieldValue.delete();
    updateData.repairPartsEta = firebase.firestore.FieldValue.delete();
    updateData.repairCost = firebase.firestore.FieldValue.delete();
    updateData.repairDescription = firebase.firestore.FieldValue.delete();
    updateData.privateTripCustomerName = $('private-customer-name').value.trim() || null;
    updateData.privateTripCustomerPhone = $('private-customer-phone').value.trim() || null;
    updateData.privateTripCustomerEmail = $('private-customer-email').value.trim() || null;
    updateData.privateTripDailyRate = parseFloat($('private-trip-cost').value) || null;
    updateData.privateTripGET = parseFloat($('private-trip-get').value) || null;
    updateData.privateTripDailyTax = parseFloat($('private-trip-daily-tax').value) || null;
    // Calculate private trip revenue
    const ptStartDate = $('private-trip-start-date')?.value;
    const ptEndDate = $('private-trip-end-date')?.value;
    const ptDailyRate = parseFloat($('private-trip-cost').value) || 0;
    const ptGET = parseFloat($('private-trip-get').value) || 0;
    const ptDailyTax = parseFloat($('private-trip-daily-tax').value) || 0;
    let calcRevenue = null;
    if (ptStartDate && ptEndDate && ptDailyRate > 0) {
      const ptDays = Math.round((new Date(ptEndDate + 'T00:00:00') - new Date(ptStartDate + 'T00:00:00')) / 86400000);
      if (ptDays > 0) {
        calcRevenue = (ptDailyRate * ptDays) * (1 + ptGET / 100) + (ptDailyTax * ptDays);
      }
    }
    // Override trumps calculated
    const ptRevOverride = parseFloat($('private-trip-revenue-override').value);
    const privateTripRevenue = !isNaN(ptRevOverride) && ptRevOverride > 0 ? ptRevOverride : calcRevenue;
    updateData.privateTripRevenueOverride = !isNaN(ptRevOverride) && ptRevOverride > 0 ? ptRevOverride : firebase.firestore.FieldValue.delete();
    updateData.tripRevenue = privateTripRevenue != null ? privateTripRevenue : firebase.firestore.FieldValue.delete();
    const ptExtrasList = getExtrasList('private-trip-extras-list');
    updateData.extras = ptExtrasList.length > 0 ? ptExtrasList : firebase.firestore.FieldValue.delete();
    updateData.extrasType = firebase.firestore.FieldValue.delete();
    updateData.extrasAmount = firebase.firestore.FieldValue.delete();
    // Handle contract upload
    const contractFile = $('private-contract-upload').files[0];
    if (contractFile) {
      try {
        const st = getStorage();
        const ref = st.ref('vehicles/' + (selectedVehicle.plate || selectedVehicle.id) + '/contracts/' + Date.now() + '_' + contractFile.name);
        await ref.put(contractFile);
        updateData.privateTripContractUrl = await ref.getDownloadURL();
        $('private-contract-upload').value = '';
      } catch(e) { console.warn('Contract upload failed', e); }
    }
  } else if (tripStatus === 'on-trip') {
    updateData.location = 'On Trip';
    updateData.tripScheduledStart = firebase.firestore.FieldValue.delete();
    updateData.tripExpectedEnd = firebase.firestore.FieldValue.delete();
    if (tripReturnVal) {
      // Append HST offset so the value is always parsed as Hawaii time (UTC-10), not the user's local timezone
      updateData.tripReturnDate = firebase.firestore.Timestamp.fromDate(new Date(tripReturnVal + ':00-10:00'));
    } else {
      updateData.tripReturnDate = firebase.firestore.FieldValue.delete();
    }
    // On-trip revenue
    const onTripRev = parseFloat($('on-trip-revenue').value);
    updateData.tripRevenue = isNaN(onTripRev) ? firebase.firestore.FieldValue.delete() : onTripRev;
    const onExtrasList = getExtrasList('on-trip-extras-list');
    updateData.extras = onExtrasList.length > 0 ? onExtrasList : firebase.firestore.FieldValue.delete();
    updateData.extrasType = firebase.firestore.FieldValue.delete();
    updateData.extrasAmount = firebase.firestore.FieldValue.delete();
    updateData.repairShopName = firebase.firestore.FieldValue.delete();
    updateData.repairOrderNumber = firebase.firestore.FieldValue.delete();
    updateData.repairPartsEta = firebase.firestore.FieldValue.delete();
    updateData.repairCost = firebase.firestore.FieldValue.delete();
    updateData.repairDescription = firebase.firestore.FieldValue.delete();
  } else if (tripStatus === 'repair-shop') {
    updateData.location = 'Repair Shop';
    updateData.tripScheduledStart = firebase.firestore.FieldValue.delete();
    updateData.tripExpectedEnd = firebase.firestore.FieldValue.delete();
    if (tripReturnVal) {
      // Append HST offset so the value is always parsed as Hawaii time (UTC-10), not the user's local timezone
      updateData.tripReturnDate = firebase.firestore.Timestamp.fromDate(new Date(tripReturnVal + ':00-10:00'));
    } else {
      updateData.tripReturnDate = firebase.firestore.FieldValue.delete();
    }
    updateData.repairShopName = repairShopName || firebase.firestore.FieldValue.delete();
    updateData.repairOrderNumber = repairOrderNumber || firebase.firestore.FieldValue.delete();
    updateData.repairPartsEta = repairPartsEta || firebase.firestore.FieldValue.delete();
    if (repairPartsEta) {
      updateData.repairPartsEta = repairPartsEta;
    }
    updateData.repairCost = repairCost != null ? repairCost : firebase.firestore.FieldValue.delete();
    updateData.repairDescription = repairDescription || firebase.firestore.FieldValue.delete();
  } else {
    updateData.location = homeLocation;
    updateData.tripScheduledStart = firebase.firestore.FieldValue.delete();
    updateData.tripExpectedEnd = firebase.firestore.FieldValue.delete();
    updateData.tripReturnDate = firebase.firestore.FieldValue.delete();
    updateData.repairShopName = firebase.firestore.FieldValue.delete();
    updateData.repairOrderNumber = firebase.firestore.FieldValue.delete();
    updateData.repairPartsEta = firebase.firestore.FieldValue.delete();
  }

  // If vehicle was on-trip, private-trip, or repair-shop and now returning home, flag for cleaning
  // (but NEVER set cleaning/damage flags on excluded vehicles)
  const wasAtRepair = selectedVehicle.tripStatus === 'repair-shop';
  const wasOnTrip = ['on-trip', 'private-trip'].includes(selectedVehicle.tripStatus);
  const nowHome = tripStatus === 'home';
  const nowReturnFromRepair = wasAtRepair && tripStatus !== 'repair-shop';
  if (((wasOnTrip && nowHome) || nowReturnFromRepair) && !selectedVehicle.photoExcluded) {
    updateData.needsCleaning = true;
    updateData.needsDamageCheck = true;
    if (homeLocation === '1585 Kapiolani') updateData.needsParking = true;
    if (wasOnTrip && nowHome) {
      // Normal return: 2h grace before photo check fires
      updateData.cleaningFlaggedAt = firebase.firestore.FieldValue.serverTimestamp();
    } else {
      // Repair shop return: no grace — photos are definitely stale, flag immediately
      updateData.cleaningFlaggedAt = firebase.firestore.FieldValue.delete();
    }
  }
  // Auto-clear trip-scoped photoExcluded whenever vehicle returns home
  if (nowHome && selectedVehicle.photoExcluded) {
    updateData.photoExcluded = firebase.firestore.FieldValue.delete();
  }

  try {
    await db.collection('vehicles').doc(selectedVehicle.id).update(updateData);
    // Update local cache
    Object.assign(selectedVehicle, { homeLocation, tripStatus, location: updateData.location });
    if (tripReturnVal && (tripStatus === 'on-trip' || tripStatus === 'repair-shop')) {
      selectedVehicle.tripReturnDate = firebase.firestore.Timestamp.fromDate(new Date(tripReturnVal + ':00-10:00'));
    } else {
      delete selectedVehicle.tripReturnDate;
    }
    if (tripStatus === 'repair-shop') {
      selectedVehicle.repairShopName = repairShopName || '';
      selectedVehicle.repairOrderNumber = repairOrderNumber || '';
      selectedVehicle.repairPartsEta = repairPartsEta || '';
      if (repairCost != null) selectedVehicle.repairCost = repairCost;
      if (repairDescription) selectedVehicle.repairDescription = repairDescription;
    } else {
      delete selectedVehicle.repairShopName;
      delete selectedVehicle.repairOrderNumber;
      delete selectedVehicle.repairPartsEta;
      delete selectedVehicle.repairCost;
      delete selectedVehicle.repairDescription;
    }
    if ((wasOnTrip && nowHome) || nowReturnFromRepair) {
      selectedVehicle.needsCleaning = true;
      selectedVehicle.needsDamageCheck = true;
      if (homeLocation === '1585 Kapiolani') selectedVehicle.needsParking = true;
      if (nowReturnFromRepair) delete selectedVehicle.cleaningFlaggedAt;
    }
    if (nowHome && selectedVehicle.photoExcluded) {
      delete selectedVehicle.photoExcluded;
      const cachedV = vehiclesCache.find(v => v.id === selectedVehicle.id);
      if (cachedV) delete cachedV.photoExcluded;
    }
    const cached = vehiclesCache.find(v => v.id === selectedVehicle.id);
    if (cached) Object.assign(cached, selectedVehicle);
    toast('Location saved!', 'success');
    renderFleetDashboard();

    // ── Auto-log maintenance record when returning from repair shop ──
    if (nowReturnFromRepair) {
      const prevShopName = selectedVehicle.repairShopName || repairShopName || '';
      const prevDescription = selectedVehicle.repairDescription || repairDescription || '';
      const prevCost = selectedVehicle.repairCost ?? repairCost;
      const maintRecord = {
        vehicleId: selectedVehicle.id,
        plate: selectedVehicle.plate || '',
        serviceType: prevDescription || 'Shop Repair',
        date: todayDateString(),
        cost: prevCost != null ? prevCost : null,
        location: prevShopName || null,
        notes: repairOrderNumber ? ('Order/Tracking: ' + repairOrderNumber) : null,
        autoCreatedFromRepairShop: true,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        createdBy: currentUser.uid,
      };
      // Remove nulls
      Object.keys(maintRecord).forEach(k => { if (maintRecord[k] == null) delete maintRecord[k]; });
      try {
        await db.collection('maintenance').add(maintRecord);
        toast('Maintenance record auto-logged from repair shop ✓', 'success');
      } catch(mErr) { console.warn('Auto-maintenance log error:', mErr); }
    }

    // Log trip to tripLogs for productivity tracking
    if (tripStatus === 'scheduled' || tripStatus === 'private-trip') {
      const logStart = tripStatus === 'scheduled'
        ? getDTValue('vehicle-trip-scheduled-start-date', 'vehicle-trip-scheduled-start-time')
        : getDTValue('private-trip-start-date', 'private-trip-start-time');
      const logEnd = tripStatus === 'scheduled'
        ? getDTValue('vehicle-trip-expected-end-date', 'vehicle-trip-expected-end-time')
        : getDTValue('private-trip-end-date', 'private-trip-end-time');
      if (logStart && logEnd) {
        const startDate = logStart.slice(0, 10);
        const endDate = logEnd.slice(0, 10);
        const logKey = selectedVehicle.id + '_' + startDate + '_' + endDate;
        try {
          const tripLogData = {
            vehicleId: selectedVehicle.id,
            vehiclePlate: selectedVehicle.plate || '',
            vehicleMakeModel: ((selectedVehicle.make || '') + ' ' + (selectedVehicle.model || '')).trim(),
            startDate,
            endDate,
            tripType: tripStatus,
            loggedAt: firebase.firestore.FieldValue.serverTimestamp(),
            loggedBy: currentUser.uid,
            loggedByName: currentUser.displayName || currentUser.email,
          };
          // Save revenue to tripLog (private-trip: calculated, scheduled: entered payout)
          if ((tripStatus === 'private-trip' || tripStatus === 'scheduled') && updateData.tripRevenue != null && typeof updateData.tripRevenue === 'number') {
            tripLogData.revenue = updateData.tripRevenue;
          }
          if (Array.isArray(updateData.extras) && updateData.extras.length > 0) {
            tripLogData.extras = updateData.extras;
          }
          await db.collection('tripLogs').doc(logKey).set(tripLogData, { merge: true });
        } catch(e) { console.warn('tripLog write error', e); }
      }
    } else if (tripStatus === 'on-trip' && selectedVehicle.tripStatus !== 'scheduled') {
      // Direct on-trip (not auto-started from scheduled) — log it so it shows in productivity report
      const startDate = todayDateString();
      const endDate = tripReturnVal ? tripReturnVal.slice(0, 10) : startDate;
      const logKey = selectedVehicle.id + '_' + startDate + '_direct_trip';
      try {
        const onTripRevSave = typeof updateData.tripRevenue === 'number' ? updateData.tripRevenue : null;
        const onTripLogData = {
          vehicleId: selectedVehicle.id,
          vehiclePlate: selectedVehicle.plate || '',
          vehicleMakeModel: ((selectedVehicle.make || '') + ' ' + (selectedVehicle.model || '')).trim(),
          startDate,
          endDate,
          tripType: 'on-trip',
          loggedAt: firebase.firestore.FieldValue.serverTimestamp(),
          loggedBy: currentUser.uid,
          loggedByName: currentUser.displayName || currentUser.email,
        };
        if (onTripRevSave != null) onTripLogData.revenue = onTripRevSave;
        if (Array.isArray(updateData.extras) && updateData.extras.length > 0) {
          onTripLogData.extras = updateData.extras;
        }
        await db.collection('tripLogs').doc(logKey).set(onTripLogData, { merge: true });
      } catch(e) { console.warn('tripLog write error (on-trip)', e); }
    }
  } catch (err) {
    console.error('Save location error:', err);
    toast('Failed to save location.', 'error');
  }
});

// ================================================================
// VEHICLE RETURNED - mark overdue trip vehicle as back home
// ================================================================
window.vehicleReturned = async function(vehicleId) {
  const v = vehiclesCache.find(x => x.id === vehicleId);
  if (!v) return;
  const plate = v.plate || vehicleId;
  const ok = await confirm('Vehicle Returned', `Mark ${plate} as returned to ${v.homeLocation || 'home'}? This will prompt for cleaning and photos.`);
  if (!ok) return;
  try {
    const updateData = {
      tripStatus: 'home',
      tripReturnDate: firebase.firestore.FieldValue.delete(),
      needsCleaning: true,
      needsDamageCheck: true,
      cleaningFlaggedAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    if (v.homeLocation === '1585 Kapiolani') updateData.needsParking = true;
    await db.collection('vehicles').doc(vehicleId).update(updateData);
    // Update local cache
    Object.assign(v, {
      tripStatus: 'home',
      needsCleaning: true,
      needsDamageCheck: true,
      cleaningFlaggedAt: { toDate: () => new Date() }
    });
    if (v.homeLocation === '1585 Kapiolani') v.needsParking = true;
    delete v.tripReturnDate;
    toast(`${plate} marked as returned — please complete cleaning & photos.`, 'success');
    renderFleetDashboard();
    renderLocationsWidget();
  } catch (err) {
    console.error('Vehicle returned error:', err);
    toast('Failed to update vehicle status.', 'error');
  }
};

// Locations button — scroll to Locations widget
$('btn-locations').addEventListener('click', () => {
  const widget = $('locations-widget');
  if (widget) {
    widget.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
});

// Tab switching
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', function () {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    this.classList.add('active');
    $(this.dataset.tab).classList.add('active');
  });
});

// ================================================================
// ADMIN: VEHICLE MANAGEMENT
// ================================================================

$('add-vehicle-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (currentUserRole !== 'admin') return;

  const plate = $('v-plate').value.trim().toUpperCase();
  const make = $('v-make').value.trim();
  const model = $('v-model').value.trim();
  const year = $('v-year').value ? parseInt($('v-year').value) : null;
  const color = $('v-color').value.trim() || null;
  const photoFile = $('v-photo').files[0] || null;

  if (!plate || !make || !model) {
    toast('Please fill in plate, make, and model.', 'warning');
    return;
  }

  // Check for duplicate plate
  const existing = vehiclesCache.find(v => v.plate.toUpperCase() === plate);
  if (existing) {
    toast('A vehicle with that plate already exists.', 'error');
    return;
  }

  showLoading('Adding vehicle...');
  try {
    const docData = {
      plate, make, model, year, color,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      createdBy: currentUser.uid,
    };
    const docRef = await db.collection('vehicles').add(docData);

    // Upload default photo if provided
    if (photoFile) {
      await uploadVehicleDefaultImage(docRef.id, photoFile);
    }

    toast(`Vehicle ${plate} added!`, 'success');
    $('add-vehicle-form').reset();
    $('v-photo-preview').style.display = 'none';
    await loadVehicles();
    loadAdminVehicles();
  } catch (err) {
    console.error('Add vehicle error:', err);
    toast('Failed to add vehicle.', 'error');
  } finally {
    hideLoading();
  }
});

// Preview photo in add-vehicle form
$('v-photo').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) {
    $('v-photo-preview-img').src = URL.createObjectURL(file);
    $('v-photo-preview').style.display = 'block';
  } else {
    $('v-photo-preview').style.display = 'none';
  }
});

function loadAdminVehicles() {
  const list = $('vehicles-list');
  $('vehicle-count').textContent = vehiclesCache.length;

  if (!vehiclesCache.length) {
    list.innerHTML = '<div class="empty-state"><div class="empty-icon">🚗</div><p>No vehicles added yet</p></div>';
    return;
  }

  list.innerHTML = vehiclesCache.map(v => {
    const hasPhoto = v.defaultImageUrl ? `<img src="${escapeHtml(v.defaultImageUrl)}" class="v-list-thumb" alt="">` : '<div class="v-list-thumb-empty">📷</div>';
    const excludedBadge = v.photoExcluded ? '<span style="font-size:0.75rem;background:#fed7aa;color:#9a3412;padding:1px 6px;border-radius:4px;margin-left:6px;">🚫 Excluded</span>' : '';
    return `
    <div class="data-list-item">
      <div class="v-list-thumb-wrap">${hasPhoto}</div>
      <div class="item-info">
        <div class="item-title">${escapeHtml(v.plate)}${excludedBadge}</div>
        <div class="item-subtitle">${escapeHtml(v.make)} ${escapeHtml(v.model)}${v.year ? ` (${v.year})` : ''}${v.color ? ` - ${escapeHtml(v.color)}` : ''}</div>
      </div>
      <div class="item-actions">
        <button class="btn btn-sm btn-outline" onclick="openEditVehicle('${v.id}')">Edit</button>
        <button class="btn btn-sm btn-danger" onclick="deleteVehicle('${v.id}', '${escapeHtml(v.plate)}')">Delete</button>
      </div>
    </div>`;
  }).join('');

  // Render excluded vehicles list
  const excludedEl = $('excluded-vehicles-list');
  if (excludedEl) {
    const excluded = vehiclesCache.filter(v => v.photoExcluded);
    if (!excluded.length) {
      excludedEl.innerHTML = '<p class="hint">No excluded vehicles.</p>';
    } else {
      excludedEl.innerHTML = excluded.map(v => `
        <div class="data-list-item">
          <div class="item-info">
            <div class="item-title">${escapeHtml(v.plate)} <span style="font-size:0.8rem;color:#9a3412;">🚫 Excluded</span></div>
            <div class="item-subtitle">${escapeHtml(v.make)} ${escapeHtml(v.model)}${v.year ? ` (${v.year})` : ''}</div>
          </div>
          <div class="item-actions">
            <button class="btn btn-sm btn-outline" onclick="openEditVehicle('${v.id}')">Edit</button>
          </div>
        </div>`).join('');
    }
  }
}

window.deleteVehicle = async function (vehicleId, plate) {
  if (currentUserRole !== 'admin') return;
  const ok = await confirm('Delete Vehicle', `Are you sure you want to delete ${plate}? This will NOT delete its photos from storage.`);
  if (!ok) return;

  showLoading('Deleting vehicle...');
  try {
    await db.collection('vehicles').doc(vehicleId).delete();
    toast(`Vehicle ${plate} deleted.`, 'success');
    await loadVehicles();
    loadAdminVehicles();
  } catch (err) {
    console.error('Delete vehicle error:', err);
    toast('Failed to delete vehicle.', 'error');
  } finally {
    hideLoading();
  }
};

// ================================================================
// SHARED: Upload default vehicle image
// ================================================================

async function uploadVehicleDefaultImage(vehicleId, file) {
  const st = getStorage();
  if (!st) throw new Error('Storage not available');

  const resized = await compressImage(file, 2560, 0.92);
  const storagePath = `vehicles/${vehicleId}/default-image.jpg`;
  const ref = st.ref(storagePath);
  await ref.put(resized, { contentType: 'image/jpeg' });
  const downloadURL = await ref.getDownloadURL();

  await db.collection('vehicles').doc(vehicleId).update({
    defaultImageUrl: downloadURL,
    defaultImagePath: storagePath
  });

  // Update cache
  const cached = vehiclesCache.find(v => v.id === vehicleId);
  if (cached) cached.defaultImageUrl = downloadURL;

  return downloadURL;
}

// ================================================================
// ADMIN: EDIT VEHICLE
// ================================================================

window.openEditVehicle = function (vehicleId) {
  const v = vehiclesCache.find(x => x.id === vehicleId);
  if (!v) return;

  $('ev-id').value = v.id;
  $('ev-plate').value = v.plate || '';
  $('ev-make').value = v.make || '';
  $('ev-model').value = v.model || '';
  $('ev-year').value = v.year || '';
  $('ev-color').value = v.color || '';
  $('ev-photo').value = '';
  $('ev-photo-preview').style.display = 'none';

  // Exclude checkbox — only matthew.fetterman@gmail.com may toggle
  const canExcludeEdit = !!(currentUser && currentUser.email && currentUser.email.toLowerCase() === 'matthew.fetterman@gmail.com');
  const excludeChk = $('ev-photo-excluded');
  if (excludeChk) {
    excludeChk.checked = !!v.photoExcluded;
    excludeChk.disabled = !canExcludeEdit;
    excludeChk.closest('.form-group') && (excludeChk.closest('.form-group').style.opacity = canExcludeEdit ? '' : '0.5');
    excludeChk.closest('[style]') && (excludeChk.parentElement.style.cursor = canExcludeEdit ? 'pointer' : 'not-allowed');
  }

  // Show current default photo if exists
  if (v.defaultImageUrl) {
    $('ev-photo-current-img').src = v.defaultImageUrl;
    $('ev-photo-current').style.display = 'flex';
  } else {
    $('ev-photo-current').style.display = 'none';
  }

  $('edit-vehicle-overlay').style.display = 'flex';
};

$('btn-edit-close').addEventListener('click', () => {
  $('edit-vehicle-overlay').style.display = 'none';
});

$('btn-edit-cancel').addEventListener('click', () => {
  $('edit-vehicle-overlay').style.display = 'none';
});

$('edit-vehicle-overlay').addEventListener('click', (e) => {
  if (e.target === $('edit-vehicle-overlay')) {
    $('edit-vehicle-overlay').style.display = 'none';
  }
});

// Preview photo in edit form
$('ev-photo').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) {
    $('ev-photo-preview-img').src = URL.createObjectURL(file);
    $('ev-photo-preview').style.display = 'block';
  } else {
    $('ev-photo-preview').style.display = 'none';
  }
});

// Remove current photo
$('btn-ev-remove-photo').addEventListener('click', async () => {
  const vehicleId = $('ev-id').value;
  if (!vehicleId) return;
  const ok = await confirm('Remove Photo', 'Remove the default photo for this vehicle?');
  if (!ok) return;

  try {
    await db.collection('vehicles').doc(vehicleId).update({
      defaultImageUrl: firebase.firestore.FieldValue.delete(),
      defaultImagePath: firebase.firestore.FieldValue.delete()
    });
    const cached = vehiclesCache.find(v => v.id === vehicleId);
    if (cached) {
      delete cached.defaultImageUrl;
      delete cached.defaultImagePath;
    }
    $('ev-photo-current').style.display = 'none';
    toast('Photo removed.', 'success');
    loadAdminVehicles();
  } catch (err) {
    console.error('Remove photo error:', err);
    toast('Failed to remove photo.', 'error');
  }
});

// Save edited vehicle
$('edit-vehicle-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (currentUserRole !== 'admin') return;

  const vehicleId = $('ev-id').value;
  const plate = $('ev-plate').value.trim().toUpperCase();
  const make = $('ev-make').value.trim();
  const model = $('ev-model').value.trim();
  const year = $('ev-year').value ? parseInt($('ev-year').value) : null;
  const color = $('ev-color').value.trim() || null;
  const photoFile = $('ev-photo').files[0] || null;
  const canExcludeOnSave = !!(currentUser && currentUser.email && currentUser.email.toLowerCase() === 'matthew.fetterman@gmail.com');
  const photoExcluded = canExcludeOnSave ? $('ev-photo-excluded').checked : !!(vehiclesCache.find(v => v.id === vehicleId)?.photoExcluded);

  if (!plate || !make || !model) {
    toast('Please fill in plate, make, and model.', 'warning');
    return;
  }

  // Check for duplicate plate (exclude current vehicle)
  const existing = vehiclesCache.find(v => v.plate.toUpperCase() === plate && v.id !== vehicleId);
  if (existing) {
    toast('Another vehicle already has that plate.', 'error');
    return;
  }

  showLoading('Saving changes...');
  try {
    await db.collection('vehicles').doc(vehicleId).update({
      plate, make, model, year, color, photoExcluded
    });

    if (photoFile) {
      await uploadVehicleDefaultImage(vehicleId, photoFile);
    }

    toast('Vehicle updated!', 'success');
    $('edit-vehicle-overlay').style.display = 'none';
    await loadVehicles();
    loadAdminVehicles();
  } catch (err) {
    console.error('Edit vehicle error:', err);
    toast('Failed to save changes.', 'error');
  } finally {
    hideLoading();
  }
});

// ================================================================
// ADMIN: PHOTO MANAGEMENT
// ================================================================

$('btn-load-photos').addEventListener('click', loadAdminPhotos);

async function loadAdminPhotos() {
  if (currentUserRole !== 'admin') return;

  const vehicleId = $('admin-vehicle-select').value;
  const dateFilter = $('admin-date-filter').value;

  if (!vehicleId) {
    toast('Please select a vehicle.', 'warning');
    return;
  }

  showLoading('Loading photos...');
  try {
    let query = db.collection('photos').where('vehicleId', '==', vehicleId);
    if (dateFilter) {
      query = query.where('date', '==', dateFilter);
    }
    query = query.orderBy('timestamp', 'desc');

    const snapshot = await query.get();
    const container = $('admin-photos');
    container.innerHTML = '';
    selectedAdminPhotos.clear();

    $('admin-photo-count').textContent = `${snapshot.size} photos`;
    $('btn-delete-selected').style.display = snapshot.size > 0 ? '' : 'none';
    $('btn-select-all').style.display = snapshot.size > 0 ? '' : 'none';
    $('btn-keep-selected').style.display = snapshot.size > 0 ? '' : 'none';
    $('btn-unkeep-selected').style.display = snapshot.size > 0 ? '' : 'none';

    if (snapshot.empty) {
      container.innerHTML = '<div class="empty-state"><div class="empty-icon">📷</div><p>No photos found</p></div>';
      hideLoading();
      return;
    }

    snapshot.forEach(doc => {
      const data = doc.data();
      const item = document.createElement('div');
      item.className = 'photo-grid-item' + (data.protected ? ' photo-kept' : '');
      item.dataset.id = doc.id;
      item.dataset.storagePath = data.storagePath || '';
      item.dataset.protected = data.protected ? '1' : '0';
      item.dataset.lightboxInfo = `${data.plate || ''} — ${data.date}`;
      const keepBadge = data.protected ? '<div class="keep-badge">🔒 Kept</div>' : '';
      item.innerHTML = `
        ${keepBadge}
        <img src="${escapeHtml(data.url)}" alt="Vehicle photo" loading="lazy">
        <div class="photo-time">${data.date}${data.timestamp ? ' ' + formatTime(data.timestamp.toDate()) : ''}</div>
      `;
      item.addEventListener('click', (e) => {
        if (e.shiftKey || e.ctrlKey || e.metaKey || container.classList.contains('selecting')) {
          // Toggle selection
          item.classList.toggle('selected');
          if (item.classList.contains('selected')) {
            selectedAdminPhotos.add(doc.id);
          } else {
            selectedAdminPhotos.delete(doc.id);
          }
          updateDeleteBtn();
        } else {
          // Toggle selection on mobile (no modifier keys)
          item.classList.toggle('selected');
          if (item.classList.contains('selected')) {
            selectedAdminPhotos.add(doc.id);
          } else {
            selectedAdminPhotos.delete(doc.id);
          }
          updateDeleteBtn();
        }
      });
      container.appendChild(item);
    });
  } catch (err) {
    console.error('Load photos error:', err);
    toast('Failed to load photos. Check Firestore indexes.', 'error');
  } finally {
    hideLoading();
  }
}

function updateDeleteBtn() {
  const count = selectedAdminPhotos.size;
  $('btn-delete-selected').textContent = count > 0 ? `Delete Selected (${count})` : 'Delete Selected';
}

$('btn-select-all').addEventListener('click', () => {
  const items = document.querySelectorAll('#admin-photos .photo-grid-item');
  const allSelected = selectedAdminPhotos.size === items.length;
  items.forEach(item => {
    if (allSelected) {
      item.classList.remove('selected');
      selectedAdminPhotos.delete(item.dataset.id);
    } else {
      item.classList.add('selected');
      selectedAdminPhotos.add(item.dataset.id);
    }
  });
  updateDeleteBtn();
  $('btn-select-all').textContent = allSelected ? 'Select All' : 'Deselect All';
});

$('btn-delete-selected').addEventListener('click', async () => {
  if (currentUserRole !== 'admin') return;
  if (selectedAdminPhotos.size === 0) {
    toast('No photos selected.', 'warning');
    return;
  }

  const ok = await confirm('Delete Photos', `Delete ${selectedAdminPhotos.size} selected photo(s)? This cannot be undone.`);
  if (!ok) return;

  showLoading('Deleting photos...');
  try {
    const deletePromises = [];
    const items = document.querySelectorAll('#admin-photos .photo-grid-item.selected');

    for (const item of items) {
      const docId = item.dataset.id;
      const storagePath = item.dataset.storagePath;

      // Delete from Firestore
      deletePromises.push(db.collection('photos').doc(docId).delete());

      // Delete from Storage
      if (storagePath) {
        const st = getStorage();
        if (st) {
          deletePromises.push(
            st.ref(storagePath).delete().catch(err => {
              console.warn('Storage delete failed for', storagePath, err);
            })
          );
        }
      }
    }

    await Promise.all(deletePromises);
    toast(`${selectedAdminPhotos.size} photo(s) deleted.`, 'success');
    selectedAdminPhotos.clear();
    await loadAdminPhotos();
  } catch (err) {
    console.error('Delete photos error:', err);
    toast('Some photos failed to delete.', 'error');
  } finally {
    hideLoading();
  }
});

// Keep selected photos (protect from auto-delete)
$('btn-keep-selected').addEventListener('click', async () => {
  if (currentUserRole !== 'admin') return;
  if (selectedAdminPhotos.size === 0) {
    toast('No photos selected.', 'warning');
    return;
  }
  showLoading('Protecting photos...');
  try {
    const batch = db.batch();
    for (const docId of selectedAdminPhotos) {
      batch.update(db.collection('photos').doc(docId), { protected: true });
    }
    await batch.commit();
    toast(`${selectedAdminPhotos.size} photo(s) protected from auto-delete.`, 'success');
    selectedAdminPhotos.clear();
    await loadAdminPhotos();
  } catch (err) {
    console.error('Keep photos error:', err);
    toast('Failed to protect photos.', 'error');
  } finally {
    hideLoading();
  }
});

// Unkeep selected photos (allow auto-delete again)
$('btn-unkeep-selected').addEventListener('click', async () => {
  if (currentUserRole !== 'admin') return;
  if (selectedAdminPhotos.size === 0) {
    toast('No photos selected.', 'warning');
    return;
  }
  showLoading('Removing protection...');
  try {
    const batch = db.batch();
    for (const docId of selectedAdminPhotos) {
      batch.update(db.collection('photos').doc(docId), { protected: false });
    }
    await batch.commit();
    toast(`${selectedAdminPhotos.size} photo(s) will now auto-delete after 30 days.`, 'success');
    selectedAdminPhotos.clear();
    await loadAdminPhotos();
  } catch (err) {
    console.error('Unkeep photos error:', err);
    toast('Failed to remove protection.', 'error');
  } finally {
    hideLoading();
  }
});

// ================================================================
// AUTO-DELETE: Remove unprotected photos older than 30 days
// ================================================================

async function cleanupOldPhotos() {
  const st = getStorage();
  if (!st) return;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const cutoffTimestamp = firebase.firestore.Timestamp.fromDate(cutoff);

  try {
    let totalDeleted = 0;
    let hasMore = true;

    while (hasMore) {
      const snapshot = await db.collection('photos')
        .where('timestamp', '<', cutoffTimestamp)
        .limit(100)
        .get();

      if (snapshot.empty) { hasMore = false; break; }

      const batch = db.batch();
      const storageDeletes = [];
      let batchCount = 0;

      snapshot.forEach(doc => {
        const data = doc.data();
        if (data.protected) return; // skip kept photos

        batch.delete(doc.ref);
        if (data.storagePath) {
          storageDeletes.push(
            st.ref(data.storagePath).delete().catch(err => {
              console.warn('Cleanup storage delete failed:', data.storagePath, err);
            })
          );
        }
        batchCount++;
      });

      if (batchCount > 0) {
        await batch.commit();
        await Promise.all(storageDeletes);
        totalDeleted += batchCount;
      }

      if (snapshot.size < 100) hasMore = false;
    }

    if (totalDeleted > 0) {
      console.log(`Auto-cleanup: deleted ${totalDeleted} photos older than 30 days.`);
      toast(`Auto-cleanup: ${totalDeleted} old photo(s) removed.`, 'info');
    }
  } catch (err) {
    console.error('Auto-cleanup error:', err);
  }
}

$('add-user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (currentUserRole !== 'admin') return;

  const email = $('u-email').value.trim();
  const displayName = $('u-name').value.trim();
  const role = $('u-role').value;

  if (!email || !displayName) {
    toast('Please fill all fields.', 'warning');
    return;
  }

  showLoading('Sending invite...');
  try {
    // Create user via secondary app with a random temp password
    const secondaryApp = firebase.apps.find(a => a.name === 'Secondary') ||
      firebase.initializeApp(firebaseConfig, 'Secondary');
    const secondaryAuth = secondaryApp.auth();

    // Generate a random 24-char password the user will never see
    const tempPassword = crypto.getRandomValues(new Uint8Array(18))
      .reduce((s, b) => s + b.toString(36).padStart(2, '0'), '').slice(0, 24);

    const userCred = await secondaryAuth.createUserWithEmailAndPassword(email, tempPassword);
    await userCred.user.updateProfile({ displayName });

    // Create user document in Firestore
    await db.collection('users').doc(userCred.user.uid).set({
      email,
      displayName,
      role,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      createdBy: currentUser.uid,
    });

    // Sign out from secondary app
    await secondaryAuth.signOut();

    // Send password-reset email so the user can set their own password
    await auth.sendPasswordResetEmail(email);

    toast(`Invite sent to ${displayName} (${email}) as ${role}!`, 'success');
    $('add-user-form').reset();
    loadAdminUsers();
  } catch (err) {
    console.error('Invite user error:', err);
    if (err.code === 'auth/email-already-in-use') {
      toast('That email is already registered.', 'error');
    } else {
      toast('Failed to invite user: ' + err.message, 'error');
    }
  } finally {
    hideLoading();
  }
});

async function loadAdminUsers() {
  if (currentUserRole !== 'admin') return;

  try {
    const snapshot = await db.collection('users').orderBy('displayName').get();
    const list = $('users-list');
    $('user-count').textContent = snapshot.size;

    if (snapshot.empty) {
      list.innerHTML = '<div class="empty-state"><div class="empty-icon">👤</div><p>No users found</p></div>';
      return;
    }

    list.innerHTML = '';
    snapshot.forEach(doc => {
      const data = doc.data();
      const isSelf = doc.id === currentUser.uid;
      const roleBadgeClass = data.role === 'admin' ? '' : data.role === 'manager' ? 'badge-warning' : 'badge-muted';
      const cycle = { user: 'manager', manager: 'admin', admin: 'user' };
      const nextRole = cycle[data.role] || 'user';
      const item = document.createElement('div');
      item.className = 'data-list-item';
      item.innerHTML = `
        <div class="item-info">
          <div class="item-title">${escapeHtml(data.displayName || 'Unknown')} ${isSelf ? '(You)' : ''}</div>
          <div class="item-subtitle">${escapeHtml(data.email)} · <span class="badge ${roleBadgeClass}">${data.role}</span></div>
        </div>
        <div class="item-actions">
          ${!isSelf ? `
            <button class="btn btn-sm btn-outline" onclick="toggleUserRole('${doc.id}', '${data.role}')">
              Make ${nextRole.charAt(0).toUpperCase() + nextRole.slice(1)}
            </button>
            <button class="btn btn-sm ${data.timeclockAccess ? 'btn-primary' : 'btn-outline'}" onclick="toggleTimeclockAccess('${doc.id}', ${!!data.timeclockAccess})" title="Toggle time clock access">🕐 TC: ${data.timeclockAccess ? 'On' : 'Off'}</button>
            <button class="btn btn-sm ${data.canViewAllTimeclocks ? 'btn-warning' : 'btn-outline'}" onclick="toggleTimeclockViewAll('${doc.id}', ${!!data.canViewAllTimeclocks})" title="Can view all employees' timeclocks">👁 View All: ${data.canViewAllTimeclocks ? 'Yes' : 'No'}</button>
            <button class="btn btn-sm btn-danger" onclick="deleteUser('${doc.id}', '${escapeHtml(data.displayName)}')">Remove</button>
          ` : ''}
        </div>
      `;
      list.appendChild(item);
    });
  } catch (err) {
    console.error('Load users error:', err);
    toast('Failed to load users.', 'error');
  }
}

window.toggleUserRole = async function (uid, currentRole) {
  if (currentUserRole !== 'admin') return;
  const cycle = { user: 'manager', manager: 'admin', admin: 'user' };
  const newRole = cycle[currentRole] || 'user';
  const ok = await confirm('Change Role', `Change this user's role to "${newRole}"?`);
  if (!ok) return;

  try {
    await db.collection('users').doc(uid).update({ role: newRole });
    toast('Role updated!', 'success');
    loadAdminUsers();
  } catch (err) {
    console.error('Toggle role error:', err);
    toast('Failed to update role.', 'error');
  }
};

window.toggleTimeclockAccess = async function(uid, currentAccess) {
  if (currentUserRole !== 'admin') return;
  const newAccess = !currentAccess;
  try {
    await db.collection('users').doc(uid).update({ timeclockAccess: newAccess });
    toast(newAccess ? 'Time clock access granted.' : 'Time clock access removed.', 'success');
    loadAdminUsers();
  } catch(e) {
    console.error('toggleTimeclockAccess error:', e);
    toast('Failed to update access.', 'error');
  }
};

window.toggleTimeclockViewAll = async function(uid, currentVal) {
  if (currentUserRole !== 'admin') return;
  const newVal = !currentVal;
  try {
    await db.collection('users').doc(uid).update({ canViewAllTimeclocks: newVal });
    toast(newVal ? 'User can now view all timeclocks.' : 'Restricted to own timeclock.', 'success');
    loadAdminUsers();
  } catch(e) {
    console.error('toggleTimeclockViewAll error:', e);
    toast('Failed to update permission.', 'error');
  }
};

window.deleteUser = async function (uid, name) {
  if (currentUserRole !== 'admin') return;
  const ok = await confirm('Remove User', `Remove access for ${name}? They won't be able to log in or upload photos.`);
  if (!ok) return;

  showLoading('Removing user...');
  try {
    // Remove user document (they can no longer pass auth check)
    await db.collection('users').doc(uid).delete();
    toast(`${name} has been removed.`, 'success');
    loadAdminUsers();
  } catch (err) {
    console.error('Delete user error:', err);
    toast('Failed to remove user.', 'error');
  } finally {
    hideLoading();
  }
};

// ================================================================
// VEHICLE MAINTENANCE TRACKING
// ================================================================

// Manufacturer-standard recommended service intervals (miles)
const MAINTENANCE_SCHEDULE = [];

// Kept for backward compatibility (returns empty array since defaults are removed)
function getScheduleForVehicle(vehicle) {
  return [];
}

function loadMileage(vehicleId) {
  const v = vehiclesCache.find(v => v.id === vehicleId);
  const mileageInput = $('vehicle-mileage');
  mileageInput.value = v && v.mileage ? v.mileage : '';
  updateRecommendedServices(vehicleId);
}

async function updateRecommendedServices(vehicleId) {
  const v = vehiclesCache.find(v => v.id === vehicleId);
  const mileage = v && v.mileage ? v.mileage : 0;
  const container = $('recommended-services');
  const list = $('recommended-list');

  const today = todayDateString();

  // --- Time-based section ---
  const timeDue = [];
  const timeUpcoming = [];

  // Collect all services with an intervalMonths set (use most recent record per service)
  const seenInterval = new Set();
  try {
    const iSnap = await db.collection('maintenance')
      .where('vehicleId', '==', vehicleId)
      .orderBy('date', 'desc')
      .get();
    iSnap.forEach(doc => {
      const d = doc.data();
      if (d.intervalMonths && d.nextDueDate && !seenInterval.has(d.serviceType)) {
        seenInterval.add(d.serviceType);
        const lbl = d.intervalMonths === 1 ? '1 Month' : d.intervalMonths === 12 ? '1 Year' : d.intervalMonths === 24 ? '2 Years' : `${d.intervalMonths} Months`;
        const entry = { service: d.serviceType, nextDueDate: d.nextDueDate, label: lbl };
        if (d.nextDueDate <= today) {
          timeDue.push(entry);
        } else {
          // Show if within 30 days
          const [ny, nm, nd] = d.nextDueDate.split('-').map(Number);
          const [ty, tm, td2] = today.split('-').map(Number);
          const daysUntil = Math.round((new Date(ny, nm-1, nd) - new Date(ty, tm-1, td2)) / 86400000);
          if (daysUntil <= 30) timeUpcoming.push({ ...entry, daysUntil });
        }
      }
    });
  } catch (e) { /* ignore */ }

  // --- Custom mileage-interval section (from vehicleNotes with intervalType:'mileage') ---
  const miIntervalDue = [];
  const miIntervalWarn = [];
  if (mileage) {
    try {
      const mnSnap = await db.collection('vehicleNotes')
        .where('vehicleId', '==', vehicleId)
        .where('autoCreated', '==', true)
        .where('intervalType', '==', 'mileage')
        .where('done', '==', false)
        .get();
      mnSnap.forEach(doc => {
        const d = doc.data();
        if (!d.nextDueMileage || !d.intervalMiles) return;
        const milesLeft = d.nextDueMileage - mileage;
        if (milesLeft <= 0) {
          miIntervalDue.push({ service: d.maintenanceService, nextDueMileage: d.nextDueMileage, intervalMiles: d.intervalMiles, milesLeft });
        } else if (milesLeft <= 500) {
          miIntervalWarn.push({ service: d.maintenanceService, nextDueMileage: d.nextDueMileage, intervalMiles: d.intervalMiles, milesLeft });
        }
      });
    } catch (e) { /* ignore */ }
  }

  if (timeDue.length === 0 && timeUpcoming.length === 0 && miIntervalDue.length === 0 && miIntervalWarn.length === 0) {
    container.style.display = mileage ? 'block' : 'none';
    if (mileage) list.innerHTML = '<p class="hint" style="margin:0;">✅ All services up to date!</p>';
    return;
  }

  container.style.display = 'block';
  let html = '';

  // Time-based items first
  if (timeDue.length > 0 || timeUpcoming.length > 0) {
    if (timeDue.length > 0 || miIntervalDue.length > 0) html += '';
    timeDue.sort((a, b) => a.nextDueDate.localeCompare(b.nextDueDate));
    timeDue.forEach(s => {
      html += `<div class="rec-item rec-time rec-time-overdue">🗓️ <strong>${escapeHtml(s.service)}</strong> — <span class="text-danger">Overdue</span> · Was due ${s.nextDueDate} <span class="hint">(every ${s.label})</span></div>`;
    });
    timeUpcoming.sort((a, b) => a.daysUntil - b.daysUntil);
    timeUpcoming.forEach(s => {
      html += `<div class="rec-item rec-time rec-time-upcoming">🗓️ <strong>${escapeHtml(s.service)}</strong> — Due in ${s.daysUntil} day${s.daysUntil === 1 ? '' : 's'} <span class="hint">(every ${s.label})</span></div>`;
    });
  }

  // Mileage-interval items
  miIntervalDue.sort((a, b) => a.milesLeft - b.milesLeft);
  miIntervalDue.forEach(s => {
    const over = Math.abs(s.milesLeft).toLocaleString();
    html += `<div class="rec-item rec-overdue">🔧 <strong>${escapeHtml(s.service)}</strong> — <span class="text-danger">Overdue by ${over} mi</span> · Due at ${s.nextDueMileage.toLocaleString()} mi <span class="hint">(every ${s.intervalMiles.toLocaleString()} mi)</span></div>`;
  });
  miIntervalWarn.sort((a, b) => a.milesLeft - b.milesLeft);
  miIntervalWarn.forEach(s => {
    html += `<div class="rec-item rec-upcoming">⚠️ <strong>${escapeHtml(s.service)}</strong> — Due in ${s.milesLeft.toLocaleString()} mi · at ${s.nextDueMileage.toLocaleString()} mi <span class="hint">(every ${s.intervalMiles.toLocaleString()} mi)</span></div>`;
  });

  list.innerHTML = html;
}

$('btn-save-mileage').addEventListener('click', async () => {
  if (!selectedVehicle) return;
  const val = parseInt($('vehicle-mileage').value);
  if (!val || val < 0) {
    toast('Enter a valid mileage.', 'warning');
    return;
  }
  try {
    await db.collection('vehicles').doc(selectedVehicle.id).update({ mileage: val });
    selectedVehicle.mileage = val;
    const cached = vehiclesCache.find(v => v.id === selectedVehicle.id);
    if (cached) cached.mileage = val;
    toast('Mileage updated!', 'success');
    updateRecommendedServices(selectedVehicle.id);

    // Auto-flag mileage-based follow-ups as urgent within 500 miles
    try {
      const miSnap = await db.collection('vehicleNotes')
        .where('vehicleId', '==', selectedVehicle.id)
        .where('autoCreated', '==', true)
        .where('intervalType', '==', 'mileage')
        .where('done', '==', false)
        .get();
      const urgentBatch = db.batch();
      let anyUrgent = false;
      miSnap.forEach(doc => {
        const d = doc.data();
        if (!d.nextDueMileage) return;
        const milesLeft = d.nextDueMileage - val;
        if (milesLeft <= 500 && !d.urgent) {
          urgentBatch.update(doc.ref, { urgent: true });
          anyUrgent = true;
        }
      });
      if (anyUrgent) {
        await urgentBatch.commit();
        toast('⚠️ Service coming up within 500 miles!', 'warning');
        loadDashboardFollowUps();
      }
    } catch (e) { /* ignore */ }
  } catch (err) {
    console.error('Save mileage error:', err);
    toast('Failed to save mileage.', 'error');
  }
});

// ================================================================
// PER-VEHICLE SCHEDULE EDITOR (removed — schedule editor UI was deleted)
// Keeping stubs so any legacy vehicle data with customSchedule is harmless.
// ================================================================

// Show/hide maintenance form
$('btn-add-maintenance').addEventListener('click', () => {
  const wrap = $('maintenance-form-wrap');
  wrap.style.display = 'block';
  $('m-date').value = todayDateString();
  $('m-mileage').value = selectedVehicle && selectedVehicle.mileage ? selectedVehicle.mileage : '';
  $('m-interval').value = '';
  $('m-mile-interval').value = '';
  $('m-next-due-display').textContent = '—';
  $('m-next-due-mileage-display').textContent = '—';
  $('m-type').value = '';
  // Clear invoice
  $('m-invoice-input').value = '';
  $('m-invoice-filename').textContent = 'No file chosen';
  $('m-invoice-preview-wrap').style.display = 'none';
  $('m-invoice-preview').src = '';
  setTimeout(() => wrap.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
});

// Update "Next Due" displays when interval or date/mileage changes
function updateNextDueDisplay() {
  const dateVal = $('m-date').value;
  const months = parseInt($('m-interval').value);
  const dateDisplay = $('m-next-due-display');
  if (!dateVal || !months) {
    dateDisplay.textContent = '—';
  } else {
    const [y, mo, d] = dateVal.split('-').map(Number);
    const next = new Date(y, mo - 1 + months, d);
    dateDisplay.textContent = next.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: APP_TIMEZONE });
  }

  const serviceMileage = parseInt($('m-mileage').value) || (selectedVehicle && selectedVehicle.mileage) || 0;
  const mileInt = parseInt($('m-mile-interval').value);
  const mileDisplay = $('m-next-due-mileage-display');
  if (!mileInt || !serviceMileage) {
    mileDisplay.textContent = mileInt && !serviceMileage ? 'Enter mileage at service' : '—';
  } else {
    const nextMi = serviceMileage + mileInt;
    mileDisplay.textContent = nextMi.toLocaleString() + ' mi (warn at ' + (nextMi - 500).toLocaleString() + ' mi)';
  }
}
$('m-interval').addEventListener('change', updateNextDueDisplay);
$('m-date').addEventListener('change', updateNextDueDisplay);
$('m-mileage').addEventListener('input', updateNextDueDisplay);
$('m-mile-interval').addEventListener('input', updateNextDueDisplay);

// Maintenance quick-fill templates
const MAINT_TEMPLATES = {
  'oil':          { type: 'Oil Change',           months: 3,  miles: 3000  },
  'tire-rotation':{ type: 'Tire Rotation',         months: 6,  miles: 6000  },
  'air-filter':   { type: 'Air Filter',            months: 12, miles: 15000 },
  'cabin-filter': { type: 'Cabin Filter',          months: 12, miles: 15000 },
  'brakes':       { type: 'Brake Pads/Rotors',     months: 24, miles: null  },
  'trans':        { type: 'Transmission Fluid',    months: 24, miles: null  },
  'coolant':      { type: 'Coolant Flush',         months: 24, miles: null  },
  'spark-plugs':  { type: 'Spark Plugs',           months: 36, miles: null  },
  'battery':      { type: 'Battery',               months: 48, miles: null  },
  'tires':        { type: 'Tires (New)',           months: 48, miles: null  },
  'ac':           { type: 'A/C Service',           months: 12, miles: null  },
  'inspection':   { type: 'Inspection/Safety',     months: 12, miles: null  },
  'detail':       { type: 'Detail',                months: 3,  miles: null  },
  'roach':        { type: 'Roach Treatment',       months: 6,  miles: null  },
  'wash':         { type: 'Wash',                  months: null,miles: null  },
  'wiper':        { type: 'Wiper Blades',          months: 12, miles: null  },
  'alignment':    { type: 'Alignment',             months: 12, miles: null  },
  'other':        { type: 'Other',                 months: null,miles: null  },
};

$('btn-apply-template').addEventListener('click', () => {
  const key = $('m-template-select').value;
  if (!key) return;
  const tpl = MAINT_TEMPLATES[key];
  if (!tpl) return;
  $('m-type').value = tpl.type;
  $('m-interval').value = tpl.months ? String(tpl.months) : '';
  $('m-mile-interval').value = tpl.miles ? String(tpl.miles) : '';
  $('m-template-select').value = '';
  updateNextDueDisplay();
  $('m-type').focus();
});

$('btn-cancel-maintenance').addEventListener('click', () => {
  $('maintenance-form-wrap').style.display = 'none';
  $('maintenance-form').reset();
  $('m-next-due-display').textContent = '—';
  $('m-next-due-mileage-display').textContent = '—';
  // Clear invoice preview
  $('m-invoice-input').value = '';
  $('m-invoice-filename').textContent = 'No file chosen';
  $('m-invoice-preview-wrap').style.display = 'none';
  $('m-invoice-preview').src = '';
});

// Invoice preview wiring
$('m-invoice-input').addEventListener('change', function() {
  const file = this.files[0];
  if (!file) return;
  $('m-invoice-filename').textContent = file.name;
  const reader = new FileReader();
  reader.onload = (e) => {
    $('m-invoice-preview').src = e.target.result;
    $('m-invoice-preview-wrap').style.display = 'flex';
  };
  reader.readAsDataURL(file);
});
$('m-invoice-clear').addEventListener('click', () => {
  $('m-invoice-input').value = '';
  $('m-invoice-filename').textContent = 'No file chosen';
  $('m-invoice-preview-wrap').style.display = 'none';
  $('m-invoice-preview').src = '';
});

// Save maintenance record
$('maintenance-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!selectedVehicle) return;

  const rawType = $('m-type').value;
  const serviceType = rawType.trim();
  const date = $('m-date').value;
  const mileage = $('m-mileage').value ? parseInt($('m-mileage').value) : null;
  const cost = $('m-cost').value ? parseFloat($('m-cost').value) : null;
  const notes = $('m-notes').value.trim();
  const location = $('m-location').value.trim();
  const intervalMonths = $('m-interval').value ? parseInt($('m-interval').value) : null;
  const intervalMiles = $('m-mile-interval').value ? parseInt($('m-mile-interval').value) : null;

  // Compute next due date if time interval is set
  let nextDueDate = null;
  if (intervalMonths && date) {
    const [y, mo, d] = date.split('-').map(Number);
    const next = new Date(y, mo - 1 + intervalMonths, d);
    nextDueDate = next.toLocaleDateString('en-CA', { timeZone: APP_TIMEZONE }); // YYYY-MM-DD
  }

  // Compute next due mileage if mile interval is set
  const serviceMileage = mileage || (selectedVehicle && selectedVehicle.mileage) || null;
  const nextDueMileage = (intervalMiles && serviceMileage) ? serviceMileage + intervalMiles : null;

  if (!serviceType || !date) {
    toast('Please enter a service type and date.', 'warning');
    return;
  }

  showLoading('Saving maintenance record...');
  try {
    const record = {
      vehicleId: selectedVehicle.id,
      plate: selectedVehicle.plate,
      serviceType,
      date,
      mileage,
      cost,
      notes,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      createdBy: currentUser.uid,
    };
    if (location) record.location = location;
    if (intervalMonths) record.intervalMonths = intervalMonths;
    if (nextDueDate) record.nextDueDate = nextDueDate;
    if (intervalMiles) record.intervalMiles = intervalMiles;
    if (nextDueMileage) record.nextDueMileage = nextDueMileage;

    // Upload invoice if one was selected (compressed: 1600px wide, 0.78 quality ≈ readable but small)
    const invoiceFile = $('m-invoice-input').files[0];
    if (invoiceFile) {
      try {
        const st = getStorage();
        if (st) {
          const compressed = await compressImage(invoiceFile, 1600, 0.78);
          const safePlate = sanitizePlate(selectedVehicle.plate || selectedVehicle.id);
          const fname = 'inv_' + date + '_' + Date.now() + '.jpg';
          const ref = st.ref('vehicles/' + safePlate + '/maintenance/' + fname);
          await ref.put(compressed, { contentType: 'image/jpeg' });
          record.invoiceUrl = await ref.getDownloadURL();
        }
      } catch(invErr) {
        console.error('Invoice upload error:', invErr);
        toast('Invoice upload failed — saving record without it.', 'warning');
      }
    }

    const maintenanceRef = await db.collection('maintenance').add(record);

    // Remove any existing auto-created follow-up notes for this service + vehicle, then create new ones
    if (intervalMonths || intervalMiles) {
      const oldNotes = await db.collection('vehicleNotes')
        .where('vehicleId', '==', selectedVehicle.id)
        .where('maintenanceService', '==', serviceType)
        .where('autoCreated', '==', true)
        .get();
      const batch = db.batch();
      oldNotes.forEach(d => batch.delete(d.ref));

      // Time-based follow-up
      if (intervalMonths && nextDueDate) {
        const intervalLabel = intervalMonths === 1 ? '1 Month' : intervalMonths === 12 ? '1 Year' : intervalMonths === 24 ? '2 Years' : `${intervalMonths} Months`;
        const noteRef = db.collection('vehicleNotes').doc();
        batch.set(noteRef, {
          vehicleId: selectedVehicle.id,
          text: `🔧 ${serviceType} due (every ${intervalLabel})`,
          isFollowUp: true,
          done: false,
          urgent: false,
          dueDate: nextDueDate,
          maintenanceService: serviceType,
          maintenanceRecordId: maintenanceRef.id,
          autoCreated: true,
          intervalType: 'time',
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          createdBy: currentUser.uid,
          createdByName: currentUser.displayName || currentUser.email,
        });
      }

      // Mileage-based follow-up (no calendar dueDate, stored as nextDueMileage)
      if (intervalMiles && nextDueMileage) {
        const mileNoteRef = db.collection('vehicleNotes').doc();
        batch.set(mileNoteRef, {
          vehicleId: selectedVehicle.id,
          text: `🛢️ ${serviceType} due at ${nextDueMileage.toLocaleString()} mi (every ${intervalMiles.toLocaleString()} mi)`,
          isFollowUp: true,
          done: false,
          urgent: false,
          nextDueMileage,
          intervalMiles,
          maintenanceService: serviceType,
          maintenanceRecordId: maintenanceRef.id,
          autoCreated: true,
          intervalType: 'mileage',
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          createdBy: currentUser.uid,
          createdByName: currentUser.displayName || currentUser.email,
        });
      }

      await batch.commit();
    }

    // Auto-update vehicle mileage if higher (admin-only; silently skip if permission denied)
    if (mileage && (!selectedVehicle.mileage || mileage > selectedVehicle.mileage)) {
      try {
        await db.collection('vehicles').doc(selectedVehicle.id).update({ mileage });
        selectedVehicle.mileage = mileage;
        const cached = vehiclesCache.find(v => v.id === selectedVehicle.id);
        if (cached) cached.mileage = mileage;
        $('vehicle-mileage').value = mileage;
      } catch (mileErr) {
        console.warn('Could not auto-update vehicle mileage (may require admin role):', mileErr);
      }
    }

    // Auto-log cost as an expense record so maintenance costs track in Finance
    if (cost && cost > 0) {
      try {
        await db.collection('expenses').add({
          date,
          amount: cost,
          category: 'Maintenance',
          description: `${serviceType}${location ? ' — ' + location : ''}`,
          vehicleId: selectedVehicle.id,
          vehiclePlate: selectedVehicle.plate || '',
          submittedBy: currentUser.uid,
          submittedByName: currentUser.displayName || currentUser.email,
          source: 'maintenance',
          maintenanceRecordId: maintenanceRef.id,
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
      } catch (expErr) {
        console.error('Could not auto-log maintenance expense:', expErr);
        toast('Maintenance saved, but expense auto-log failed.', 'warning');
      }
    }

    toast('Maintenance record saved!', 'success');
    $('maintenance-form-wrap').style.display = 'none';
    $('maintenance-form').reset();
    $('m-next-due-display').textContent = '—';
    $('m-next-due-mileage-display').textContent = '—';
    $('m-invoice-input').value = '';
    $('m-invoice-filename').textContent = 'No file chosen';
    $('m-invoice-preview-wrap').style.display = 'none';
    $('m-invoice-preview').src = '';
    loadMaintenanceHistory(selectedVehicle.id);
    updateRecommendedServices(selectedVehicle.id);
  } catch (err) {
    console.error('Save maintenance error:', err);
    toast('Failed to save record.', 'error');
  } finally {
    hideLoading();
  }
});

async function loadMaintenanceHistory(vehicleId) {
  const container = $('maintenance-history');
  try {
    const snap = await db.collection('maintenance')
      .where('vehicleId', '==', vehicleId)
      .orderBy('date', 'desc')
      .limit(50)
      .get();

    if (snap.empty) {
      container.innerHTML = '<div class="empty-state"><div class="empty-icon">🔧</div><p>No maintenance records yet</p></div>';
      return;
    }

    let html = '';
    snap.forEach(doc => {
      const d = doc.data();
      const costStr = d.cost != null ? `$${d.cost.toFixed(2)}` : '';
      const mileStr = d.mileage ? `${d.mileage.toLocaleString()} mi` : '';
      const locStr = d.location ? d.location : '';
      const meta = [mileStr, costStr, locStr].filter(Boolean).join(' · ');
      const canDelete = (currentUserRole === 'admin' || currentUserRole === 'manager');
      let intervalBadge = '';
      if (d.intervalMonths) {
        const lbl = d.intervalMonths === 1 ? '1 Mo' : d.intervalMonths === 12 ? '1 Yr' : d.intervalMonths === 24 ? '2 Yr' : `${d.intervalMonths} Mo`;
        intervalBadge += `<span class="interval-badge">🔁 Every ${lbl}</span>`;
      }
      if (d.intervalMiles) {
        intervalBadge += `<span class="interval-badge" style="background:#d1fae5;color:#065f46;">🛣 Every ${d.intervalMiles.toLocaleString()} mi</span>`;
      }
      const nextDueStr = d.nextDueDate ? ` · Next: ${d.nextDueDate}` : '';
      const nextDueMiStr = d.nextDueMileage ? ` · Next: ${d.nextDueMileage.toLocaleString()} mi` : '';
      const invoiceHTML = d.invoiceUrl
        ? `<div class="m-invoice-thumb-row"><a href="${escapeHtml(d.invoiceUrl)}" target="_blank" title="View invoice"><img src="${escapeHtml(d.invoiceUrl)}" class="m-invoice-thumb" alt="Invoice"></a></div>`
        : '';
      html += `
        <div class="data-list-item">
          <div class="item-info">
            <div class="item-title">${escapeHtml(d.serviceType)}${intervalBadge}</div>
            <div class="item-subtitle">${escapeHtml(d.date)}${meta ? ' · ' + meta : ''}${nextDueStr}${nextDueMiStr}${d.notes ? ' — ' + escapeHtml(d.notes) : ''}</div>
            ${invoiceHTML}
          </div>
      ${canDelete ? `<div class="item-actions"><button class="btn btn-sm btn-outline" onclick="openEditMaintenance('${doc.id}')">Edit</button><button class="btn btn-sm btn-danger" onclick="deleteMaintenanceRecord('${doc.id}')">Delete</button></div>` : ''}
        </div>
      `;
    });
    container.innerHTML = html;
  } catch (err) {
    console.error('Load maintenance error:', err);
    container.innerHTML = '<div class="empty-state"><p>Failed to load records.</p></div>';
  }
}

window.deleteMaintenanceRecord = async function(docId) {
  const ok = await confirm('Delete Record', 'Remove this maintenance record?');
  if (!ok) return;
  try {
    // Also remove any auto-created follow-up linked to this record
    const linkedNotes = await db.collection('vehicleNotes')
      .where('maintenanceRecordId', '==', docId)
      .where('autoCreated', '==', true)
      .get();
    const batch = db.batch();
    batch.delete(db.collection('maintenance').doc(docId));
    linkedNotes.forEach(d => batch.delete(d.ref));
    await batch.commit();
    toast('Record deleted.', 'success');
    if (selectedVehicle) {
      loadMaintenanceHistory(selectedVehicle.id);
      updateRecommendedServices(selectedVehicle.id);
    }
  } catch (err) {
    console.error('Delete maintenance error:', err);
    toast('Failed to delete record.', 'error');
  }
};

// ================================================================
// EDIT MAINTENANCE RECORD MODAL
// ================================================================

let _editMaintDocId = null;

window.openEditMaintenance = async function(docId) {
  if (currentUserRole !== 'admin' && currentUserRole !== 'manager') return;
  showLoading('Loading record...');
  try {
    const snap = await db.collection('maintenance').doc(docId).get();
    if (!snap.exists) { toast('Record not found.', 'error'); return; }
    const d = snap.data();
    _editMaintDocId = docId;

    // Populate fields
    $('em-type').value = d.serviceType || '';
    $('em-date').value = d.date || '';
    $('em-mileage').value = d.mileage || '';
    $('em-cost').value = d.cost != null ? d.cost : '';
    $('em-location').value = d.location || '';
    $('em-notes').value = d.notes || '';

    // Invoice
    $('em-invoice-input').value = '';
    $('em-invoice-filename').textContent = 'No file chosen';
    $('em-invoice-preview-wrap').style.display = 'none';
    $('em-invoice-preview').src = '';
    if (d.invoiceUrl) {
      $('em-invoice-existing-img').src = d.invoiceUrl;
      $('em-invoice-existing-link').href = d.invoiceUrl;
      $('em-invoice-existing-wrap').style.display = 'block';
    } else {
      $('em-invoice-existing-wrap').style.display = 'none';
    }

    $('edit-maint-overlay').style.display = 'flex';
  } catch(e) {
    console.error('Open edit maintenance error:', e);
    toast('Could not load record.', 'error');
  } finally {
    hideLoading();
  }
};

// Wire new invoice preview in edit modal
$('em-invoice-input').addEventListener('change', function() {
  const file = this.files[0];
  if (!file) return;
  $('em-invoice-filename').textContent = file.name;
  const reader = new FileReader();
  reader.onload = (e) => {
    $('em-invoice-preview').src = e.target.result;
    $('em-invoice-preview-wrap').style.display = 'flex';
  };
  reader.readAsDataURL(file);
});
$('em-invoice-clear').addEventListener('click', () => {
  $('em-invoice-input').value = '';
  $('em-invoice-filename').textContent = 'No file chosen';
  $('em-invoice-preview-wrap').style.display = 'none';
  $('em-invoice-preview').src = '';
});
$('em-invoice-remove').addEventListener('click', () => {
  $('em-invoice-existing-wrap').style.display = 'none';
  $('em-invoice-existing-img').src = '';
  $('em-invoice-existing-link').href = '#';
  // Mark for removal: store empty string sentinel
  $('em-invoice-existing-img').dataset.removed = '1';
});

[$('btn-edit-maint-close'), $('btn-edit-maint-cancel')].forEach(btn => {
  btn.addEventListener('click', () => { $('edit-maint-overlay').style.display = 'none'; });
});
$('edit-maint-overlay').addEventListener('click', (e) => {
  if (e.target === $('edit-maint-overlay')) $('edit-maint-overlay').style.display = 'none';
});

$('edit-maint-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!_editMaintDocId) return;
  if (currentUserRole !== 'admin' && currentUserRole !== 'manager') return;

  const serviceType = ($('em-type').value || '').trim();
  if (!serviceType) { toast('Enter a service type.', 'warning'); return; }
  const date = $('em-date').value;
  if (!date) { toast('Enter a date.', 'warning'); return; }

  const mileage = $('em-mileage').value ? parseInt($('em-mileage').value) : null;
  const cost = $('em-cost').value !== '' ? parseFloat($('em-cost').value) : null;
  const location = $('em-location').value.trim() || null;
  const notes = $('em-notes').value.trim() || null;

  showLoading('Saving changes...');
  try {
    const updateData = { serviceType, date };
    updateData.mileage = mileage ?? firebase.firestore.FieldValue.delete();
    updateData.cost = cost != null ? cost : firebase.firestore.FieldValue.delete();
    updateData.location = location ?? firebase.firestore.FieldValue.delete();
    updateData.notes = notes ?? firebase.firestore.FieldValue.delete();

    // Handle invoice: new upload, keep existing, or remove
    const newFile = $('em-invoice-input').files[0];
    const existingRemoved = $('em-invoice-existing-img').dataset.removed === '1';
    if (newFile) {
      try {
        const st = getStorage();
        const compressed = await compressImage(newFile, 1600, 0.78);
        const safePlate = sanitizePlate(selectedVehicle.plate || selectedVehicle.id);
        const fname = 'inv_' + date + '_' + Date.now() + '.jpg';
        const ref = st.ref('vehicles/' + safePlate + '/maintenance/' + fname);
        await ref.put(compressed, { contentType: 'image/jpeg' });
        updateData.invoiceUrl = await ref.getDownloadURL();
      } catch(invErr) {
        console.error('Invoice upload error:', invErr);
        toast('Invoice upload failed — saved without it.', 'warning');
      }
    } else if (existingRemoved) {
      updateData.invoiceUrl = firebase.firestore.FieldValue.delete();
    }
    // else: leave existing invoiceUrl unchanged (don't set it in updateData)

    await db.collection('maintenance').doc(_editMaintDocId).update(updateData);
    // Reset removal sentinel
    $('em-invoice-existing-img').dataset.removed = '';
    toast('Record updated!', 'success');
    $('edit-maint-overlay').style.display = 'none';
    if (selectedVehicle) {
      loadMaintenanceHistory(selectedVehicle.id);
      updateRecommendedServices(selectedVehicle.id);
    }
  } catch(err) {
    console.error('Edit maintenance error:', err);
    toast('Failed to save changes.', 'error');
  } finally {
    hideLoading();
  }
});

// ================================================================
// VEHICLE NOTES & FOLLOW-UPS
// ================================================================

$('btn-save-note').addEventListener('click', async () => {
  if (!selectedVehicle) return;
  const text = $('note-text').value.trim();
  if (!text) {
    toast('Enter a note first.', 'warning');
    return;
  }
  const isUrgent = $('note-urgent') ? $('note-urgent').checked : false;
  // Urgent notes are always treated as follow-ups so they appear in the task panel
  const isFollowUp = $('note-followup').checked || isUrgent;
  const dueDate = isFollowUp ? ($('note-due-date').value || '') : '';

  try {
    const noteData = {
      vehicleId: selectedVehicle.id,
      text,
      isFollowUp,
      done: false,
      urgent: isUrgent,
      taskStatus: isUrgent ? 'urgent' : 'scheduled',
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      createdBy: currentUser.uid,
      createdByName: currentUser.displayName || currentUser.email
    };
    if (dueDate) noteData.dueDate = dueDate;
    await db.collection('vehicleNotes').add(noteData);
    $('note-text').value = '';
    $('note-followup').checked = false;
    if ($('note-urgent')) $('note-urgent').checked = false;
    $('note-due-date').value = '';
    $('note-due-row').style.display = 'none';
    if ($('note-urgent')) $('note-urgent').checked = false;
    toast(isFollowUp ? 'Follow-up added!' : 'Note saved!', 'success');
    loadVehicleNotes(selectedVehicle.id);
    if (isFollowUp || isUrgent) loadDashboardFollowUps();
  } catch (err) {
    console.error('Save note error:', err);
    toast('Failed to save note.', 'error');
  }
});

async function loadVehicleNotes(vehicleId) {
  const container = $('notes-list');
  try {
    const snap = await db.collection('vehicleNotes')
      .where('vehicleId', '==', vehicleId)
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get();

    if (snap.empty) {
      container.innerHTML = '<p class="hint" style="margin:0; padding:8px 0;">No notes yet.</p>';
      return;
    }

    let html = '';
    snap.forEach(doc => {
      const d = doc.data();
      const dateStr = d.createdAt ? new Date(d.createdAt.toDate()).toLocaleDateString('en-US', { timeZone: APP_TIMEZONE }) : '';
      let followUpBadge = '';
      if (d.isFollowUp) {
        if (d.done) {
          const completer = d.completedByName ? ` by ${escapeHtml(d.completedByName)}` : '';
          const completedDate = d.completedAt ? ' · ' + new Date(d.completedAt.toDate()).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: APP_TIMEZONE }) : '';
          followUpBadge = `<span class="note-badge note-badge-done">✅ Done${completer}${completedDate}</span>`;
        } else {
          const dueLabel = d.dueDate ? ` · Due ${d.dueDate}` : '';
          followUpBadge = `<span class="note-badge note-badge-followup">⚑ Follow Up${dueLabel}</span>`;
        }
      }
      const urgentBadge = d.urgent && !d.done ? '<span class="note-badge note-badge-urgent">🚨 Urgent</span>' : '';
      const doneClass = d.done ? ' note-done' : '';
      const canManage = (currentUserRole === 'admin' || currentUserRole === 'manager');
      const canDelete = (currentUserRole === 'admin');
      html += `
        <div class="note-item${doneClass}">
          <div class="note-content">
            ${urgentBadge}${followUpBadge}
            <div class="note-text">${escapeHtml(d.text)}</div>
            ${d.invoiceUrls && d.invoiceUrls.length > 0 ? `<div class="note-invoice-row">${d.invoiceUrls.map(url => `<img src="${escapeHtml(url)}" class="note-invoice-thumb" onclick="window.open('${escapeHtml(url)}','_blank')" title="View invoice/photo">`).join('')}</div>` : ''}
            <div class="note-meta">👤 ${escapeHtml(d.createdByName || 'Unknown')} · ${dateStr}</div>
          </div>
          <div class="note-actions">
            ${d.isFollowUp && !d.done && canManage ? `<button class="btn btn-sm btn-outline" onclick="markNoteDone('${doc.id}')">✓ Done</button>` : ''}
            ${d.done && canManage ? `<button class="btn btn-sm btn-undo" onclick="markNoteUndone('${doc.id}')">↩ Undo</button>` : ''}
            ${canManage ? `<button class="btn btn-sm btn-outline" onclick="openNoteEditModal('${doc.id}', 'vehicleNotes')">✏️ Edit</button>` : ''}
            ${canDelete ? `<button class="btn btn-sm btn-danger" onclick="deleteNote('${doc.id}')">Delete</button>` : ''}
          </div>
        </div>`;
    });
    container.innerHTML = html;
  } catch (err) {
    console.error('Load notes error:', err);
    container.innerHTML = '<p class="hint">Failed to load notes.</p>';
  }
}

window.markNoteDone = async function(docId) {
  try {
    await db.collection('vehicleNotes').doc(docId).update({
      done: true,
      completedBy: currentUser.uid,
      completedByName: currentUser.displayName || currentUser.email,
      completedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    toast('Follow-up marked done.', 'success');
    if (selectedVehicle) loadVehicleNotes(selectedVehicle.id);
  } catch (err) {
    console.error('Mark done error:', err);
    toast('Failed to update.', 'error');
  }
};

window.deleteNote = async function(docId) {
  const ok = await confirm('Delete Note', 'Remove this note?');
  if (!ok) return;
  try {
    await db.collection('vehicleNotes').doc(docId).delete();
    toast('Note deleted.', 'success');
    if (selectedVehicle) loadVehicleNotes(selectedVehicle.id);
  } catch (err) {
    console.error('Delete note error:', err);
    toast('Failed to delete note.', 'error');
  }
};

// ================================================================
// VEHICLE COMPLIANCE (Safety / Registration / Insurance / VIN)
// ================================================================

// ── Compliance month-browser state & helpers ─────────────────────
let _complianceViewMonth = ''; // YYYY-MM — blank = use current month

window.changeComplianceMonth = function(delta) {
  const base = _complianceViewMonth || todayDateString().substring(0, 7);
  const [y, m] = base.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  _complianceViewMonth = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  renderTaskAgenda(cachedTaskItems);
};

function _buildComplianceMonthBrowser() {
  const month = _complianceViewMonth || todayDateString().substring(0, 7);
  const [y, m] = month.split('-').map(Number);
  const monthName = new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const todayMonth = todayDateString().substring(0, 7);
  const isCurrent = month === todayMonth;

  // Collect all vehicles with compliance due in the selected month
  const rows = [];
  vehiclesCache.forEach(v => {
    const its = [];
    if (v.complianceSafety === month)
      its.push({ label: '\uD83D\uDD27 Safety', status: complianceMonthStatus(v.complianceSafety) });
    if (v.complianceRegistration === month)
      its.push({ label: '\uD83D\uDCDD Registration', status: complianceMonthStatus(v.complianceRegistration) });
    if (its.length) rows.push({ v, its });
  });

  const navHtml = `<div class="comp-month-nav">
    <button class="comp-month-btn" onclick="changeComplianceMonth(-1)" title="Previous month">&#8249;</button>
    <span class="comp-month-label">${monthName}${isCurrent ? ' <span class="comp-month-current-chip">Current</span>' : ''}</span>
    <button class="comp-month-btn" onclick="changeComplianceMonth(1)" title="Next month">&#8250;</button>
  </div>`;

  if (rows.length === 0) {
    return `<div class="comp-month-browser">
      ${navHtml}
      <div class="comp-month-empty">&#x2705; No compliance items due in ${monthName}.</div>
    </div>`;
  }

  rows.sort((a, b) => {
    const aWorst = Math.min(...a.its.map(i => i.status.daysLeft ?? 999));
    const bWorst = Math.min(...b.its.map(i => i.status.daysLeft ?? 999));
    return aWorst - bWorst;
  });

  let rowsHtml = '';
  for (const { v, its } of rows) {
    const hasUrgent = its.some(i => i.status.cls === 'compliance-urgent');
    const hasWarn   = its.some(i => i.status.cls === 'compliance-warn');
    const rowCls    = hasUrgent ? 'comp-month-row comp-row-urgent' : hasWarn ? 'comp-month-row comp-row-warn' : 'comp-month-row comp-row-ok';
    const tagHtml   = its.map(i => {
      const tc = i.status.cls === 'compliance-urgent' ? 'comp-tag-urgent'
               : i.status.cls === 'compliance-warn'   ? 'comp-tag-warn' : 'comp-tag-ok';
      return `<span class="comp-month-tag ${tc}">${i.label} \u2014 ${i.status.label}</span>`;
    }).join('');
    rowsHtml += `<div class="${rowCls}" onclick="openVehicleCompliancePage('${v.id}')">
      <span class="comp-month-plate">&#x1F697; ${escapeHtml(v.plate)}</span>
      <span class="comp-month-tags">${tagHtml}</span>
    </div>`;
  }

  return `<div class="comp-month-browser">
    ${navHtml}
    <div class="comp-month-count">${rows.length} vehicle${rows.length !== 1 ? 's' : ''} due in ${monthName}</div>
    <div class="comp-month-rows">${rowsHtml}</div>
  </div>`;
}

function complianceMonthStatus(yyyyMM) {
  if (!yyyyMM) return { label: '—', cls: '', nextDue: '', daysLeft: null };
  const [y, m] = yyyyMM.split('-').map(Number);
  // Last day of that month
  const expDate = new Date(Date.UTC(y, m, 0, 23, 59, 59));
  const nowMs = Date.now();
  const daysLeft = Math.ceil((expDate.getTime() - nowMs) / 86400000);
  // Next cycle = same month, next year
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const nextDue = `${MONTHS[m - 1]} ${y + 1}`;
  if (daysLeft < 0) return { label: `Expired ${Math.abs(daysLeft)}d ago`, cls: 'compliance-urgent', nextDue, daysLeft };
  if (daysLeft <= 15) return { label: `Due in ${daysLeft}d 🚨`, cls: 'compliance-urgent', nextDue, daysLeft };
  if (daysLeft <= 30) return { label: `Due in ${daysLeft}d ⚠️`, cls: 'compliance-warn', nextDue, daysLeft };
  return { label: `Good thru ${yyyyMM}`, cls: 'compliance-ok', nextDue, daysLeft };
}

function loadComplianceData(v) {
  // Show the compliance bar wrap (it's now baked into the main vehicle card)
  const barWrap = $('compliance-bar-wrap');
  if (barWrap) barWrap.style.display = '';
  const canEditCompliance = (currentUserRole === 'admin');
  // Show/hide Save button and lock inputs for non-admins
  const saveBtn = $('btn-save-compliance');
  if (saveBtn) saveBtn.style.display = 'none'; // always hidden — auto-save used instead
  const complianceInputs = ['compliance-safety','compliance-registration','compliance-insurance','compliance-vin'];
  complianceInputs.forEach(id => {
    const el = $(id);
    if (!el) return;
    el.disabled = !canEditCompliance;
    el.style.opacity = canEditCompliance ? '' : '0.65';
    el.style.cursor = canEditCompliance ? '' : 'not-allowed';
  });
  const uploadBtn = document.querySelector('label[for="compliance-insurance-upload"], label.compliance-upload-btn');
  if (uploadBtn) uploadBtn.style.display = canEditCompliance ? '' : 'none';
  const uploadInput = $('compliance-insurance-upload');
  if (uploadInput) uploadInput.disabled = !canEditCompliance;
  const fields = [
    { id: 'compliance-safety', statusId: 'safety-status', nextId: 'safety-next-due', val: v.complianceSafety, shortName: 'Safety' },
    { id: 'compliance-registration', statusId: 'registration-status', nextId: 'registration-next-due', val: v.complianceRegistration, shortName: 'Reg' },
    { id: 'compliance-insurance', statusId: 'insurance-status', nextId: null, val: v.complianceInsurance, shortName: 'Ins' },
  ];
  let warnings = [];
  const urgentCompliance = []; // {complianceType, label}

  // Determine worst status for bar color
  let worstLevel = 0; // 0=green, 1=red(≤30d), 2=flash(≤15d or expired)
  const pillParts = [];

  fields.forEach(({ id, statusId, nextId, val, shortName }) => {
    const input = $(id);
    const statusEl = $(statusId);
    if (input) input.value = val || '';
    if (statusEl) {
      const { label, cls, nextDue, daysLeft } = complianceMonthStatus(val);
      statusEl.textContent = label;
      statusEl.className = 'compliance-status ' + cls;
      if (cls === 'compliance-warn' || cls === 'compliance-urgent') {
        warnings.push(label + ' — ' + id.replace('compliance-', ''));
      }
      if (cls === 'compliance-urgent' && (id === 'compliance-safety' || id === 'compliance-registration')) {
        urgentCompliance.push({ complianceType: id.replace('compliance-', ''), label, daysLeft });
      }
      // Bar color logic
      if (val) {
        if (daysLeft !== null && (daysLeft < 0 || daysLeft <= 15)) {
          worstLevel = 2;
          pillParts.push(`<span class="cbp cbp-flash">${shortName}: ${daysLeft < 0 ? 'Expired' : daysLeft + 'd'}</span>`);
        } else if (daysLeft !== null && daysLeft <= 30) {
          if (worstLevel < 1) worstLevel = 1;
          pillParts.push(`<span class="cbp cbp-warn">${shortName}: ${daysLeft}d</span>`);
        } else {
          pillParts.push(`<span class="cbp cbp-ok">${shortName} ✓</span>`);
        }
      } else {
        pillParts.push(`<span class="cbp cbp-none">${shortName}: —</span>`);
      }
      if (nextId) {
        const nextEl = $(nextId);
        if (nextEl) {
          if (val) {
            const [ny, nm] = val.split('-').map(Number);
            const nextYYYYMM = `${ny + 1}-${String(nm).padStart(2, '0')}`;
            nextEl.innerHTML = `<span class="compliance-next-label">Next renewal:</span> <strong>${nextDue}</strong> <span class="compliance-next-yyyymm">(${nextYYYYMM})</span>`;
          } else {
            nextEl.innerHTML = '';
          }
        }
      }
    }
  });

  // Update bar color
  const bar = $('compliance-bar');
  if (bar) {
    bar.className = 'compliance-bar ' + (worstLevel === 2 ? 'compliance-bar-flash' : worstLevel === 1 ? 'compliance-bar-red' : 'compliance-bar-green');
  }
  // Update pills
  const pillsEl = $('compliance-bar-pills');
  if (pillsEl) pillsEl.innerHTML = pillParts.join('');

  const vinInput = $('compliance-vin');
  if (vinInput) vinInput.value = v.vin || '';
  // Insurance doc link
  const docLink = $('insurance-doc-link');
  if (docLink) {
    if (v.complianceInsuranceDoc) {
      const name = v.complianceInsuranceDocName || 'Policy Document';
      docLink.innerHTML = `<a href="${escapeHtml(v.complianceInsuranceDoc)}" target="_blank" class="compliance-doc-anchor">📎 ${escapeHtml(name)}</a>`;
    } else {
      docLink.innerHTML = '<span style="font-size:0.73rem;color:#9ca3af;">No document uploaded</span>';
    }
  }
  // Auto-create urgent follow-up notes for compliance items at ≤15 days / expired
  if (urgentCompliance.length > 0 && v.id) {
    urgentCompliance.forEach(({ complianceType, label, daysLeft }) => {
      ensureComplianceFollowUp(v.id, v.plate, complianceType, label, daysLeft);
    });
  }
}

// Toggle the inline compliance body open/closed
window.toggleComplianceInline = function() {
  const body = $('compliance-inline-body');
  const chevron = $('compliance-bar-chevron');
  if (!body) return;
  const isOpen = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : 'block';
  if (chevron) chevron.innerHTML = isOpen ? '&#9660;' : '&#9650;';
};

// Auto-create an urgent follow-up note when a compliance item is ≤15 days or expired.
// Checks for an existing open note first to avoid duplicates.
async function ensureComplianceFollowUp(vehicleId, plate, complianceType, statusLabel, daysLeft) {
  try {
    const existing = await db.collection('vehicleNotes')
      .where('vehicleId', '==', vehicleId)
      .where('sourceType', '==', 'compliance')
      .where('complianceType', '==', complianceType)
      .where('done', '==', false)
      .limit(1)
      .get();
    if (!existing.empty) return; // already has an open compliance note
    const isOverdue = typeof daysLeft === 'number' && daysLeft < 0;
    const typeName = complianceType === 'safety' ? 'Safety Inspection' : 'Registration';
    await db.collection('vehicleNotes').add({
      vehicleId,
      text: `${typeName} — ${statusLabel} for ${plate || vehicleId}.`,
      isFollowUp: true,
      done: false,
      urgent: isOverdue,
      taskStatus: isOverdue ? 'urgent' : 'scheduled',
      sourceType: 'compliance',
      complianceType,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      createdBy: (currentUser && currentUser.uid) || 'system',
      createdByName: (currentUser && (currentUser.displayName || currentUser.email)) || 'System',
    });
    loadDashboardFollowUps();
  } catch (e) {
    console.warn('ensureComplianceFollowUp error:', e);
  }
}

$('btn-save-compliance').addEventListener('click', async () => {
  // Legacy handler — kept so the DOM doesn't throw; actual saving is auto via change listeners
});

// Auto-save compliance data whenever an admin changes a field
let _complianceSaveTimer = null;
async function autoSaveCompliance() {
  if (currentUserRole !== 'admin') return;
  if (!selectedVehicle) return;
  clearTimeout(_complianceSaveTimer);
  _complianceSaveTimer = setTimeout(async () => {
    const data = {
      complianceSafety: $('compliance-safety').value || null,
      complianceRegistration: $('compliance-registration').value || null,
      complianceInsurance: $('compliance-insurance').value || null,
      vin: $('compliance-vin').value.toUpperCase().trim() || null,
    };
    try {
      await db.collection('vehicles').doc(selectedVehicle.id).update(data);
      Object.assign(selectedVehicle, data);
      const cached = vehiclesCache.find(v => v.id === selectedVehicle.id);
      if (cached) Object.assign(cached, data);
      loadComplianceData(selectedVehicle);
      toast('Saved \u2705', 'success');
    } catch (e) {
      console.error('Auto-save compliance error:', e);
      toast('Failed to save.', 'error');
    }
  }, 800);
}

// Live preview next-due when compliance month inputs change
function updateComplianceLivePreview(inputId, statusId, nextId) {
  const input = $(inputId);
  const statusEl = $(statusId);
  const nextEl = $(nextId);
  if (!input) return;
  const val = input.value;
  if (!val) {
    if (statusEl) { statusEl.textContent = ''; statusEl.className = 'compliance-status'; }
    if (nextEl) nextEl.innerHTML = '';
    return;
  }
  const { label, cls, nextDue } = complianceMonthStatus(val);
  if (statusEl) { statusEl.textContent = label; statusEl.className = 'compliance-status ' + cls; }
  if (nextEl) {
    const [y, m] = val.split('-').map(Number);
    const nextYYYYMM = `${y + 1}-${String(m).padStart(2, '0')}`;
    nextEl.innerHTML = `<span class="compliance-next-label">Next renewal:</span> <strong>${nextDue}</strong> <span class="compliance-next-yyyymm">(${nextYYYYMM})</span>`;
  }
}

$('compliance-safety').addEventListener('change', () => {
  updateComplianceLivePreview('compliance-safety', 'safety-status', 'safety-next-due');
  autoSaveCompliance();
});
$('compliance-registration').addEventListener('change', () => {
  updateComplianceLivePreview('compliance-registration', 'registration-status', 'registration-next-due');
  autoSaveCompliance();
});
$('compliance-insurance').addEventListener('change', () => {
  const val = $('compliance-insurance').value;
  const statusEl = $('insurance-status');
  if (!statusEl) return;
  if (!val) { statusEl.textContent = ''; statusEl.className = 'compliance-status'; }
  else {
    const { label, cls } = complianceMonthStatus(val);
    statusEl.textContent = label;
    statusEl.className = 'compliance-status ' + cls;
  }
  autoSaveCompliance();
});
$('compliance-vin').addEventListener('change', () => autoSaveCompliance());
$('compliance-vin').addEventListener('blur', () => {
  const el = $('compliance-vin');
  if (el) el.value = el.value.toUpperCase().trim();
  autoSaveCompliance();
});

// Insurance document upload
$('compliance-insurance-upload').addEventListener('change', async function(e) {
  const file = e.target.files[0];
  if (!file || !selectedVehicle) return;
  const st = getStorage();
  if (!st) { toast('Storage not available. Contact admin.', 'error'); e.target.value = ''; return; }
  const plate = sanitizePlate(selectedVehicle.plate);
  const ext = file.name.split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '');
  const safeExt = ['pdf','jpg','jpeg','png','gif','webp'].includes(ext) ? ext : 'bin';
  const fileName = `insurance_${Date.now()}.${safeExt}`;
  const storagePath = `vehicles/${plate}/documents/${fileName}`;
  try {
    showLoading('Uploading document…');
    const ref = st.ref(storagePath);
    await ref.put(file, { contentType: file.type });
    const url = await ref.getDownloadURL();
    const docData = { complianceInsuranceDoc: url, complianceInsuranceDocName: file.name };
    await db.collection('vehicles').doc(selectedVehicle.id).update(docData);
    Object.assign(selectedVehicle, docData);
    const cached = vehiclesCache.find(v => v.id === selectedVehicle.id);
    if (cached) Object.assign(cached, docData);
    loadComplianceData(selectedVehicle);
    toast('Insurance document uploaded! ✅', 'success');
  } catch (err) {
    console.error('Insurance doc upload error:', err);
    toast('Failed to upload document.', 'error');
  } finally {
    hideLoading();
    e.target.value = '';
  }
});

// Current active tab in the task panel: 'all' | 'urgent' | 'scheduled' | 'monitoring'
let currentTaskTab = 'all';
// Cached items for re-filtering without refetch
let cachedTaskItems = [];
// Mailbox
let mailUnsubscribe = null;
// Incidents
let incidentUnsubscribe = null;
let currentVehicleIncidents = [];
// Time clock
let elapsedInterval = null;
let timeclockData = null;
let weeklyTimeclockData = {};
let currentWeekOffset = 0;
const OWNER_EMAIL = 'mattaiscale@gmail.com';
let currentTaskUserFilter = 'all'; // 'all' | uid — admin-only filter

window.switchTaskTab = function(tab) {
  currentTaskTab = tab;
  document.querySelectorAll('.task-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  // Reset compliance month browser to current month each time the compliance tab opens
  if (tab === 'compliance') _complianceViewMonth = todayDateString().substring(0, 7);
  const incPanel = $('incidents-tab-content');
  const userFilterRow = $('task-user-filter-row');
  if (tab === 'incidents') {
    if (incPanel) incPanel.style.display = '';
    ['followup-overdue','followup-today','followup-upcoming','followup-no-date','followup-empty','compliance-grouped-view'].forEach(id => { const el = $(id); if (el) el.style.display = 'none'; });
    if (userFilterRow) userFilterRow.style.display = 'none';
  } else {
    if (incPanel) incPanel.style.display = 'none';
    renderTaskAgenda(cachedTaskItems);
  }
};

// Admin user-filter change handler
window.applyTaskUserFilter = function(uid) {
  currentTaskUserFilter = uid || 'all';
  renderTaskAgenda(cachedTaskItems);
};

window.toggleCompletedBucket = function() {
  const list = $('completed-bucket-list');
  const arrow = $('completed-bucket-arrow');
  if (!list) return;
  const open = list.style.display !== 'none';
  list.style.display = open ? 'none' : 'block';
  if (arrow) arrow.textContent = open ? '▶' : '▼';
};

// Dashboard follow-up agenda (vehicle notes + general notes, grouped by date)
async function loadDashboardFollowUps() {
  const overdueEl = $('followup-overdue');
  const todayEl = $('followup-today');
  const upcomingEl = $('followup-upcoming');
  const noDateEl = $('followup-no-date');
  const emptyEl = $('followup-empty');
  const badgeEl = $('task-alert-count');
  const tasksBtn = $('btn-tasks');
  if (!overdueEl) return;

  try {
    // Fetch active follow-ups from both collections (isFollowUp = true)
    // PLUS any urgent vehicle/general notes (urgent = true) even if not marked as follow-up
    const [vFollowSnap, gFollowSnap, vUrgentSnap, gUrgentSnap, vDoneSnap, gDoneSnap] = await Promise.all([
      db.collection('vehicleNotes')
        .where('isFollowUp', '==', true)
        .where('done', '==', false)
        .limit(100)
        .get(),
      db.collection('generalNotes')
        .where('isFollowUp', '==', true)
        .where('done', '==', false)
        .limit(100)
        .get(),
      // Catch urgent vehicle notes that aren't marked isFollowUp
      db.collection('vehicleNotes')
        .where('urgent', '==', true)
        .where('done', '==', false)
        .limit(50)
        .get(),
      // Catch urgent general notes that aren't marked isFollowUp
      db.collection('generalNotes')
        .where('urgent', '==', true)
        .where('done', '==', false)
        .limit(50)
        .get(),
      // Completed vehicle follow-ups (for the completed bucket)
      db.collection('vehicleNotes')
        .where('isFollowUp', '==', true)
        .where('done', '==', true)
        .limit(50)
        .get(),
      // Completed general follow-ups
      db.collection('generalNotes')
        .where('isFollowUp', '==', true)
        .where('done', '==', true)
        .limit(50)
        .get()
    ]);

    // Merge, de-duplicate by id
    const seen = new Set();
    const items = [];
    function addItems(snap, type, collection) {
      snap.forEach(doc => {
        if (seen.has(doc.id)) return;
        seen.add(doc.id);
        items.push({ id: doc.id, collection, type, ...doc.data() });
      });
    }
    addItems(vFollowSnap, 'vehicle', 'vehicleNotes');
    addItems(gFollowSnap, 'general', 'generalNotes');
    addItems(vUrgentSnap, 'vehicle', 'vehicleNotes');
    addItems(gUrgentSnap, 'general', 'generalNotes');

    // Completed items
    const completedItems = [];
    const seenDone = new Set();
    function addDoneItems(snap, type, collection) {
      snap.forEach(doc => {
        if (seenDone.has(doc.id)) return;
        seenDone.add(doc.id);
        completedItems.push({ id: doc.id, collection, type, ...doc.data() });
      });
    }
    addDoneItems(vDoneSnap, 'vehicle', 'vehicleNotes');
    addDoneItems(gDoneSnap, 'general', 'generalNotes');

    // Update badge count (active tasks)
    // Only count: urgent tasks + compliance items (due ≤15d — they're only created at that threshold)
    const badgeCount = items.filter(i => i.urgent || i.sourceType === 'compliance').length;
    if (badgeEl) {
      badgeEl.textContent = badgeCount;
      badgeEl.classList.toggle('count-zero', badgeCount === 0);
      const hasUrgent = items.some(i => i.urgent);
      badgeEl.classList.toggle('has-urgent', hasUrgent);
    }
    // Update ops-hub widget badge
    const opsHubBadge = $('ops-hub-badge');
    if (opsHubBadge) {
      opsHubBadge.textContent = badgeCount;
      opsHubBadge.style.display = badgeCount > 0 ? '' : 'none';
      opsHubBadge.classList.toggle('has-urgent', items.some(i => i.urgent));
    }
    if (tasksBtn) tasksBtn.style.display = '';

    // Sync vehicle-page task button badge
    const badgeVehicle = $('task-alert-count-vehicle');
    const tasksBtnVehicle = $('btn-tasks-vehicle');
    if (badgeVehicle) {
      badgeVehicle.textContent = badgeCount;
      badgeVehicle.classList.toggle('count-zero', badgeCount === 0);
      badgeVehicle.classList.toggle('has-urgent', items.some(i => i.urgent));
    }
    if (tasksBtnVehicle) tasksBtnVehicle.style.display = '';

    // Populate urgent banner on dashboard (separate from task panel)
    renderUrgentBanner(items);

    // Populate task calendar
    renderTaskCalendar(items);

    // Cache items and render
    cachedTaskItems = items;
    renderTaskAgenda(items);

    // Render completed bucket
    renderCompletedBucket(completedItems);

  } catch (err) {
    console.error('Load follow-ups error:', err);
  }
}

// Render the agenda based on current tab filter
function renderTaskAgenda(allItems) {
  const overdueEl = $('followup-overdue');
  const todayEl = $('followup-today');
  const upcomingEl = $('followup-upcoming');
  const noDateEl = $('followup-no-date');
  const emptyEl = $('followup-empty');
  if (!overdueEl) return;

  const today = todayDateString();

  // Always populate the overdue banner (all items, not filtered by tab)
  const bannerEl = $('task-overdue-banner');
  const bannerListEl = $('task-overdue-banner-list');
  const bannerCountEl = $('task-overdue-count');
  if (bannerEl) {
    const allOverdue = allItems.filter(i => !i.done && i.dueDate && i.dueDate < today);
    if (allOverdue.length > 0) {
      bannerEl.style.display = '';
      if (bannerCountEl) bannerCountEl.textContent = allOverdue.length;
      if (bannerListEl) {
        allOverdue.sort((a, b) => (b.urgent ? 1 : 0) - (a.urgent ? 1 : 0) || (a.dueDate || '').localeCompare(b.dueDate || ''));
        bannerListEl.innerHTML = allOverdue.map(item => renderAgendaItem(item)).join('');
        bannerListEl.querySelectorAll('.followup-item').forEach(el => {
          el.addEventListener('click', e => {
            if (e.target.closest('button')) return;
            const wrap = el.closest('.followup-item-wrap');
            const dd = wrap ? wrap.dataset.due : '';
            if (dd) jumpToCalendarDay(dd);
          });
        });
      }
    } else {
      bannerEl.style.display = 'none';
    }
  }

  // Filter by current tab
  let items = allItems;
  if (currentTaskTab === 'urgent') {
    items = allItems.filter(i => i.urgent);
  } else if (currentTaskTab === 'scheduled') {
    items = allItems.filter(i => !i.urgent && i.taskStatus !== 'monitoring' && i.dueDate);
  } else if (currentTaskTab === 'monitoring') {
    items = allItems.filter(i => i.taskStatus === 'monitoring');
  } else if (currentTaskTab === 'compliance') {
    items = allItems.filter(i => i.sourceType === 'compliance');
  } else if (currentTaskTab === 'mine') {
    // Show tasks assigned to me OR unassigned (team tasks visible to everyone)
    items = allItems.filter(i => !i.assignedTo || i.assignedTo === currentUser.uid);
  }

  // Admin user-filter: when a specific user is selected in the dropdown,
  // show tasks assigned to that user + all unassigned (team) tasks
  if (currentUserRole === 'admin' && currentTaskUserFilter && currentTaskUserFilter !== 'all') {
    items = items.filter(i => !i.assignedTo || i.assignedTo === currentTaskUserFilter);
  }

  if (items.length === 0) {
    if (emptyEl) emptyEl.style.display = '';
    overdueEl.style.display = 'none';
    todayEl.style.display = 'none';
    upcomingEl.style.display = 'none';
    noDateEl.style.display = 'none';
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';

  // Categorize items
  const overdue = [];
  const todayItems = [];
  const upcoming = [];
  const noDate = [];

  for (const item of items) {
    if (!item.dueDate) {
      noDate.push(item);
    } else if (item.dueDate < today) {
      overdue.push(item);
    } else if (item.dueDate === today) {
      todayItems.push(item);
    } else {
      upcoming.push(item);
    }
  }

  // Sort urgent first within each group, then by date
  const urgentFirst = (a, b) => (b.urgent ? 1 : 0) - (a.urgent ? 1 : 0);
  overdue.sort((a, b) => urgentFirst(a, b) || (a.dueDate || '').localeCompare(b.dueDate || ''));
  upcoming.sort((a, b) => urgentFirst(a, b) || (a.dueDate || '').localeCompare(b.dueDate || ''));
  todayItems.sort(urgentFirst);
  noDate.sort(urgentFirst);

  function renderAgendaItem(item) {
    const isVehicle = item.type === 'vehicle';
    const vidAttr = isVehicle ? ` data-vid="${item.vehicleId}"` : '';
    const taskStatus = item.taskStatus || (item.urgent ? 'urgent' : 'scheduled');
    let extraClass = '';
    if (item.urgent) extraClass += ' followup-urgent';
    if (item.taskStatus === 'monitoring') extraClass += ' followup-monitoring';
    if (item.dueDate && item.dueDate < today) extraClass += ' followup-overdue';
    else if (item.dueDate === today) extraClass += ' followup-today-item';

    let metaLabel;
    if (isVehicle) {
      const v = vehiclesCache.find(x => x.id === item.vehicleId);
      metaLabel = '\ud83d\ude97 ' + escapeHtml(v ? v.plate : 'Unknown');
    } else {
      metaLabel = '\ud83d\udcdd General';
    }

    const urgentTag = item.urgent ? ' 🚨' : (item.taskStatus === 'monitoring' ? ' 🟢' : '');
    const priorityBadge = (item.priority && item.priority !== 'normal')
      ? `<span class="task-priority-badge prio-${item.priority}">${
          item.priority === 'critical' ? '🔴 Critical'
          : item.priority === 'high' ? '🟠 High'
          : '🟢 Low'}</span>`
      : '';
    const photoThumb = item.photoUrl
      ? `<a href="${item.photoUrl}" target="_blank"><img src="${item.photoUrl}" class="task-item-thumb" alt="photo"></a>`
      : '';
    const creatorLabel = item.createdByName ? ' · 👤 ' + escapeHtml(item.createdByName) : '';
    const dueLabelStr = item.dueDate ? ` · 📅 ${item.dueDate}` : '';
    const assigneeLabel = item.assignedToName ? ` · <span class="task-assignee-badge">🎯 ${escapeHtml(item.assignedToName)}</span>` : (item.assignedTo ? '' : ' · <span class="task-assignee-badge task-assignee-team">👥 Team</span>');

    // Status move buttons
    let statusBtns = '';
    const canManage = (currentUserRole === 'admin' || currentUserRole === 'manager');
    if (canManage) {
      if (taskStatus !== 'urgent') {
        statusBtns += `<button class="task-status-move-btn urgent-btn" onclick="event.stopPropagation(); moveTaskStatus('${item.id}','${item.collection}','urgent')" title="Move to Urgent">🚨</button>`;
      }
      if (taskStatus !== 'scheduled') {
        statusBtns += `<button class="task-status-move-btn scheduled-btn" onclick="event.stopPropagation(); moveTaskStatus('${item.id}','${item.collection}','scheduled')" title="Move to Scheduled">🔵</button>`;
      }
      if (taskStatus !== 'monitoring') {
        statusBtns += `<button class="task-status-move-btn monitoring-btn" onclick="event.stopPropagation(); moveTaskStatus('${item.id}','${item.collection}','monitoring')" title="Move to Monitoring">🟢</button>`;
      }
    }

    const menuBtn = `<button class="task-menu-btn" onclick="event.stopPropagation(); openTaskContextMenu('${item.id}','${item.collection}',this)" title="Options">⋯</button>`;
    const completeBtn = `<button class="task-complete-btn" onclick="event.stopPropagation(); agendaMarkDone_dispatch('${item.id}','${item.collection}')" title="Mark Complete">✓ Done</button>`;
    const canDelete = (currentUserRole === 'admin' || currentUserRole === 'manager');
    const deleteBtn = canDelete ? `<button class="task-delete-btn" onclick="event.stopPropagation(); deleteTaskNote('${item.id}','${item.collection}')" title="Delete">🗑</button>` : '';
    const logCount = item.taskLog && item.taskLog.length > 0
      ? ` · <span class="task-log-badge" onclick="event.stopPropagation(); openNoteEditModal('${item.id}','${item.collection}')" title="View log">📋 ${item.taskLog.length} note${item.taskLog.length > 1 ? 's' : ''}</span>`
      : '';
    return `
      <div class="followup-item-wrap" data-id="${item.id}" data-col="${item.collection}" data-due="${item.dueDate || ''}" data-vid-key="${item.vehicleId || ''}">
        <div class="swipe-action-bg"><span>📅</span>Reschedule</div>
        <div class="followup-item${extraClass}"${vidAttr}>
          <div class="followup-info">
            <div class="followup-text">${priorityBadge}${escapeHtml(item.text)}${urgentTag}</div>
            ${item.description ? `<div class="followup-desc">${escapeHtml(item.description)}</div>` : ''}
            <div class="followup-meta">${metaLabel}${creatorLabel}${dueLabelStr}${assigneeLabel}${logCount}</div>
            ${photoThumb}
            ${statusBtns ? `<div class="task-status-btns">${statusBtns}</div>` : ''}
          </div>
          <div class="task-item-actions">
            ${completeBtn}
            ${deleteBtn}
            ${menuBtn}
          </div>
        </div>
      </div>`;
  }

  function renderGroup(el, title, cssClass, groupItems, showDateLabels) {
    if (groupItems.length === 0) {
      el.style.display = 'none';
      return;
    }
    el.style.display = '';
    let html = `<div class="agenda-group-title ${cssClass}">${title} (${groupItems.length})</div>`;
    html += '<div class="followup-list">';

    if (showDateLabels) {
      let lastDate = '';
      for (const item of groupItems) {
        const d = item.dueDate || '';
        if (d && d !== lastDate) {
          const [y, m, dy] = d.split('-').map(Number);
          const dt = new Date(y, m - 1, dy);
          const label = dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: APP_TIMEZONE });
          html += `<div class="agenda-date-label">${label}</div>`;
          lastDate = d;
        }
        html += renderAgendaItem(item);
      }
    } else {
      for (const item of groupItems) {
        html += renderAgendaItem(item);
      }
    }

    html += '</div>';
    el.innerHTML = html;
  }

  // Compliance tab: month browser at top + task cards below
  const compGroupEl = $('compliance-grouped-view');
  if (currentTaskTab === 'compliance') {
    [overdueEl, todayEl, upcomingEl, noDateEl].forEach(el => { if (el) el.style.display = 'none'; });
    if (emptyEl) emptyEl.style.display = 'none';
    if (compGroupEl) {
      compGroupEl.style.display = '';
      if (!_complianceViewMonth) _complianceViewMonth = today.substring(0, 7);

      // Month browser at top
      let fullHtml = _buildComplianceMonthBrowser();

      // Task cards below
      if (items.length === 0) {
        fullHtml += '<div class="comp-tasks-section"><div class="comp-tasks-header">📋 Compliance Tasks</div><div class="agenda-empty"><p class="hint">No open compliance tasks. ✅</p></div></div>';
      } else {
        const todayMonth = today.substring(0, 7);
        const groupMap = new Map();
        for (const item of items) {
          const month = item.dueDate ? item.dueDate.substring(0, 7) : 'nodate';
          const key = `${item.vehicleId || 'general'}__${month}`;
          if (!groupMap.has(key)) groupMap.set(key, { vehicleId: item.vehicleId, month, items: [] });
          groupMap.get(key).items.push(item);
        }
        const groups = [...groupMap.values()].sort((a, b) => {
          const aOver = a.month !== 'nodate' && a.month < todayMonth;
          const bOver = b.month !== 'nodate' && b.month < todayMonth;
          if (aOver !== bOver) return aOver ? -1 : 1;
          return (a.month === 'nodate' ? 'zzzz' : a.month).localeCompare(b.month === 'nodate' ? 'zzzz' : b.month);
        });
        let taskHtml = '<div class="comp-tasks-section"><div class="comp-tasks-header">📋 Compliance Tasks</div>';
        for (const group of groups) {
          const v = group.vehicleId ? vehiclesCache.find(x => x.id === group.vehicleId) : null;
          const plate = v ? v.plate : 'General';
          const isOver = group.month !== 'nodate' && group.month < todayMonth;
          const monthStr = group.month !== 'nodate'
            ? new Date(group.month + '-01').toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
            : 'No Due Date';
          const typeTags = group.items.map(i => {
            if (i.complianceType === 'safety') return '<span class="ctag ctag-safety">🔧 Safety</span>';
            if (i.complianceType === 'registration') return '<span class="ctag ctag-reg">📝 Registration</span>';
            return '<span class="ctag">📄 Insurance</span>';
          }).join('');
          taskHtml += `<div class="compliance-group-card${isOver ? ' compliance-group-overdue' : ''}">
            <div class="compliance-group-header">
              <span class="compliance-group-plate">🚗 ${escapeHtml(plate)}</span>
              <span class="compliance-group-month">${monthStr}</span>
              ${isOver ? '<span class="compliance-group-badge overdue-badge">OVERDUE</span>' : ''}
              <span class="compliance-group-types">${typeTags}</span>
            </div>
            <div class="compliance-group-items">`;
          for (const item of group.items) taskHtml += renderAgendaItem(item);
          taskHtml += '</div></div>';
        }
        taskHtml += '</div>';
        fullHtml += taskHtml;
      }

      compGroupEl.innerHTML = fullHtml;
      compGroupEl.querySelectorAll('.followup-item').forEach(el => {
        el.addEventListener('click', e => {
          if (e.target.closest('button')) return;
          const wrap = el.closest('.followup-item-wrap');
          const dd = wrap ? wrap.dataset.due : '';
          if (dd) jumpToCalendarDay(dd);
          else if (el.dataset.vid) { closeTaskPanel(); openVehiclePage(el.dataset.vid); }
        });
      });
    }
    return;
  }
  if (compGroupEl) compGroupEl.style.display = 'none';

  renderGroup(overdueEl, '\u26a0\ufe0f Overdue', 'agenda-overdue', overdue, true);
  renderGroup(todayEl, '\ud83d\udfe2 Today', 'agenda-today', todayItems, false);
  renderGroup(upcomingEl, '\ud83d\udcc5 Upcoming', 'agenda-upcoming', upcoming, true);
  renderGroup(noDateEl, '\ud83d\udccc No Date', 'agenda-nodate', noDate, false);

  // Click task row → jump to calendar day (if has dueDate) or go to vehicle
  document.querySelectorAll('#task-panel-overlay .followup-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      const wrap = item.closest('.followup-item-wrap');
      const dueDate = wrap ? wrap.dataset.due : '';
      if (dueDate) {
        jumpToCalendarDay(dueDate);
      } else if (item.dataset.vid) {
        closeTaskPanel();
        openVehiclePage(item.dataset.vid);
      }
    });
  });
}

function renderCompletedBucket(completedItems) {
  const listEl = $('completed-bucket-list');
  const badge = $('completed-count-badge');
  if (!listEl) return;
  if (badge) badge.textContent = completedItems.length;
  if (completedItems.length === 0) {
    listEl.innerHTML = '<p class="hint" style="padding:10px 0;margin:0;">No completed tasks yet.</p>';
    return;
  }
  const canManage = (currentUserRole === 'admin' || currentUserRole === 'manager');
  let html = '';
  completedItems.forEach(item => {
    const isVehicle = item.type === 'vehicle';
    const v = isVehicle ? vehiclesCache.find(x => x.id === item.vehicleId) : null;
    const metaLabel = isVehicle ? '🚗 ' + escapeHtml(v ? v.plate : 'Unknown') : '📝 General';
    const completedBy = item.completedByName ? ' · ✓ ' + escapeHtml(item.completedByName) : '';
    const completedAt = item.completedAt ? ' · ' + new Date(item.completedAt.toDate()).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: APP_TIMEZONE }) : '';
    const reopenFn = isVehicle ? `agendaMarkUndone('${item.id}','vehicleNotes')` : `agendaMarkUndone('${item.id}','generalNotes')`;
    html += `
      <div class="completed-task-item">
        <div class="completed-task-info">
          <div class="completed-task-text">${escapeHtml(item.text)}</div>
          <div class="completed-task-meta">${metaLabel}${completedBy}${completedAt}</div>
        </div>
        ${canManage ? `<button class="btn btn-sm btn-undo" onclick="${reopenFn}" title="Reopen">↩ Reopen</button>` : ''}
      </div>`;
  });
  listEl.innerHTML = html;
}

// Move a task to a different status bucket
window.moveTaskStatus = async function(docId, col, newStatus) {
  try {
    const updates = { taskStatus: newStatus };
    // urgent status also sets the urgent flag; others clear it
    if (newStatus === 'urgent') {
      updates.urgent = true;
      updates.isFollowUp = true;
    } else if (newStatus === 'scheduled') {
      updates.urgent = false;
      updates.isFollowUp = true;
    } else if (newStatus === 'monitoring') {
      updates.urgent = false;
      updates.isFollowUp = true;
    }
    await db.collection(col).doc(docId).update(updates);
    const label = newStatus === 'urgent' ? '🚨 Urgent' : newStatus === 'monitoring' ? '🟢 Monitoring' : '🔵 Scheduled';
    toast(`Moved to ${label}`, 'success');
    loadDashboardFollowUps();
    if (col === 'vehicleNotes' && selectedVehicle) loadVehicleNotes(selectedVehicle.id);
    if (col === 'generalNotes') loadGeneralNotes();
  } catch (err) {
    console.error('Move task error:', err);
    toast('Failed to move task.', 'error');
  }
};

// Dispatch complete to correct collection
window.agendaMarkDone_dispatch = async function(docId, col) {
  if (col === 'vehicleNotes') {
    await agendaMarkDoneVehicle(docId);
  } else {
    await agendaMarkDoneGeneral(docId);
  }
};

window.agendaMarkDone = async function(docId) {
  await agendaMarkDoneVehicle(docId);
};

async function agendaMarkDoneVehicle(docId) {
  try {
    const snap = await db.collection('vehicleNotes').doc(docId).get();
    await db.collection('vehicleNotes').doc(docId).update({
      done: true,
      completedBy: currentUser.uid,
      completedByName: currentUser.displayName || currentUser.email,
      completedAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    // Auto-advance compliance date by 1 year when a compliance task is marked done
    if (snap.exists) {
      const data = snap.data();
      if (data.sourceType === 'compliance' && data.vehicleId && data.complianceType) {
        const fieldMap = { safety: 'complianceSafety', registration: 'complianceRegistration', insurance: 'complianceInsurance' };
        const field = fieldMap[data.complianceType];
        if (field) {
          const vehicleSnap = await db.collection('vehicles').doc(data.vehicleId).get();
          if (vehicleSnap.exists) {
            const current = vehicleSnap.data()[field]; // 'YYYY-MM'
            let nextVal = null;
            if (current) {
              const [y, m] = current.split('-').map(Number);
              const nextDate = new Date(y + 1, m - 1, 1);
              nextVal = nextDate.getFullYear() + '-' + String(nextDate.getMonth() + 1).padStart(2, '0');
            } else {
              // No existing date — set to same month next year
              const now = new Date();
              nextVal = (now.getFullYear() + 1) + '-' + String(now.getMonth() + 1).padStart(2, '0');
            }
            await db.collection('vehicles').doc(data.vehicleId).update({ [field]: nextVal });
            // Refresh cache
            const idx = vehiclesCache.findIndex(v => v.id === data.vehicleId);
            if (idx !== -1) vehiclesCache[idx][field] = nextVal;
            toast(`Task complete ✓ — ${data.complianceType === 'safety' ? 'Safety' : data.complianceType === 'registration' ? 'Registration' : 'Insurance'} renewed to ${nextVal}`, 'success');
          } else {
            toast('Task completed! ✓', 'success');
          }
        } else {
          toast('Task completed! ✓', 'success');
        }
      } else {
        toast('Task completed! ✓', 'success');
      }
    } else {
      toast('Task completed! ✓', 'success');
    }

    loadDashboardFollowUps();
    if (selectedVehicle) loadVehicleNotes(selectedVehicle.id);
    if (selectedVehicle) loadComplianceData(vehiclesCache.find(v => v.id === (selectedVehicle.id || selectedVehicle)) || selectedVehicle);
  } catch (err) {
    console.error('Mark done error:', err);
    toast('Failed to update.', 'error');
  }
}

window.agendaMarkGeneralDone = async function(docId) {
  await agendaMarkDoneGeneral(docId);
};

async function agendaMarkDoneGeneral(docId) {
  try {
    await db.collection('generalNotes').doc(docId).update({
      done: true,
      completedBy: currentUser.uid,
      completedByName: currentUser.displayName || currentUser.email,
      completedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    toast('Task completed! ✓', 'success');
    loadDashboardFollowUps();
    loadGeneralNotes();
  } catch (err) {
    console.error('Mark general done error:', err);
    toast('Failed to update.', 'error');
  }
}

// Delete a task note (admin/manager only)
window.deleteTaskNote = async function(docId, col) {
  if (!(await confirm('Delete Task', 'Delete this task permanently?'))) return;
  try {
    await db.collection(col).doc(docId).delete();
    toast('Task deleted.', 'success');
    loadDashboardFollowUps();
    if (col === 'vehicleNotes' && selectedVehicle) loadVehicleNotes(selectedVehicle.id);
    if (col === 'generalNotes') loadGeneralNotes();
  } catch (err) {
    console.error('Delete task error:', err);
    toast('Failed to delete.', 'error');
  }
};

window.agendaMarkUndone = async function(docId, col) {
  try {
    await db.collection(col).doc(docId).update({ done: false });
    toast('Task reopened.', 'success');
    loadDashboardFollowUps();
    if (col === 'vehicleNotes' && selectedVehicle) loadVehicleNotes(selectedVehicle.id);
    if (col === 'generalNotes') loadGeneralNotes();
  } catch (err) {
    console.error('Reopen task error:', err);
    toast('Failed to reopen.', 'error');
  }

};

// Undo completed vehicle note
window.markNoteUndone = async function(docId) {
  try {
    await db.collection('vehicleNotes').doc(docId).update({ done: false });
    toast('Follow-up reopened.', 'success');
    if (selectedVehicle) loadVehicleNotes(selectedVehicle.id);
    loadDashboardFollowUps();
  } catch (err) {
    console.error('Undo done error:', err);
    toast('Failed to update.', 'error');
  }
};

// Undo completed general note
window.markGeneralNoteUndone = async function(docId) {
  try {
    await db.collection('generalNotes').doc(docId).update({ done: false });
    toast('Follow-up reopened.', 'success');
    loadGeneralNotes();
    loadDashboardFollowUps();
  } catch (err) {
    console.error('Undo done error:', err);
    toast('Failed to update.', 'error');
  }
};

// Edit note status, urgency, and due date/time
window.openNoteEditModal = async function(docId, collection) {
  const existing = document.querySelector('.note-edit-overlay');
  if (existing) existing.remove();

  let d;
  try {
    const snap = await db.collection(collection).doc(docId).get();
    if (!snap.exists) { toast('Note not found.', 'error'); return; }
    d = snap.data();
  } catch (err) {
    toast('Could not load note.', 'error');
    return;
  }

  const overlay = document.createElement('div');
  overlay.className = 'note-edit-overlay';
  overlay.innerHTML = `
    <div class="note-edit-modal">
      <h4>✏️ Edit Note</h4>
      <div class="form-group">
        <label class="note-followup-label">
          <input type="checkbox" id="ne-followup" ${d.isFollowUp ? 'checked' : ''}> ⚑ Follow Up Task
        </label>
      </div>
      <div id="ne-followup-opts" style="${d.isFollowUp ? '' : 'display:none;'}">
        <div class="form-group">
          <label class="note-edit-section-label">Status</label>
          <div class="ne-status-btns">
            <button type="button" class="ne-status-btn ${(d.taskStatus === 'urgent' || d.urgent) ? 'ne-status-active-urgent' : ''}" data-status="urgent">🚨 Urgent</button>
            <button type="button" class="ne-status-btn ${(d.taskStatus === 'scheduled' && !d.urgent) ? 'ne-status-active-scheduled' : ''}" data-status="scheduled">🔵 Scheduled</button>
            <button type="button" class="ne-status-btn ${d.taskStatus === 'monitoring' ? 'ne-status-active-monitoring' : ''}" data-status="monitoring">🟢 Monitoring</button>
          </div>
        </div>
        <div class="form-group">
          <label>Due Date</label>
          <input type="date" id="ne-due-date" class="form-select" value="${d.dueDate || ''}">
        </div>
        <div class="form-group">
          <label>Due Time <span style="color:#9ca3af;font-size:0.8rem;">(optional)</span></label>
          <input type="time" id="ne-due-time" class="form-select" value="${d.dueTime || ''}">
        </div>
      </div>
      <div class="task-log-section">
        <div class="note-edit-section-label" style="margin-bottom:6px;">📋 Activity Log</div>
        <div id="ne-log-entries" class="task-log-entries">${renderTaskLogEntries(d.taskLog || [])}</div>
        <div class="task-log-input-row">
          <textarea id="ne-log-input" class="task-log-textarea" placeholder="Add a note or update…" rows="2"></textarea>
          <button class="btn btn-sm btn-outline" id="btn-ne-log-add">Add</button>
        </div>
      </div>
      <div class="ne-invoice-section">
        <div class="note-edit-section-label" style="margin-bottom:6px;">📎 Invoice / Photo Attachments</div>
        <div id="ne-invoice-existing" class="ne-invoice-thumbs">${(d.invoiceUrls || []).map((url, idx) => `
          <div class="ne-invoice-thumb-wrap" data-url="${escapeHtml(url)}">
            <img src="${escapeHtml(url)}" class="ne-invoice-thumb" onclick="window.open('${escapeHtml(url)}','_blank')" title="View full size">
            <button class="ne-invoice-remove" data-idx="${idx}" title="Remove">✕</button>
          </div>`).join('')}</div>
        <div id="ne-invoice-new-thumbs" class="ne-invoice-thumbs" style="margin-top:4px;"></div>
        <label class="ne-invoice-upload-label">
          📎 Attach Photo / Invoice
          <input type="file" id="ne-invoice-input" accept="image/*" multiple style="display:none;">
        </label>
        <div id="ne-invoice-hint" class="ne-invoice-hint">${(d.invoiceUrls && d.invoiceUrls.length) ? d.invoiceUrls.length + ' attachment(s) saved' : 'No attachments yet'}</div>
      </div>
      <div class="note-edit-actions">
        <button class="btn btn-primary" id="btn-ne-save">Save Changes</button>
        <button class="btn btn-outline" id="btn-ne-cancel">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const followupEl = overlay.querySelector('#ne-followup');
  const optsEl = overlay.querySelector('#ne-followup-opts');
  followupEl.addEventListener('change', () => {
    optsEl.style.display = followupEl.checked ? '' : 'none';
  });

  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  // Status button selection
  let selectedStatus = (d.taskStatus === 'monitoring') ? 'monitoring' : (d.taskStatus === 'scheduled' && !d.urgent) ? 'scheduled' : 'urgent';
  overlay.querySelectorAll('.ne-status-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedStatus = btn.dataset.status;
      overlay.querySelectorAll('.ne-status-btn').forEach(b => {
        b.className = 'ne-status-btn' + (b.dataset.status === selectedStatus ? ' ne-status-active-' + selectedStatus : '');
      });
    });
  });

  overlay.querySelector('#btn-ne-cancel').onclick = () => overlay.remove();

  // --- Invoice / Photo attachment logic ---
  let removedInvoiceUrls = [];
  let newInvoiceFiles = [];

  overlay.querySelectorAll('.ne-invoice-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const wrap = btn.closest('.ne-invoice-thumb-wrap');
      const url = wrap.dataset.url;
      removedInvoiceUrls.push(url);
      wrap.remove();
      _updateInvoiceHint();
    });
  });

  overlay.querySelector('#ne-invoice-input').addEventListener('change', function() {
    const files = Array.from(this.files);
    newInvoiceFiles.push(...files);
    const newThumbsEl = overlay.querySelector('#ne-invoice-new-thumbs');
    files.forEach((f, i) => {
      const wrap = document.createElement('div');
      wrap.className = 'ne-invoice-thumb-wrap';
      wrap.dataset.newIdx = newInvoiceFiles.length - files.length + i;
      const img = document.createElement('img');
      img.src = URL.createObjectURL(f);
      img.className = 'ne-invoice-thumb';
      img.title = f.name;
      const removeBtn = document.createElement('button');
      removeBtn.className = 'ne-invoice-remove';
      removeBtn.textContent = '✕';
      removeBtn.addEventListener('click', () => {
        const idx = parseInt(wrap.dataset.newIdx, 10);
        newInvoiceFiles[idx] = null;
        wrap.remove();
        _updateInvoiceHint();
      });
      wrap.appendChild(img);
      wrap.appendChild(removeBtn);
      newThumbsEl.appendChild(wrap);
    });
    this.value = '';
    _updateInvoiceHint();
  });

  function _updateInvoiceHint() {
    const existingCount = overlay.querySelectorAll('#ne-invoice-existing .ne-invoice-thumb-wrap').length;
    const newCount = newInvoiceFiles.filter(f => f !== null).length;
    const total = existingCount + newCount;
    overlay.querySelector('#ne-invoice-hint').textContent = total > 0 ? total + ' attachment(s)' : 'No attachments yet';
  }

  // Log entry
  overlay.querySelector('#btn-ne-log-add').onclick = async () => {
    const logText = overlay.querySelector('#ne-log-input').value.trim();
    if (!logText) return;
    const entry = {
      text: logText,
      by: currentUser.displayName || currentUser.email,
      at: new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: APP_TIMEZONE })
    };
    try {
      await db.collection(collection).doc(docId).update({
        taskLog: firebase.firestore.FieldValue.arrayUnion(entry)
      });
      overlay.querySelector('#ne-log-input').value = '';
      const snap = await db.collection(collection).doc(docId).get();
      const updated = snap.data();
      overlay.querySelector('#ne-log-entries').innerHTML = renderTaskLogEntries(updated.taskLog || []);
      toast('Log entry added.', 'success');
    } catch (err) {
      console.error('Log add error:', err);
      toast('Failed to add log entry.', 'error');
    }
  };
  overlay.querySelector('#ne-log-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); overlay.querySelector('#btn-ne-log-add').click(); }
  });

  overlay.querySelector('#btn-ne-save').onclick = async () => {
    const saveBtn = overlay.querySelector('#btn-ne-save');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    const isFollowUp = followupEl.checked;
    const urgent = isFollowUp && selectedStatus === 'urgent';
    const taskStatus = isFollowUp ? selectedStatus : null;
    const dueDate = isFollowUp ? overlay.querySelector('#ne-due-date').value : '';
    const dueTime = isFollowUp ? overlay.querySelector('#ne-due-time').value : '';
    const updates = { isFollowUp, urgent };
    if (taskStatus) updates.taskStatus = taskStatus;
    if (dueDate) { updates.dueDate = dueDate; }
    else { updates.dueDate = firebase.firestore.FieldValue.delete(); }
    if (dueTime) { updates.dueTime = dueTime; }
    else { updates.dueTime = firebase.firestore.FieldValue.delete(); }

    // --- Handle invoice photo uploads ---
    try {
      const st = getStorage();
      // Collect surviving existing URLs (those not removed)
      const survivingUrls = Array.from(overlay.querySelectorAll('#ne-invoice-existing .ne-invoice-thumb-wrap'))
        .map(w => w.dataset.url).filter(Boolean);
      // Upload new files
      const uploadedUrls = [];
      if (st) {
        const storagePath = (collection === 'vehicleNotes' && d.vehicleId)
          ? (() => { const v = vehiclesCache.find(x => x.id === d.vehicleId); return 'vehicles/' + (v ? sanitizePlate(v.plate) : d.vehicleId) + '/invoices/'; })()
          : 'noteAttachments/' + docId + '/';
        for (const file of newInvoiceFiles.filter(f => f !== null)) {
          try {
            const compressed = await compressImage(file);
            const fname = 'inv_' + Date.now() + '_' + Math.random().toString(36).slice(2,6) + '.jpg';
            const ref = st.ref(storagePath + fname);
            await ref.put(compressed, { contentType: 'image/jpeg' });
            uploadedUrls.push(await ref.getDownloadURL());
          } catch(e) { console.error('Invoice upload error:', e); }
        }
      }
      const finalUrls = [...survivingUrls, ...uploadedUrls];
      if (finalUrls.length > 0) updates.invoiceUrls = finalUrls;
      else updates.invoiceUrls = firebase.firestore.FieldValue.delete();

      await db.collection(collection).doc(docId).update(updates);
      toast('Note updated!', 'success');
      overlay.remove();
      if (collection === 'vehicleNotes' && selectedVehicle) loadVehicleNotes(selectedVehicle.id);
      if (collection === 'generalNotes') loadGeneralNotes();
      loadDashboardFollowUps();
    } catch (err) {
      console.error('Note edit error:', err);
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Changes';
      toast('Failed to update note.', 'error');
    }
  };
};

// ================================================================
// GENERAL NOTES (not tied to a vehicle)
// ================================================================

// ================================================================
// URGENT BANNER (dashboard, above fleet overview)
// ================================================================
function renderUrgentBanner(items) {
  const banner = $('urgent-banner');
  const list = $('urgent-banner-list');
  const countEl = $('urgent-banner-count');
  if (!banner || !list) return;

  const today = todayDateString();
  // Compliance items belong to the Fleet Compliance widget only — never show here
  const urgentItems = items.filter(i => i.urgent && i.sourceType !== 'compliance');

  if (urgentItems.length === 0) {
    banner.style.display = 'none';
    return;
  }

  banner.style.display = '';
  if (countEl) countEl.textContent = urgentItems.length;

  // Sort: overdue first, then today, then upcoming, then no-date
  urgentItems.sort((a, b) => {
    const aDate = a.dueDate || 'zzzz';
    const bDate = b.dueDate || 'zzzz';
    const aOverdue = a.dueDate && a.dueDate < today ? 0 : (a.dueDate === today ? 1 : 2);
    const bOverdue = b.dueDate && b.dueDate < today ? 0 : (b.dueDate === today ? 1 : 2);
    if (aOverdue !== bOverdue) return aOverdue - bOverdue;
    return aDate.localeCompare(bDate);
  });

  let html = '';
  for (const item of urgentItems) {
    const isVehicle = item.type === 'vehicle';
    const markFn = isVehicle ? 'agendaMarkDone' : 'agendaMarkGeneralDone';
    const vidAttr = isVehicle ? ` data-vid="${item.vehicleId}"` : '';

    let metaLabel;
    if (isVehicle) {
      const v = vehiclesCache.find(x => x.id === item.vehicleId);
      metaLabel = '\ud83d\ude97 ' + escapeHtml(v ? v.plate : 'Unknown');
    } else {
      metaLabel = '\ud83d\udcdd General';
    }

    let statusTag = '';
    if (item.dueDate && item.dueDate < today) {
      statusTag = '<span class="urgent-status urgent-overdue">OVERDUE</span>';
    } else if (item.dueDate === today) {
      statusTag = '<span class="urgent-status urgent-due-today">DUE TODAY</span>';
    } else if (item.dueDate) {
      statusTag = `<span class="urgent-status urgent-upcoming">Due ${item.dueDate}</span>`;
    }

    const isOverdue = item.dueDate && item.dueDate < today;
    let reassignBtn = '';
    if (currentUserRole === 'admin' && isOverdue) {
      reassignBtn = `<button class="btn btn-sm btn-outline cal-reassign-btn" onclick="event.stopPropagation(); openReassignTask('${item.id}', '${item.collection}', '${item.dueDate}')" title="Reassign">📅 Reassign</button>`;
    }

    const canManage = (currentUserRole === 'admin' || currentUserRole === 'manager');
    const editBtn = canManage
      ? `<button class="btn btn-sm btn-outline urgent-edit-btn" onclick="event.stopPropagation(); openNoteEditModal('${item.id}','${item.collection}')" title="Edit">✏️ Edit</button>`
      : '';
    const doneBtn = `<button class="btn btn-sm btn-success urgent-done-btn" onclick="event.stopPropagation(); agendaMarkDone_dispatch('${item.id}','${item.collection}')" title="Mark Complete">✓ Done</button>`;
    const deleteBtn = canManage
      ? `<button class="btn btn-sm btn-danger urgent-delete-btn" onclick="event.stopPropagation(); deleteTaskNote('${item.id}','${item.collection}')" title="Delete">🗑</button>`
      : '';

    html += `
      <div class="urgent-banner-item"${vidAttr}>
        <div class="urgent-banner-info">
          <div class="urgent-banner-text">${escapeHtml(item.text)}</div>
          <div class="urgent-banner-meta">${metaLabel} ${statusTag}</div>
        </div>
        <div class="urgent-banner-actions">
          ${reassignBtn}
          ${doneBtn}
          ${editBtn}
          ${deleteBtn}
        </div>
      </div>`;
  }
  list.innerHTML = html;

  // Click vehicle items to navigate
  list.querySelectorAll('.urgent-banner-item[data-vid]').forEach(el => {
    el.addEventListener('click', () => openVehiclePage(el.dataset.vid));
  });
}

// ================================================================
// TASK CALENDAR
// ================================================================
let calendarMonth = new Date(); // current viewed month
let calendarItems = [];         // cached task items for calendar

function renderTaskCalendar(items) {
  calendarItems = items;
  renderCalendarGrid();
}

function renderCalendarGrid() {
  const grid = $('task-calendar-grid');
  const label = $('cal-month-label');
  const detailEl = $('task-calendar-detail');
  if (!grid) return;
  if (detailEl) detailEl.style.display = 'none';

  const year = calendarMonth.getFullYear();
  const month = calendarMonth.getMonth();
  const today = todayDateString();

  label.textContent = new Date(year, month, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  // Build map of due dates -> tasks for this month
  const tasksByDate = {};
  for (const item of calendarItems) {
    if (!item.dueDate) continue;
    const [y, m] = item.dueDate.split('-').map(Number);
    if (y === year && m - 1 === month) {
      if (!tasksByDate[item.dueDate]) tasksByDate[item.dueDate] = [];
      tasksByDate[item.dueDate].push(item);
    }
  }

  // Also include overdue items on today's cell if they have past dates
  const firstDay = new Date(year, month, 1).getDay(); // 0=Sun
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  let html = '<div class="cal-row cal-header-row">';
  ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach(d => {
    html += `<div class="cal-cell cal-day-name">${d}</div>`;
  });
  html += '</div><div class="cal-row">';

  // Blank cells for days before the 1st
  for (let i = 0; i < firstDay; i++) {
    html += '<div class="cal-cell cal-empty"></div>';
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const tasks = tasksByDate[dateStr] || [];
    const isToday = dateStr === today;
    const hasUrgent = tasks.some(t => t.urgent);
    const hasTasks = tasks.length > 0;

    let cellClass = 'cal-cell cal-day cal-clickable';
    if (isToday) cellClass += ' cal-today';
    if (hasTasks) cellClass += ' cal-has-tasks';
    if (hasUrgent) cellClass += ' cal-has-urgent';

    let dots = '';
    if (hasTasks) {
      const urgentCount = tasks.filter(t => t.urgent).length;
      const normalCount = tasks.length - urgentCount;
      if (urgentCount > 0) dots += `<span class="cal-dot cal-dot-urgent"></span>`;
      if (normalCount > 0) dots += `<span class="cal-dot cal-dot-normal"></span>`;
    }

    html += `<div class="${cellClass}" data-date="${dateStr}" onclick="showCalendarDetail('${dateStr}')">
      <span class="cal-day-num">${day}</span>
      ${dots ? `<div class="cal-dots">${dots}</div>` : ''}
      ${hasTasks ? `<span class="cal-task-count">${tasks.length}</span>` : ''}
    </div>`;

    if ((firstDay + day) % 7 === 0 && day < daysInMonth) {
      html += '</div><div class="cal-row">';
    }
  }

  // Fill remaining cells
  const remaining = (7 - (firstDay + daysInMonth) % 7) % 7;
  for (let i = 0; i < remaining; i++) {
    html += '<div class="cal-cell cal-empty"></div>';
  }
  html += '</div>';

  grid.innerHTML = html;
}

window.showCalendarDetail = function(dateStr) {
  const detailEl = $('task-calendar-detail');
  const detailDate = $('cal-detail-date');
  const detailList = $('cal-detail-list');
  if (!detailEl) return;

  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  detailDate.textContent = dt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  const today = todayDateString();
  const tasks = calendarItems.filter(i => i.dueDate === dateStr);
  const isAdmin = currentUserRole === 'admin';
  const canAdd = (currentUserRole === 'admin' || currentUserRole === 'manager');

  function renderCalItem(item) {
    const isVehicle = item.type === 'vehicle';
    const markFn = isVehicle ? 'agendaMarkDone' : 'agendaMarkGeneralDone';
    const isOverdue = item.dueDate < today;
    const v = isVehicle ? vehiclesCache.find(x => x.id === item.vehicleId) : null;
    const metaLabel = isVehicle ? '🚗 ' + escapeHtml(v ? v.plate : 'Unknown') : '📝 General';
    const creatorLabel = item.createdByName ? ' · 👤 ' + escapeHtml(item.createdByName) : '';
    const urgentTag = item.urgent ? '<span class="cal-urgent-tag">🚨</span> ' : '';
    const timeLabel = item.dueTime ? `<span class="cal-item-time">${item.dueTime}</span> ` : '';
    let actionBtns = '';
    if (isAdmin && isOverdue) {
      actionBtns += `<button class="btn btn-sm btn-outline cal-reassign-btn" onclick="event.stopPropagation(); openReassignTask('${item.id}', '${item.collection}', '${item.dueDate}')" title="Reassign">📅</button>`;
    }
    if (canAdd) {
      actionBtns += `<button class="btn btn-sm btn-outline" onclick="event.stopPropagation(); openNoteEditModal('${item.id}', '${item.collection}')" title="Edit">✏️</button>`;
    }
    if (isAdmin) {
      const delFn = isVehicle ? 'deleteNote' : 'deleteGeneralNote';
      actionBtns += `<button class="btn btn-sm btn-danger" onclick="event.stopPropagation(); ${delFn}('${item.id}')" title="Delete">✕</button>`;
    }
    return `
      <div class="cal-detail-item${item.urgent ? ' cal-detail-urgent' : ''}${isOverdue ? ' cal-detail-overdue' : ''}">
        <button class="followup-check" onclick="event.stopPropagation(); ${markFn}('${item.id}')" title="Mark done">&#9744;</button>
        <div class="cal-detail-info">
          <div class="cal-detail-text">${timeLabel}${urgentTag}${escapeHtml(item.text)}</div>
          <div class="cal-detail-meta">${metaLabel}${creatorLabel}</div>
        </div>
        <div class="cal-detail-actions">${actionBtns}</div>
      </div>`;
  }

  let html = '';

  // Sort: timed tasks first (by time), then all-day (by urgency desc)
  const timedTasks = tasks.filter(t => t.dueTime).sort((a, b) => a.dueTime.localeCompare(b.dueTime));
  const untimedTasks = tasks.filter(t => !t.dueTime).sort((a, b) => (b.urgent ? 1 : 0) - (a.urgent ? 1 : 0));

  if (tasks.length > 0) {
    html += '<div class="cal-flat-list">';
    // Timed tasks first
    for (const item of timedTasks) html += renderCalItem(item);
    // Divider if both types exist
    if (timedTasks.length > 0 && untimedTasks.length > 0) {
      html += '<div class="cal-list-divider">All Day</div>';
    }
    // All-day tasks
    for (const item of untimedTasks) html += renderCalItem(item);
    html += '</div>';
  } else if (!canAdd) {
    html += '<p class="hint">No tasks for this date.</p>';
  }

  // Add Task form at bottom, collapsed by default
  if (canAdd) {
    html += `
      <div class="cal-add-task-toggle" id="cal-add-toggle-wrap">
        <button class="btn btn-sm btn-outline cal-add-toggle-btn" onclick="document.getElementById('cal-add-toggle-wrap').querySelector('.cal-add-toggle-btn').style.display='none'; document.getElementById('cal-add-form-inner').style.display='';">➕ Add Task</button>
        <div id="cal-add-form-inner" style="display:none;" class="cal-add-task-form">
          <textarea id="cal-add-task-text" class="note-textarea" placeholder="Task description..." maxlength="500" rows="2"></textarea>
          <div class="cal-add-task-controls">
            <input type="time" id="cal-add-task-time" class="cal-time-input" title="Set time (optional)">
            <label class="note-followup-label"><input type="checkbox" id="cal-add-task-urgent"> 🚨 Urgent</label>
            <button class="btn btn-sm btn-primary" onclick="calendarAddTask('${dateStr}')">Save</button>
          </div>
        </div>
      </div>`;
  }

  detailList.innerHTML = html;
  detailEl.style.display = '';
};

// Add task from calendar
window.calendarAddTask = async function(dateStr) {
  const text = $('cal-add-task-text') ? $('cal-add-task-text').value.trim() : '';
  if (!text) {
    toast('Enter a task description.', 'warning');
    return;
  }
  const isUrgent = $('cal-add-task-urgent') ? $('cal-add-task-urgent').checked : false;
  const dueTime = $('cal-add-task-time') ? $('cal-add-task-time').value : '';
  try {
    const data = {
      text,
      isFollowUp: true,
      done: false,
      urgent: isUrgent,
      dueDate: dateStr,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      createdBy: currentUser.uid,
      createdByName: currentUser.displayName || currentUser.email
    };
    if (dueTime) data.dueTime = dueTime;
    await db.collection('generalNotes').add(data);
    toast('Task added!', 'success');
    loadDashboardFollowUps();
    loadGeneralNotes();
  } catch (err) {
    console.error('Calendar add task error:', err);
    toast('Failed to add task.', 'error');
  }
};

// Reassign overdue task (admin only)
window.openReassignTask = function(docId, collection, currentDueDate) {
  if (currentUserRole !== 'admin') return;
  const existingModal = document.querySelector('.reassign-modal-overlay');
  if (existingModal) existingModal.remove();

  const overlay = document.createElement('div');
  overlay.className = 'reassign-modal-overlay';
  overlay.innerHTML = `
    <div class="reassign-modal">
      <h4>📅 Reassign Task</h4>
      <p>Current due date: <strong>${currentDueDate}</strong></p>
      <div class="form-group">
        <label>New Due Date</label>
        <input type="date" id="reassign-new-date" class="form-select" value="${todayDateString()}">
      </div>
      <div class="reassign-modal-actions">
        <button class="btn btn-primary" id="btn-reassign-confirm">Reassign</button>
        <button class="btn btn-outline" id="btn-reassign-cancel">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelector('#btn-reassign-cancel').onclick = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  overlay.querySelector('#btn-reassign-confirm').onclick = async () => {
    const newDate = document.querySelector('#reassign-new-date').value;
    if (!newDate) {
      toast('Select a new date.', 'warning');
      return;
    }
    try {
      await db.collection(collection).doc(docId).update({ dueDate: newDate });
      toast('Task reassigned to ' + newDate, 'success');
      overlay.remove();
      loadDashboardFollowUps();
      loadGeneralNotes();
    } catch (err) {
      console.error('Reassign error:', err);
      toast('Failed to reassign.', 'error');
    }
  };
};

// Calendar navigation
$('cal-prev').addEventListener('click', () => {
  calendarMonth.setMonth(calendarMonth.getMonth() - 1);
  renderCalendarGrid();
});
$('cal-next').addEventListener('click', () => {
  calendarMonth.setMonth(calendarMonth.getMonth() + 1);
  renderCalendarGrid();
});
$('cal-detail-close').addEventListener('click', () => {
  $('task-calendar-detail').style.display = 'none';
});

// Task panel open/close
function openTaskPanel() {
  const panel = $('task-panel-overlay');
  if (panel) panel.style.display = 'flex';
  initTaskPanelForRole();
  loadDashboardFollowUps();
  loadGeneralNotes();
}
function closeTaskPanel() {
  const panel = $('task-panel-overlay');
  if (panel) panel.style.display = 'none';
}
window.openTaskPanel = openTaskPanel;
window.closeTaskPanel = closeTaskPanel;

// Open the task panel directly on the compliance tab
window.openComplianceView = function() {
  openTaskPanel();
  // Switch tab after panel opens
  setTimeout(() => switchTaskTab('compliance'), 50);
};

// ============ FLEET COMPLIANCE WIDGET (dashboard) ============
function loadFleetComplianceWidget() {
  const section = $('compliance-widget');
  const list = $('compliance-widget-list');
  const badge = $('compliance-widget-badge');
  const navBadge = $('compliance-alert-count');
  if (!section || !list) return;

  // Auto-cleanup: delete open compliance notes for vehicles that are now compliant
  autoCleanupResolvedComplianceNotes();

  // Collect vehicles with compliance issues (≤30 days or expired)
  const issues = [];
  vehiclesCache.forEach(v => {
    const safetyS = complianceMonthStatus(v.complianceSafety);
    const regS = complianceMonthStatus(v.complianceRegistration);
    const vehicleIssues = [];
    if (safetyS.cls === 'compliance-urgent' || safetyS.cls === 'compliance-warn') {
      vehicleIssues.push({ type: 'Safety', label: safetyS.label, daysLeft: safetyS.daysLeft, cls: safetyS.cls });
    }
    if (regS.cls === 'compliance-urgent' || regS.cls === 'compliance-warn') {
      vehicleIssues.push({ type: 'Registration', label: regS.label, daysLeft: regS.daysLeft, cls: regS.cls });
    }
    if (vehicleIssues.length > 0) issues.push({ v, vehicleIssues });
  });

  // Update nav badge (always, even though widget is hidden)
  const overdueCount = issues.reduce((n, g) => n + g.vehicleIssues.filter(i => i.daysLeft < 0).length, 0);
  if (navBadge) {
    navBadge.textContent = issues.length;
    navBadge.classList.toggle('count-zero', issues.length === 0);
    navBadge.classList.toggle('has-urgent', overdueCount > 0);
  }

  if (issues.length === 0) {
    // Widget is hidden — only keep nav badge updated
    return;
  }
  // Widget is hidden from dashboard; still populate in case it's ever shown
  if (badge) { badge.textContent = issues.length; }

  // Sort: overdue-first, then by worst daysLeft
  issues.sort((a, b) => {
    const aWorst = Math.min(...a.vehicleIssues.map(i => i.daysLeft ?? 999));
    const bWorst = Math.min(...b.vehicleIssues.map(i => i.daysLeft ?? 999));
    return aWorst - bWorst;
  });

  let html = '<div class="cwg">';
  for (const { v, vehicleIssues } of issues) {
    const hasOverdue = vehicleIssues.some(i => i.daysLeft < 0);
    html += `<div class="cwg-row${hasOverdue ? ' cwg-row-overdue' : ''}" onclick="openVehicleCompliancePage('${v.id}')" title="${escapeHtml(v.plate)}">`;
    html += `<span class="cwg-plate">🚗 ${escapeHtml(v.plate)}</span>`;
    html += '<span class="cwg-tags">';
    for (const issue of vehicleIssues) {
      const tagCls = issue.daysLeft < 0 ? 'cwg-tag cwg-tag-overdue'
        : issue.daysLeft <= 15 ? 'cwg-tag cwg-tag-urgent'
        : 'cwg-tag cwg-tag-warn';
      html += `<span class="${tagCls}">${issue.type}: ${issue.label}</span>`;
    }
    html += '</span></div>';
  }
  html += '</div>';
  list.innerHTML = html;
}

window.openVehicleCompliancePage = function(vehicleId) {
  openVehiclePage(vehicleId);
  setTimeout(() => {
    // Auto-expand compliance body and scroll to it
    const body = $('compliance-inline-body');
    const chevron = $('compliance-bar-chevron');
    const wrap = $('compliance-bar-wrap');
    if (body && body.style.display === 'none') {
      body.style.display = 'block';
      if (chevron) chevron.innerHTML = '&#9650;';
    }
    if (wrap) wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, 500);
};

// Automatically delete open compliance follow-up notes when the vehicle is now compliant (>30 days left)
async function autoCleanupResolvedComplianceNotes() {
  for (const v of vehiclesCache) {
    const checks = [
      { type: 'safety', status: complianceMonthStatus(v.complianceSafety) },
      { type: 'registration', status: complianceMonthStatus(v.complianceRegistration) },
    ];
    for (const { type, status } of checks) {
      // Only clean up if truly compliant (not just warn — give benefit of doubt to warn range)
      if (status.cls !== 'compliance-ok') continue;
      try {
        const snap = await db.collection('vehicleNotes')
          .where('vehicleId', '==', v.id)
          .where('sourceType', '==', 'compliance')
          .where('complianceType', '==', type)
          .where('done', '==', false)
          .limit(10)
          .get();
        if (snap.empty) continue;
        const batch = db.batch();
        snap.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
      } catch (e) { /* non-critical */ }
    }
  }
}

// Refresh the "Due in Xd" text + urgency on any still-open compliance notes so they stay current.
async function refreshStaleComplianceNotes() {
  for (const v of vehiclesCache) {
    const checks = [
      { type: 'safety', typeName: 'Safety Inspection', status: complianceMonthStatus(v.complianceSafety) },
      { type: 'registration', typeName: 'Registration', status: complianceMonthStatus(v.complianceRegistration) },
    ];
    for (const { type, typeName, status } of checks) {
      // Only refresh for notes that should still exist (warn or urgent)
      if (status.cls !== 'compliance-warn' && status.cls !== 'compliance-urgent') continue;
      try {
        const snap = await db.collection('vehicleNotes')
          .where('vehicleId', '==', v.id)
          .where('sourceType', '==', 'compliance')
          .where('complianceType', '==', type)
          .where('done', '==', false)
          .limit(10)
          .get();
        if (snap.empty) continue;
        const newText = `${typeName} — ${status.label} for ${v.plate || v.id}.`;
        const isOverdue = typeof status.daysLeft === 'number' && status.daysLeft < 0;
        const isUrgent = status.cls === 'compliance-urgent';
        const batch = db.batch();
        snap.forEach(doc => {
          const d = doc.data();
          if (d.text !== newText || d.urgent !== isUrgent) {
            batch.update(doc.ref, {
              text: newText,
              urgent: isUrgent,
              taskStatus: isOverdue ? 'urgent' : (isUrgent ? 'urgent' : 'scheduled'),
            });
          }
        });
        await batch.commit();
      } catch (e) { /* non-critical */ }
    }
  }
}

// ================================================================
// FLEET PRODUCTIVITY REPORT
// ================================================================
window.openProductivityReport = function() {
  const modal = $('productivity-modal');
  if (!modal) return;
  // Default range: current calendar month (shows full-month occupancy including future bookings)
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), 1);
  const end   = new Date(today.getFullYear(), today.getMonth() + 1, 0); // last day of month
  const fmt = d => d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  $('prod-range-start').value = fmt(start);
  $('prod-range-end').value = fmt(end);
  modal.style.display = '';
  runProductivityReport();
};

window.closeProductivityReport = function() {
  const modal = $('productivity-modal');
  if (modal) modal.style.display = 'none';
};

window.runProductivityReport = async function() {
  const resultsEl = $('prod-results');
  const alertEl = $('prod-alert-banner');
  if (!resultsEl) return;
  resultsEl.innerHTML = '<p class="hint" style="padding:24px;text-align:center;">Loading…</p>';
  alertEl.style.display = 'none';

  const rangeStart = $('prod-range-start').value;
  const rangeEnd = $('prod-range-end').value;
  if (!rangeStart || !rangeEnd) { resultsEl.innerHTML = '<p class="hint" style="padding:16px;">Please select a date range.</p>'; return; }

  // Build set of all calendar dates in range
  function datesInRange(s, e) {
    const days = [];
    const cur = new Date(s + 'T00:00:00');
    const end = new Date(e + 'T00:00:00');
    while (cur <= end) {
      days.push(cur.getFullYear() + '-' + String(cur.getMonth()+1).padStart(2,'0') + '-' + String(cur.getDate()).padStart(2,'0'));
      cur.setDate(cur.getDate() + 1);
    }
    return days;
  }

  const rangeDays = datesInRange(rangeStart, rangeEnd);
  const totalDays = rangeDays.length;
  const rangeSet = new Set(rangeDays);

  try {
    // Query all tripLogs whose startDate falls on or before rangeEnd
    let snap = { forEach: () => {} }; // default empty if collection has no data yet
    try {
      snap = await db.collection('tripLogs')
        .where('startDate', '<=', rangeEnd)
        .get();
    } catch(qErr) {
      console.warn('tripLogs query error (likely no documents yet):', qErr);
    }

    // Group logs by vehicleId
    const logsByVehicle = {};
    snap.forEach(doc => {
      const d = doc.data();
      if (d.endDate < rangeStart) return; // log ends before our range
      if (!logsByVehicle[d.vehicleId]) {
        logsByVehicle[d.vehicleId] = {
          plate: d.vehiclePlate,
          makeModel: d.vehicleMakeModel,
          logs: [],
        };
      }
      logsByVehicle[d.vehicleId].logs.push(d);
    });

    // Per vehicle: build booked day set, compute idle streak
    const today = new Date();
    const todayStr = today.getFullYear() + '-' + String(today.getMonth()+1).padStart(2,'0') + '-' + String(today.getDate()).padStart(2,'0');

    const rows = vehiclesCache.map(v => {
      const entry = logsByVehicle[v.id] || { plate: v.plate, makeModel: ((v.make||'')+' '+(v.model||'')).trim(), logs: [] };
      const bookedSet = new Set();
      let lastBookingDate = '';
      let tripCount = 0;
      entry.logs.forEach(log => {
        if (log.cancelled) return; // skip cancelled trips
        tripCount++;
        // Turo-style: the return/end date is NOT a rental day.
        // Exception 1: still-ongoing trip (end beyond range) — count through range boundary.
        // Exception 2: same-day trip (endDate <= startDate) — count as 1 day.
        let countEnd;
        if (log.endDate > rangeEnd) {
          countEnd = rangeEnd; // still ongoing — count through range boundary
        } else if (log.endDate <= log.startDate) {
          // Same-day or bad data — count the start day as 1 rental day
          countEnd = log.startDate;
        } else {
          // Completed trip: subtract 1 day so return day isn't counted
          const endDt = new Date(log.endDate + 'T00:00:00');
          endDt.setDate(endDt.getDate() - 1);
          countEnd = endDt.getFullYear() + '-' + String(endDt.getMonth()+1).padStart(2,'0') + '-' + String(endDt.getDate()).padStart(2,'0');
        }
        const countStart = log.startDate < rangeStart ? rangeStart : log.startDate;
        if (countStart <= countEnd) {
          datesInRange(countStart, countEnd).forEach(d => bookedSet.add(d));
        }
        if (log.endDate > lastBookingDate) lastBookingDate = log.endDate;
      });

      // Live-trip fallback: vehicle is currently on-trip/private-trip but no tripLog covers today.
      // Use tripScheduledStart→tripReturnDate (Turo-style) to fill the full current trip range.
      const isCurrentlyOnTrip = v.tripStatus === 'on-trip' || v.tripStatus === 'private-trip';
      if (isCurrentlyOnTrip && rangeSet.has(todayStr) && !bookedSet.has(todayStr)) {
        // Determine trip start: tripScheduledStart if set, otherwise use most recent log's
        // startDate as the best proxy for when this trip began (handles same-day direct-on-trip logs)
        let liveStart = todayStr;
        if (v.tripScheduledStart) {
          const ss = v.tripScheduledStart.toDate ? v.tripScheduledStart.toDate() : new Date(v.tripScheduledStart);
          liveStart = ss.getFullYear() + '-' + String(ss.getMonth()+1).padStart(2,'0') + '-' + String(ss.getDate()).padStart(2,'0');
        } else {
          const activeLogs = entry.logs.filter(l => !l.cancelled && l.startDate <= todayStr);
          if (activeLogs.length > 0) {
            const mostRecentStart = activeLogs.reduce((best, l) => l.startDate > best ? l.startDate : best, '');
            if (mostRecentStart) liveStart = mostRecentStart;
          }
        }
        // Determine trip end: tripReturnDate (Turo-style: return day not counted), else today
        let liveEnd = todayStr;
        if (v.tripReturnDate) {
          const rd = v.tripReturnDate.toDate ? v.tripReturnDate.toDate() : new Date(v.tripReturnDate);
          const rdDate = new Date(rd.getFullYear(), rd.getMonth(), rd.getDate());
          rdDate.setDate(rdDate.getDate() - 1); // exclude return day
          liveEnd = rdDate.getFullYear() + '-' + String(rdDate.getMonth()+1).padStart(2,'0') + '-' + String(rdDate.getDate()).padStart(2,'0');
        }
        // Clamp to report range and cap at today (don't count future days for a live trip)
        const liveCountStart = (liveStart < rangeStart ? rangeStart : liveStart);
        const liveCountEnd   = (liveEnd > todayStr ? todayStr : (liveEnd > rangeEnd ? rangeEnd : liveEnd));
        if (liveCountStart <= liveCountEnd) {
          datesInRange(liveCountStart, liveCountEnd).forEach(d => bookedSet.add(d));
          if (liveCountEnd > lastBookingDate) lastBookingDate = liveCountEnd;
        } else {
          bookedSet.add(todayStr); // absolute fallback: at least today
          if (todayStr > lastBookingDate) lastBookingDate = todayStr;
        }
      }

      const bookedDays = bookedSet.size;
      const utilPct = totalDays > 0 ? Math.round(bookedDays / totalDays * 100) : 0;

      // Current idle streak: how many consecutive days ending today (inclusive) have no booking
      let idleStreak = 0;
      const check = new Date(today);
      while (true) {
        const ds = check.getFullYear() + '-' + String(check.getMonth()+1).padStart(2,'0') + '-' + String(check.getDate()).padStart(2,'0');
        if (bookedSet.has(ds)) break;
        // Also count current live trip status as "booked today"
        if (ds === todayStr && (v.tripStatus === 'on-trip' || v.tripStatus === 'scheduled' || v.tripStatus === 'private-trip')) break;
        idleStreak++;
        check.setDate(check.getDate() - 1);
        if (idleStreak > 365) break; // safety cap
      }

      // Revenue for the period: sum from logs whose startDate falls within range
      let turoRevenue = 0;
      let privateRevenue = 0;
      entry.logs.forEach(log => {
        if (log.cancelled) return;
        const rev = Number(log.revenue) || 0;
        if (rev === 0) return;
        const ls = log.startDate || '';
        if (ls >= rangeStart && ls <= rangeEnd) {
          if (log.tripType === 'private-trip') { privateRevenue += rev; }
          else { turoRevenue += rev; }
        }
      });

      return { v, plate: v.plate, makeModel: entry.makeModel, bookedDays, utilPct, lastBookingDate, idleStreak, tripCount, turoRevenue, privateRevenue };
    });

    // Sort: idle streak > 2 first (descending), then by plate
    rows.sort((a, b) => {
      const aAlert = a.idleStreak > 2 ? 1 : 0;
      const bAlert = b.idleStreak > 2 ? 1 : 0;
      if (aAlert !== bAlert) return bAlert - aAlert;
      return b.idleStreak - a.idleStreak;
    });

    const alertVehicles = rows.filter(r => r.idleStreak > 2);
    if (alertVehicles.length) {
      alertEl.textContent = '⚠️ ' + alertVehicles.length + ' vehicle' + (alertVehicles.length > 1 ? 's' : '') + ' idle for 3+ consecutive days: ' + alertVehicles.map(r => r.plate).join(', ');
      alertEl.style.display = '';
    } else {
      alertEl.style.display = 'none';
    }

    if (!rows.length) {
      resultsEl.innerHTML = '<p class="hint" style="padding:16px;">No vehicles found.</p>';
      return;
    }

    const fmtDate = ds => {
      if (!ds) return '—';
      const [y,m,d] = ds.split('-');
      return new Date(+y, +m-1, +d).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
    };
    const fmtRev = n => n > 0 ? '$' + n.toLocaleString('en-US', {minimumFractionDigits:0, maximumFractionDigits:0}) : '—';

    const fleetTuro = rows.reduce((s,r) => s + r.turoRevenue, 0);
    const fleetPrivate = rows.reduce((s,r) => s + r.privateRevenue, 0);
    const fleetTotal = fleetTuro + fleetPrivate;

    resultsEl.innerHTML = `
      <div class="prod-summary-row" style="display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;">
        <span><span class="prod-summary-label">Period:</span> <strong>${fmtDate(rangeStart)} — ${fmtDate(rangeEnd)}</strong> <span class="prod-summary-label">${totalDays} calendar days</span></span>
        ${fleetTotal > 0 ? `<span class="prod-fleet-rev-row">
          <span class="prod-rev-badge turo">📅 Turo: <strong>${fmtRev(fleetTuro)}</strong></span>
          <span class="prod-rev-badge private">🔒 Private: <strong>${fmtRev(fleetPrivate)}</strong></span>
          <span class="prod-rev-badge total">Fleet Total: <strong>${fmtRev(fleetTotal)}</strong></span>
        </span>` : ''}
      </div>
      <div class="prod-table-wrap">
        <table class="prod-table">
          <thead><tr>
            <th>Vehicle</th>
            <th>Trips</th>
            <th>Turo $</th>
            <th>Private $</th>
            <th>Days Booked</th>
            <th>Utilization</th>
            <th>Last Booking</th>
            <th>Idle Streak</th>
            <th></th>
          </tr></thead>
          <tbody>
            ${rows.map(r => {
              const alertRow = r.idleStreak > 2;
              const idleBadge = r.idleStreak > 2
                ? `<span class="prod-idle-alert">${r.idleStreak}d idle 🚨</span>`
                : (r.idleStreak > 0 ? `<span class="prod-idle-ok">${r.idleStreak}d</span>` : '<span class="prod-idle-ok">Active ✅</span>');
              const utilBar = `<div class="prod-util-wrap"><div class="prod-util-bar" style="width:${r.utilPct}%"></div><span class="prod-util-pct">${r.utilPct}%</span></div>`;
              const tripsDisplay = r.tripCount > 0
                ? `<span class="prod-trip-count">${r.tripCount}</span>`
                : `<span class="prod-trip-zero">—</span>`;
              const turoRevDisplay = r.turoRevenue > 0
                ? `<span class="prod-rev-badge turo">${fmtRev(r.turoRevenue)}</span>`
                : `<span class="prod-trip-zero">—</span>`;
              const privRevDisplay = r.privateRevenue > 0
                ? `<span class="prod-rev-badge private">${fmtRev(r.privateRevenue)}</span>`
                : `<span class="prod-trip-zero">—</span>`;
              return `<tr class="${alertRow ? 'prod-row-alert' : ''}">
                <td><strong>${escapeHtml(r.plate)}</strong><br><span class="prod-make-model">${escapeHtml(r.makeModel)}</span></td>
                <td>${tripsDisplay}</td>
                <td>${turoRevDisplay}</td>
                <td>${privRevDisplay}</td>
                <td>${r.bookedDays} / ${totalDays}</td>
                <td>${utilBar}</td>
                <td>${fmtDate(r.lastBookingDate)}</td>
                <td>${idleBadge}</td>
                <td><button class="btn btn-sm btn-outline prod-trips-btn" onclick="openTripLogs('${r.v.id}','${escapeHtml(r.plate)}')">📋 Trips</button></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
  } catch(e) {
    console.error('Productivity report error:', e);
    resultsEl.innerHTML = '<p class="hint" style="padding:16px;color:#ef4444;">Failed to load report. Check console for details.</p>';
  }
};

// ----------------------------------------------------------------
// Trip Log Viewer — shows all logged trips for a vehicle, allows
// edit (change dates) or delete (cancel / shorten).
// ----------------------------------------------------------------
window.openTripLogs = async function(vehicleId, plate) {
  const existing = document.querySelector('.triplog-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'triplog-overlay';
  overlay.innerHTML = `
    <div class="triplog-modal">
      <div class="triplog-header">
        <h4>📋 Trip Logs — ${escapeHtml(plate)}</h4>
        <button class="prod-close-btn" onclick="this.closest('.triplog-overlay').remove()">✕</button>
      </div>
      <div id="triplog-body" class="triplog-body"><p class="hint" style="padding:16px;text-align:center;">Loading…</p></div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  await _refreshTripLogBody(vehicleId, plate);
};

async function _refreshTripLogBody(vehicleId, plate) {
  const body = document.getElementById('triplog-body');
  if (!body) return;
  try {
    const snap = await db.collection('tripLogs')
      .where('vehicleId', '==', vehicleId)
      .get();
    const logs = [];
    snap.forEach(doc => logs.push({ id: doc.id, ...doc.data() }));
    logs.sort((a, b) => (b.startDate || '').localeCompare(a.startDate || ''));

    if (!logs.length) {
      body.innerHTML = '<p class="hint" style="padding:24px;text-align:center;">No trips logged yet for this vehicle.</p>';
      return;
    }

    const fmtD = ds => {
      if (!ds) return '—';
      const [y,m,d] = ds.split('-');
      return new Date(+y, +m-1, +d).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
    };

    const tripTuroRev = logs.filter(l => !l.cancelled && l.tripType !== 'private-trip').reduce((s,l) => s + (Number(l.revenue)||0), 0);
    const tripPrivRev = logs.filter(l => !l.cancelled && l.tripType === 'private-trip').reduce((s,l) => s + (Number(l.revenue)||0), 0);
    const fmtRev = n => n > 0 ? '$' + n.toLocaleString('en-US', {minimumFractionDigits:0, maximumFractionDigits:0}) : '—';
    const hasTotals = tripTuroRev > 0 || tripPrivRev > 0;
    body.innerHTML = `
      ${hasTotals ? `<div class="triplog-rev-summary">
        <span class="triplog-rev-badge turo">📅 Turo: <strong>${fmtRev(tripTuroRev)}</strong></span>
        <span class="triplog-rev-badge private">🔒 Private: <strong>${fmtRev(tripPrivRev)}</strong></span>
        ${tripTuroRev + tripPrivRev > 0 ? `<span class="triplog-rev-badge total">Total: <strong>${fmtRev(tripTuroRev + tripPrivRev)}</strong></span>` : ''}
      </div>` : ''}
      <table class="prod-table triplog-table">
        <thead><tr><th>Start</th><th>End</th><th>Days</th><th>Type</th><th>Revenue</th><th>Logged By</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${logs.map(log => {
            const cancelled = log.cancelled;
            const typeLabel = log.tripType === 'private-trip' ? '🔒 Private' : '📅 Scheduled';
            const isPrivate = log.tripType === 'private-trip';
            // Compute days this log contributed (Turo-style)
            let logDays = 0;
            if (!cancelled && log.startDate && log.endDate) {
              if (log.endDate <= log.startDate) {
                logDays = 1;
              } else {
                const endDt = new Date(log.endDate + 'T00:00:00');
                endDt.setDate(endDt.getDate() - 1);
                const countEnd = endDt.getFullYear() + '-' + String(endDt.getMonth()+1).padStart(2,'0') + '-' + String(endDt.getDate()).padStart(2,'0');
                if (countEnd >= log.startDate) {
                  const a = new Date(log.startDate + 'T00:00:00');
                  const b = new Date(countEnd + 'T00:00:00');
                  logDays = Math.round((b - a) / 86400000) + 1;
                }
              }
            }
            const daysBadge = cancelled ? '—' : `<span class="prod-trip-count">${logDays}d</span>`;
            const revAmt = Number(log.revenue) || 0;
            const revDisplay = cancelled ? '—' : (revAmt > 0
              ? `<span class="triplog-rev-cell ${isPrivate ? 'private' : 'turo'}">$${revAmt.toLocaleString('en-US', {minimumFractionDigits:0, maximumFractionDigits:0})}</span>`
              : `<button class="btn btn-xs triplog-add-rev-btn" onclick="quickAddRevenue('${log.id}','${escapeHtml(vehicleId)}','${escapeHtml(plate)}',0)">+ $</button>`);
            return `<tr class="${cancelled ? 'triplog-cancelled' : ''}">
              <td>${fmtD(log.startDate)}</td>
              <td>${fmtD(log.endDate)}</td>
              <td>${daysBadge}</td>
              <td>${typeLabel}</td>
              <td>${revDisplay}</td>
              <td>${escapeHtml(log.loggedByName || '—')}</td>
              <td>${cancelled ? '<span class="prod-idle-alert">Cancelled</span>' : '<span class="prod-idle-ok">Active</span>'}</td>
              <td class="triplog-actions">
                ${!cancelled ? `<button class="btn btn-sm btn-outline" onclick="editTripLog('${log.id}','${escapeHtml(vehicleId)}','${escapeHtml(plate)}')">✏️ Edit</button>` : ''}
                <button class="btn btn-sm btn-danger" onclick="deleteTripLog('${log.id}','${escapeHtml(vehicleId)}','${escapeHtml(plate)}')">🗑️</button>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;
  } catch(e) {
    console.error('triplog load error:', e);
    body.innerHTML = '<p class="hint" style="padding:16px;color:#ef4444;">Failed to load trips.</p>';
  }
}

window.editTripLog = async function(logId, vehicleId, plate) {
  const snap = await db.collection('tripLogs').doc(logId).get();
  if (!snap.exists) { toast('Trip not found.', 'error'); return; }
  const log = snap.data();

  const existing = document.querySelector('.triplog-edit-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'triplog-edit-overlay';
  overlay.innerHTML = `
    <div class="triplog-edit-modal">
      <h4>✏️ Edit Trip — ${escapeHtml(plate)}</h4>
      <div class="triplog-edit-field">
        <label>Start Date</label>
        <input type="date" id="tledit-start" class="vehicle-location-custom" value="${log.startDate || ''}">
      </div>
      <div class="triplog-edit-field">
        <label>End Date</label>
        <input type="date" id="tledit-end" class="vehicle-location-custom" value="${log.endDate || ''}">
      </div>
      <div class="triplog-edit-field">
        <label>Revenue <span style="color:#9ca3af;font-size:0.8rem;">(optional — what was earned on this trip)</span></label>
        <div class="tledit-rev-wrap">
          <span class="tledit-rev-prefix">$</span>
          <input type="number" id="tledit-revenue" class="vehicle-location-custom" placeholder="0" min="0" step="1" value="${log.revenue != null ? log.revenue : ''}" style="padding-left:26px;">
        </div>
      </div>
      <div class="triplog-edit-field">
        <label>Note <span style="color:#9ca3af;font-size:0.8rem;">(optional)</span></label>
        <input type="text" id="tledit-note" class="vehicle-location-custom" placeholder="e.g. Shortened – early return" maxlength="200" value="${escapeHtml(log.note || '')}">
      </div>
      <div class="triplog-edit-actions">
        <button class="btn btn-primary" id="tledit-save">Save Changes</button>
        <button class="btn btn-outline" onclick="this.closest('.triplog-edit-overlay').remove()">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  overlay.querySelector('#tledit-save').addEventListener('click', async () => {
    const newStart = overlay.querySelector('#tledit-start').value;
    const newEnd = overlay.querySelector('#tledit-end').value;
    const note = overlay.querySelector('#tledit-note').value.trim();
    const revRaw = overlay.querySelector('#tledit-revenue').value.trim();
    const revenue = revRaw !== '' ? (parseFloat(revRaw) || 0) : null;
    if (!newStart || !newEnd) { toast('Start and end date are required.', 'warning'); return; }
    if (newEnd < newStart) { toast('End date cannot be before start date.', 'warning'); return; }
    try {
      const updateData = {
        startDate: newStart, endDate: newEnd,
        note: note || firebase.firestore.FieldValue.delete(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedBy: currentUser.uid, updatedByName: currentUser.displayName || currentUser.email,
      };
      if (revenue !== null) { updateData.revenue = revenue; } else { updateData.revenue = firebase.firestore.FieldValue.delete(); }
      await db.collection('tripLogs').doc(logId).update(updateData);
      toast('Trip updated.', 'success');
      overlay.remove();
      await _refreshTripLogBody(vehicleId, plate);
    } catch(e) { toast('Failed to update trip.', 'error'); }
  });
};

window.deleteTripLog = async function(logId, vehicleId, plate) {
  const ok = await confirm('Delete Trip Log', 'Remove this trip from the log? This will affect utilization stats.');
  if (!ok) return;
  try {
    await db.collection('tripLogs').doc(logId).delete();
    toast('Trip log deleted.', 'success');
    await _refreshTripLogBody(vehicleId, plate);
  } catch(e) { toast('Failed to delete trip.', 'error'); }
};

// Quick revenue entry — lightweight popup from the trip log table
window.quickAddRevenue = async function(logId, vehicleId, plate, currentRevenue) {
  const existing = document.querySelector('.triplog-reventry-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'triplog-reventry-overlay';
  overlay.innerHTML = `
    <div class="triplog-reventry-modal">
      <h4>💰 Add Revenue</h4>
      <p class="hint" style="margin:0 0 12px;font-size:0.82rem;">Enter the revenue earned for this trip.</p>
      <div class="tledit-rev-wrap">
        <span class="tledit-rev-prefix">$</span>
        <input type="number" id="reventry-amount" class="vehicle-location-custom" placeholder="0" min="0" step="1" style="padding-left:26px;" value="${currentRevenue || ''}">
      </div>
      <div class="triplog-edit-actions" style="margin-top:14px;">
        <button class="btn btn-primary" id="reventry-save">Save</button>
        <button class="btn btn-outline" onclick="this.closest('.triplog-reventry-overlay').remove()">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  // Auto-focus the input
  setTimeout(() => { const inp = overlay.querySelector('#reventry-amount'); if (inp) inp.focus(); }, 80);

  overlay.querySelector('#reventry-save').addEventListener('click', async () => {
    const val = overlay.querySelector('#reventry-amount').value.trim();
    const revenue = val !== '' ? (parseFloat(val) || 0) : 0;
    try {
      await db.collection('tripLogs').doc(logId).update({
        revenue,
        revenueUpdatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        revenueUpdatedBy: currentUser.uid,
      });
      toast('Revenue saved!', 'success');
      overlay.remove();
      await _refreshTripLogBody(vehicleId, plate);
    } catch(e) { toast('Failed to save revenue.', 'error'); }
  });
};

// ================================================================
// VEHICLE INFO TAB (key photo, videos, customer notes)
// ================================================================
window.switchVInfoTab = function(tab) {
  document.querySelectorAll('.vinfo-tab').forEach(b => b.classList.toggle('active', b.dataset.vtab === tab));
  ['keys','cheatsheet','videos','notes'].forEach(t => {
    const el = $('vinfo-tab-' + t);
    if (el) el.style.display = t === tab ? '' : 'none';
  });
};

function loadVehicleInfoSection(v) {
  // Key photo
  const img = $('vinfo-key-img');
  const wrap = $('vinfo-key-img-wrap');
  const lbl = $('vinfo-key-upload-label');
  if (v.vehicleInfoKeyPhotoUrl && img) {
    img.src = v.vehicleInfoKeyPhotoUrl;
    if (wrap) wrap.style.display = '';
    if (lbl) lbl.style.display = 'none';
  } else {
    if (wrap) wrap.style.display = 'none';
    if (lbl) lbl.style.display = '';
  }
  // Videos
  renderVInfoVideos(v.vehicleInfoVideos || []);
  // Customer notes
  const notesEl = $('vinfo-customer-notes');
  if (notesEl) notesEl.value = v.vehicleInfoNotes || '';
  // Cheat sheet
  const cs = v.vehicleCheatSheet || {};
  const isDual = !!(cs.tireFront || cs.tireRear);
  const dualBox = $('cheat-tire-dual');
  if (dualBox) dualBox.checked = isDual;
  const setV = (id, val) => { const el = $(id); if (el) el.value = val || ''; };
  setV('cheat-tire-all', cs.tireAll);
  setV('cheat-tire-front', cs.tireFront);
  setV('cheat-tire-rear', cs.tireRear);
  setV('cheat-wiper-driver', cs.wiperDriver);
  setV('cheat-wiper-pass', cs.wiperPass);
  setV('cheat-wiper-rear', cs.wiperRear);
  setV('cheat-oil', cs.oil);
  setV('cheat-battery', cs.battery);
  setV('cheat-coolant', cs.coolant);
  setV('cheat-light-head', cs.lightHead);
  setV('cheat-light-tail', cs.lightTail);
  setV('cheat-light-turn', cs.lightTurn);
  // Gas buttons
  const gasHidden = $('cheat-gas');
  if (gasHidden) gasHidden.value = cs.gas || '';
  document.querySelectorAll('.cheat-gas-btn').forEach(btn => {
    btn.classList.toggle('cheat-gas-active', btn.dataset.gas === cs.gas);
  });
  // Apply dual-tire visibility
  window.toggleDualTire(isDual);
}

// Toggle single vs dual tire rows in cheat sheet
window.toggleDualTire = function(isDual) {
  const single = document.getElementById('cheat-tire-single-row');
  const dual = document.getElementById('cheat-tire-dual-row');
  if (single) single.style.display = isDual ? 'none' : '';
  if (dual) dual.style.display = isDual ? '' : 'none';
};

// Wire up gas-type buttons once (document-level delegation; safe even if DOM rebuilt)
document.addEventListener('click', function(e) {
  const btn = e.target.closest('.cheat-gas-btn');
  if (!btn) return;
  e.preventDefault();
  const gas = btn.dataset.gas;
  const hidden = document.getElementById('cheat-gas');
  if (hidden) hidden.value = gas;
  document.querySelectorAll('.cheat-gas-btn').forEach(b => {
    b.classList.toggle('cheat-gas-active', b === btn);
  });
});

function renderVInfoVideos(videos) {
  const list = $('vinfo-videos-list');
  if (!list) return;
  if (!videos.length) { list.innerHTML = '<p class="hint">No videos added yet.</p>'; return; }
  list.innerHTML = videos.map((item, i) => {
    const url = typeof item === 'string' ? item : (item.url || '');
    const label = typeof item === 'string' ? '' : (item.label || '');
    const videoId = extractYouTubeId(url);
    const thumb = videoId ? `<img src="https://img.youtube.com/vi/${videoId}/default.jpg" class="vinfo-video-thumb">` : '';
    return `<div class="vinfo-video-row">
      ${label ? `<div class="vinfo-video-label-display">${escapeHtml(label)}</div>` : ''}
      <div class="vinfo-video-content">
        ${thumb}
        <a href="${escapeHtml(url)}" target="_blank" class="compliance-doc-anchor vinfo-video-link">${escapeHtml(url)}</a>
        <button class="btn btn-sm btn-danger" onclick="removeVInfoVideo(${i})" title="Remove">\u00d7</button>
      </div>
    </div>`;
  }).join('');
}

function extractYouTubeId(url) {
  const m = url.match(/(?:v=|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

window.addVInfoVideo = function() {
  const labelInput = $('vinfo-video-label');
  const urlInput = $('vinfo-video-url');
  const url = (urlInput.value || '').trim();
  if (!url) { urlInput.focus(); return; }
  const label = labelInput ? (labelInput.value || '').trim() : '';
  const entry = label ? { label, url } : url;
  const videos = [...(selectedVehicle.vehicleInfoVideos || []), entry];
  selectedVehicle.vehicleInfoVideos = videos;
  urlInput.value = '';
  if (labelInput) labelInput.value = '';
  renderVInfoVideos(videos);
};

window.removeVInfoVideo = function(idx) {
  const videos = (selectedVehicle.vehicleInfoVideos || []).filter((_, i) => i !== idx);
  selectedVehicle.vehicleInfoVideos = videos;
  renderVInfoVideos(videos);
};

$('vinfo-key-upload').addEventListener('change', async function() {
  const file = this.files[0];
  if (!file || !selectedVehicle) return;
  $('vinfo-key-uploading').style.display = '';
  try {
    const st = getStorage();
    const ref = st.ref('vehicles/' + sanitizePlate(selectedVehicle.plate) + '/info/key_placement.jpg');
    await ref.put(await compressImage(file), { contentType: 'image/jpeg' });
    const url = await ref.getDownloadURL();
    await db.collection('vehicles').doc(selectedVehicle.id).update({ vehicleInfoKeyPhotoUrl: url });
    selectedVehicle.vehicleInfoKeyPhotoUrl = url;
    const cached = vehiclesCache.find(v => v.id === selectedVehicle.id);
    if (cached) cached.vehicleInfoKeyPhotoUrl = url;
    loadVehicleInfoSection(selectedVehicle);
    toast('Key photo saved \u2705', 'success');
  } catch(e) { console.error('Key photo upload error', e); toast('Upload failed.', 'error'); }
  finally { $('vinfo-key-uploading').style.display = 'none'; this.value = ''; }
});

$('btn-save-vehicle-info').addEventListener('click', async () => {
  if (!selectedVehicle) return;
  try {
    const notesVal = $('vinfo-customer-notes').value.trim();
    // Cheat sheet
    const isDual = $('cheat-tire-dual') && $('cheat-tire-dual').checked;
    const getV = (id) => { const el = $(id); return el ? el.value.trim() : ''; };
    const cheatSheet = {
      tireAll:     isDual ? '' : getV('cheat-tire-all'),
      tireFront:   isDual ? getV('cheat-tire-front') : '',
      tireRear:    isDual ? getV('cheat-tire-rear') : '',
      wiperDriver: getV('cheat-wiper-driver'),
      wiperPass:   getV('cheat-wiper-pass'),
      wiperRear:   getV('cheat-wiper-rear'),
      oil:         getV('cheat-oil'),
      gas:         $('cheat-gas') ? $('cheat-gas').value : '',
      battery:     getV('cheat-battery'),
      coolant:     getV('cheat-coolant'),
      lightHead:   getV('cheat-light-head'),
      lightTail:   getV('cheat-light-tail'),
      lightTurn:   getV('cheat-light-turn'),
    };
    // Remove empty keys to keep Firestore clean
    Object.keys(cheatSheet).forEach(k => { if (!cheatSheet[k]) delete cheatSheet[k]; });
    const data = {
      vehicleInfoNotes: notesVal || null,
      vehicleInfoVideos: selectedVehicle.vehicleInfoVideos || [],
      vehicleCheatSheet: cheatSheet,
    };
    await db.collection('vehicles').doc(selectedVehicle.id).update(data);
    Object.assign(selectedVehicle, data);
    const cached = vehiclesCache.find(v => v.id === selectedVehicle.id);
    if (cached) Object.assign(cached, data);
    toast('Vehicle info saved \u2705', 'success');
  } catch(e) { console.error('Save vehicle info error', e); toast('Save failed.', 'error'); }
});

// ================================================================
// LEARNING CENTER
// ================================================================
const pages_extended = {};
pages_extended.learning = $('page-learning');

window.openLearningPage = function() {
  const disp = $('learning-diploma-name');
  if (disp && currentUser) disp.textContent = currentUser.displayName || currentUser.email;
  const shareBtn = $('btn-add-shared-resource');
  if (shareBtn) shareBtn.style.display = currentUserRole === 'admin' ? '' : 'none';
  // Populate admin user filter dropdown
  const filterSel = $('learning-user-filter');
  if (filterSel) {
    if (currentUserRole === 'admin') {
      filterSel.style.display = '';
      if (filterSel.options.length === 0) {
        filterSel.innerHTML = '<option value="">👤 All users</option>';
        // Populate from users list
        db.collection('users').orderBy('displayName').get().then(snap => {
          snap.forEach(d => {
            const u = d.data();
            const opt = document.createElement('option');
            opt.value = d.id;
            opt.textContent = u.displayName || u.email || d.id;
            filterSel.appendChild(opt);
          });
        }).catch(() => {});
      }
    } else {
      filterSel.style.display = 'none';
    }
  }
  // Use the showPage mechanism but add the page if it's not registered
  Object.values(pages).forEach(p => p.classList.remove('active'));
  const pg = $('page-learning');
  if (pg) pg.classList.add('active');
  window.scrollTo(0, 0);
  loadLearningItems();
};

window.closeLearningPage = function() {
  showPage('dashboard');
};

async function loadLearningItems() {
  const myList = $('learning-items-list');
  const sharedList = $('shared-resources-list');
  if (!myList || !sharedList || !currentUser) return;

  myList.innerHTML = '<p class="hint">Loading\u2026</p>';
  sharedList.innerHTML = '<p class="hint">Loading\u2026</p>';

  // Admin can filter by user; default is current user
  const filterSel = $('learning-user-filter');
  const filterUid = (filterSel && filterSel.value) ? filterSel.value : currentUser.uid;
  const isViewingOwn = filterUid === currentUser.uid;
  const canEditPersonal = isViewingOwn || currentUserRole === 'admin';

  // Update diploma subtitle to reflect viewed user
  const disp = $('learning-diploma-name');
  if (disp) {
    if (!isViewingOwn && filterSel) {
      const selOpt = filterSel.options[filterSel.selectedIndex];
      disp.textContent = (selOpt ? selOpt.textContent : filterUid) + "'s Items";
    } else {
      disp.textContent = currentUser.displayName || currentUser.email;
    }
  }

  try {
    // Query by uid only — no orderBy to avoid composite index requirement; sort client-side
    const queries = [
      db.collection('learningItems').where('uid', '==', filterUid).limit(100).get(),
      db.collection('learningItems').where('scope', '==', 'shared').limit(50).get(),
    ];
    // If admin is viewing another user's items, also fetch current user's wishlist separately
    const needsOwnWishlist = filterUid !== currentUser.uid;
    if (needsOwnWishlist) {
      queries.push(db.collection('learningItems').where('uid', '==', currentUser.uid).where('scope', '==', 'wishlist').limit(50).get());
    }
    const results = await Promise.all(queries);
    const [mySnap, sharedSnap, ownWishSnap] = results;
    // Filter to personal items only (scope === 'personal'), sort by createdAt desc
    const personalDocs = mySnap.docs
      .filter(d => d.data().scope === 'personal')
      .sort((a, b) => {
        const av = a.data().createdAt ? (a.data().createdAt.toMillis ? a.data().createdAt.toMillis() : 0) : 0;
        const bv = b.data().createdAt ? (b.data().createdAt.toMillis ? b.data().createdAt.toMillis() : 0) : 0;
        return bv - av;
      });
    const sharedDocs = sharedSnap.docs.sort((a, b) => {
      const av = a.data().createdAt ? (a.data().createdAt.toMillis ? a.data().createdAt.toMillis() : 0) : 0;
      const bv = b.data().createdAt ? (b.data().createdAt.toMillis ? b.data().createdAt.toMillis() : 0) : 0;
      return bv - av;
    });
    const toSnap = (arr) => ({ empty: arr.length === 0, forEach: (fn) => arr.forEach(fn) });
    renderLearningList(myList, toSnap(personalDocs), canEditPersonal);
    renderLearningList(sharedList, toSnap(sharedDocs), currentUserRole === 'admin');
    // Wishlist: always current user's own goals
    const wishSourceDocs = needsOwnWishlist
      ? (ownWishSnap ? ownWishSnap.docs : [])
      : mySnap.docs.filter(d => d.data().scope === 'wishlist' && d.data().uid === currentUser.uid);
    const wishDocs = wishSourceDocs.sort((a, b) => {
        const av = a.data().createdAt ? (a.data().createdAt.toMillis ? a.data().createdAt.toMillis() : 0) : 0;
        const bv = b.data().createdAt ? (b.data().createdAt.toMillis ? b.data().createdAt.toMillis() : 0) : 0;
        return av - bv; // oldest first for a goal list
      });
    renderWishlist(wishDocs);
  } catch(e) {
    console.error('Load learning items error', e);
    myList.innerHTML = '<p class="hint">Error loading items.</p>';
  }
}

function renderLearningList(container, snap, canEdit) {
  if (snap.empty) { container.innerHTML = '<p class="hint">Nothing here yet.</p>'; return; }
  let html = '';
  snap.forEach(doc => {
    const d = doc.data();
    let contentHtml = '';
    if (d.type === 'video') {
      const vid = extractYouTubeId(d.content || '');
      contentHtml = vid
        ? `<div class="li-embed"><iframe width="100%" height="200" src="https://www.youtube.com/embed/${vid}" frameborder="0" allowfullscreen loading="lazy"></iframe></div>`
        : `<a href="${escapeHtml(d.content)}" target="_blank" class="compliance-doc-anchor">${escapeHtml(d.content)}</a>`;
    } else if (d.type === 'link') {
      contentHtml = `<a href="${escapeHtml(d.content)}" target="_blank" class="compliance-doc-anchor">🔗 ${escapeHtml(d.title || d.content)}</a>`;
    } else {
      contentHtml = `<p class="li-text">${escapeHtml(d.content || '').replace(/\n/g, '<br>')}</p>`;
    }
    // Completion log
    const completions = d.completions || [];
    const myCompletion = completions.find(c => c.uid === currentUser.uid);
    const completionBadge = myCompletion
      ? `<span class="li-completed-badge">✅ ${myCompletion.date}</span>`
      : '';
    const allCompletions = completions.length > 0
      ? `<div class="li-completions">${completions.map(c => `<span class="li-comp-chip">✅ ${escapeHtml(c.name || c.uid)} · ${c.date}</span>`).join('')}</div>`
      : '';
    const editBtns = canEdit
      ? `<button class="btn btn-sm btn-outline" onclick="editLearningItem('${doc.id}','${escapeHtml(JSON.stringify(d)).replace(/'/g, "&#39;")}')">Edit</button>
         <button class="btn btn-sm btn-danger" onclick="deleteLearningItem('${doc.id}')">Delete</button>`
      : '';
    html += `<div class="li-card">
      <div class="li-header">
        <span class="li-title">${escapeHtml(d.title || 'Untitled')}</span>${completionBadge}
        <div class="li-actions">
          <button class="btn btn-sm li-schedule-btn" onclick="scheduleTrainingTask('${doc.id}','${escapeHtml((d.title||'Training')).replace(/'/g,"&#39;")}')">📅 Schedule</button>
          <button class="btn btn-sm ${myCompletion ? 'li-complete-done' : 'li-complete-btn'}" onclick="logLearningCompletion('${doc.id}')">${myCompletion ? '✅ Done' : '🎓 Log Done'}</button>
          ${editBtns}
        </div>
      </div>
      ${contentHtml}
      ${allCompletions}
    </div>`;
  });
  container.innerHTML = html;
}

window.openAddLearningItem = function(scope) {
  $('li-edit-id').value = '';
  $('li-title').value = '';
  $('li-content-text').value = '';
  $('li-video-url').value = '';
  $('li-link-url').value = '';
  $('li-video-preview').innerHTML = '';
  $('li-type').value = 'note';
  $('li-scope').value = scope || 'personal';
  onLearningTypeChange();
  $('learning-modal-title').textContent = '\u2795 Add Learning Item';
  $('learning-item-overlay').style.display = 'flex';
};

window.editLearningItem = function(docId, dataJson) {
  try {
    const d = typeof dataJson === 'string' ? JSON.parse(dataJson) : dataJson;
    $('li-edit-id').value = docId;
    $('li-title').value = d.title || '';
    $('li-type').value = d.type || 'note';
    $('li-scope').value = d.scope || 'personal';
    $('li-content-text').value = d.type === 'note' ? (d.content || '') : '';
    $('li-video-url').value = d.type === 'video' ? (d.content || '') : '';
    $('li-link-url').value = d.type === 'link' ? (d.content || '') : '';
    onLearningTypeChange();
    $('learning-modal-title').textContent = '\u270f\ufe0f Edit Learning Item';
    $('learning-item-overlay').style.display = 'flex';
  } catch(e) { console.error(e); }
};

window.onLearningTypeChange = function() {
  const t = $('li-type').value;
  $('li-content-note').style.display = t === 'note' ? '' : 'none';
  $('li-content-video').style.display = t === 'video' ? '' : 'none';
  $('li-content-link').style.display = t === 'link' ? '' : 'none';
};

window.closeLearningItemModal = function() {
  $('learning-item-overlay').style.display = 'none';
};

// ---- Schedule Training as a follow-up task ----
let _scheduleTrainingDocId = null;
let _scheduleTrainingTitle = '';
window.scheduleTrainingTask = async function(docId, title) {
  _scheduleTrainingDocId = docId;
  _scheduleTrainingTitle = title;
  const sel = $('lt-assignee');
  sel.innerHTML = `<option value="">👥 Whole Team</option><option value="${currentUser.uid}">${escapeHtml(currentUser.displayName || currentUser.email)}</option>`;
  try {
    const snap = await db.collection('users').get();
    snap.forEach(d => {
      if (d.id === currentUser.uid) return;
      const u = d.data();
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = u.displayName || u.email || d.id;
      sel.appendChild(opt);
    });
  } catch(e) {}
  $('lt-title-display').textContent = title;
  $('lt-due-date').value = '';
  $('lt-notes').value = '';
  $('learning-task-overlay').style.display = 'flex';
};

window.closeLearningTaskModal = function() {
  $('learning-task-overlay').style.display = 'none';
};

window.saveTrainingTask = async function() {
  const dueDate = $('lt-due-date').value;
  const sel = $('lt-assignee');
  const assigneeUid = sel.value;
  const assigneeName = sel.selectedOptions[0] ? sel.selectedOptions[0].textContent.trim() : '';
  const notes = $('lt-notes').value.trim();
  const taskText = '🎓 Training: ' + _scheduleTrainingTitle + (notes ? ' — ' + notes : '');
  const taskData = {
    text: taskText,
    isFollowUp: true,
    done: false,
    urgent: false,
    taskStatus: 'scheduled',
    sourceType: 'learning',
    learningDocId: _scheduleTrainingDocId,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    createdBy: currentUser.uid,
    createdByName: currentUser.displayName || currentUser.email,
  };
  if (dueDate) taskData.dueDate = dueDate;
  if (assigneeUid) { taskData.assignedTo = assigneeUid; taskData.assignedToName = assigneeName; }
  try {
    await db.collection('generalNotes').add(taskData);
    closeLearningTaskModal();
    toast('Training task scheduled ✅', 'success');
  } catch(e) { console.error(e); toast('Failed to schedule.', 'error'); }
};

// ---- Log self-taught completion ----
window.logLearningCompletion = async function(docId) {
  const entry = { uid: currentUser.uid, name: currentUser.displayName || currentUser.email, date: todayDateString() };
  try {
    await db.collection('learningItems').doc(docId).update({
      completions: firebase.firestore.FieldValue.arrayUnion(entry),
    });
    toast('Completion logged ✅', 'success');
    loadLearningItems();
  } catch(e) { console.error(e); toast('Failed to log.', 'error'); }
};

// ================================================================
// WANT TO LEARN (personal goal wishlist)
// ================================================================
function renderWishlist(docs) {
  const list = $('want-to-learn-list');
  if (!list) return;
  if (!docs.length) {
    list.innerHTML = '<p class="hint wl-empty">No goals yet — add something you want to learn!</p>';
    return;
  }
  list.innerHTML = docs.map(doc => {
    const d = doc.data();
    return `<div class="wl-item" id="wl-${doc.id}">
      <span class="wl-text">${escapeHtml(d.title || d.content || '')}</span>
      <div class="wl-actions">
        <button class="btn btn-sm wl-start-btn" onclick="startWishlistItem('${doc.id}','${escapeHtml((d.title||d.content||'')).replace(/'/g,"&#39;")}')" title="Move to My Learning Items">📚 Start</button>
        <button class="btn btn-sm wl-remove-btn" onclick="removeWishlistItem('${doc.id}')" title="Remove goal">✕</button>
      </div>
    </div>`;
  }).join('');
}

window.addWantToLearn = async function() {
  const input = $('wl-new-item');
  const text = (input.value || '').trim();
  if (!text) { input.focus(); return; }
  try {
    await db.collection('learningItems').add({
      title: text,
      type: 'note',
      content: '',
      scope: 'wishlist',
      uid: currentUser.uid,
      userName: currentUser.displayName || currentUser.email,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    input.value = '';
    loadLearningItems();
  } catch(e) { console.error(e); toast('Failed to add goal.', 'error'); }
};

window.removeWishlistItem = async function(docId) {
  try {
    await db.collection('learningItems').doc(docId).delete();
    loadLearningItems();
  } catch(e) { toast('Remove failed.', 'error'); }
};

window.startWishlistItem = async function(docId, title) {
  // Convert wishlist item → personal learning item (opens the add modal pre-filled)
  try {
    await db.collection('learningItems').doc(docId).update({ scope: 'personal' });
    toast('Moved to My Learning Items ✅', 'success');
    loadLearningItems();
  } catch(e) { toast('Failed.', 'error'); }
};

window.saveLearningItem = async function() {
  const title = $('li-title').value.trim();
  const type = $('li-type').value;
  const scope = $('li-scope').value;
  const editId = $('li-edit-id').value;
  let content = '';
  if (type === 'note') content = $('li-content-text').value.trim();
  else if (type === 'video') content = $('li-video-url').value.trim();
  else if (type === 'link') content = $('li-link-url').value.trim();
  if (!title && !content) { toast('Enter a title or content.', 'warning'); return; }
  const data = {
    title, type, scope, content,
    uid: currentUser.uid,
    userName: currentUser.displayName || currentUser.email,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
  };
  try {
    if (editId) {
      await db.collection('learningItems').doc(editId).update(data);
    } else {
      data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
      await db.collection('learningItems').add(data);
    }
    closeLearningItemModal();
    loadLearningItems();
    toast('Saved \u2705', 'success');
  } catch(e) { console.error(e); toast('Save failed.', 'error'); }
};

window.deleteLearningItem = async function(docId) {
  if (!(await confirm('Delete Item', 'Delete this item?'))) return;
  try {
    await db.collection('learningItems').doc(docId).delete();
    loadLearningItems();
    toast('Deleted.', 'success');
  } catch(e) { toast('Delete failed.', 'error'); }
};

// Set up role-specific UI in the task panel (admin filter, assignee dropdown)
let _taskPanelUsersLoaded = false;
async function initTaskPanelForRole() {
  // Show/hide the admin user-filter row
  const filterRow = $('task-user-filter-row');
  if (filterRow) filterRow.style.display = (currentUserRole === 'admin') ? '' : 'none';

  if (!_taskPanelUsersLoaded) {
    _taskPanelUsersLoaded = true;
    try {
      const snap = await db.collection('users').orderBy('displayName').get();

      // Populate admin user-filter dropdown
      const filterSel = $('task-user-filter');
      if (filterSel && currentUserRole === 'admin') {
        // Remove all options except the first "All Users"
        while (filterSel.options.length > 1) filterSel.remove(1);
        snap.forEach(doc => {
          const d = doc.data();
          const opt = document.createElement('option');
          opt.value = doc.id;
          opt.textContent = d.displayName || d.email;
          filterSel.appendChild(opt);
        });
      }

      // Populate assignee dropdowns in the task form
      const assignSelectors = ['new-task-assignee', 'general-note-assignee'];
      assignSelectors.forEach(selId => {
        const sel = $(selId);
        if (sel && sel.options.length <= 1) {
          snap.forEach(doc => {
            const d = doc.data();
            const opt = document.createElement('option');
            opt.value = doc.id;
            opt.dataset.name = d.displayName || d.email;
            opt.textContent = d.displayName || d.email;
            sel.appendChild(opt);
          });
        }
      });
    } catch (e) { /* non-critical */ }
  }
}

// Jump to a specific day in the task calendar (inside the task panel)
window.jumpToCalendarDay = function(dateStr) {
  if (!dateStr) return;
  const [y, m] = dateStr.split('-').map(Number);
  calendarMonth = new Date(y, m - 1, 1);
  renderCalendarGrid();
  // Scroll to calendar section within task panel
  const calSection = document.querySelector('.task-panel-body .task-panel-section:last-child');
  const calGrid = $('task-calendar-grid');
  if (calGrid) {
    calGrid.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  // Show the day detail
  setTimeout(() => window.showCalendarDetail(dateStr), 200);
};

// ---- Task context menu (⋯ button on each agenda item) ----
window.openTaskContextMenu = function(docId, col, triggerBtn) {
  // Remove any existing menus
  document.querySelectorAll('.task-ctx-menu').forEach(m => m.remove());

  const menu = document.createElement('div');
  menu.className = 'task-ctx-menu';
  menu.innerHTML = `
    <button class="task-ctx-item" id="ctx-edit">✏️ Edit Task</button>
    <button class="task-ctx-item" id="ctx-date">📅 Change Date</button>
    <div class="task-ctx-divider"></div>
    <div class="task-ctx-label">Move to:</div>
    <button class="task-ctx-item ctx-move-urgent" id="ctx-move-urgent">🚨 Urgent</button>
    <button class="task-ctx-item ctx-move-scheduled" id="ctx-move-scheduled">🔵 Scheduled</button>
    <button class="task-ctx-item ctx-move-monitoring" id="ctx-move-monitoring">🟢 Monitoring</button>
    <button class="task-ctx-item ctx-move-done" id="ctx-move-done">✅ Mark Complete</button>
    <div class="task-ctx-divider"></div>
    <button class="task-ctx-item" id="ctx-vehicle">🚗 Loading…</button>
    <button class="task-ctx-item task-ctx-danger" id="ctx-delete">🗑️ Delete Task</button>
  `;
  document.body.appendChild(menu);

  // Position near the trigger button using fixed coordinates (no scrollY needed)
  const rect = triggerBtn.getBoundingClientRect();
  const menuW = 210;
  const menuH = 340; // approximate
  let left = rect.right - menuW;
  if (left < 8) left = 8;
  if (left + menuW > window.innerWidth - 8) left = window.innerWidth - menuW - 8;
  let top = rect.bottom + 4;
  if (top + menuH > window.innerHeight - 8) top = rect.top - menuH - 4;
  if (top < 8) top = 8;
  menu.style.top = top + 'px';
  menu.style.left = left + 'px';

  // Fetch doc to get current data for context
  async function getData() {
    const snap = await db.collection(col).doc(docId).get();
    return snap.exists ? snap.data() : null;
  }

  // Set vehicle button label once data loads
  getData().then(d => {
    const vBtn = menu.querySelector('#ctx-vehicle');
    if (!vBtn) return;
    if (d && d.vehicleId) {
      const v = vehiclesCache.find(x => x.id === d.vehicleId);
      vBtn.textContent = '🚗 Go to Vehicle' + (v ? ' (' + v.plate + ')' : '');
    } else {
      vBtn.textContent = '🔗 Link Vehicle';
    }
  }).catch(() => {
    const vBtn = menu.querySelector('#ctx-vehicle');
    if (vBtn) vBtn.textContent = '🔗 Link Vehicle';
  });

  menu.querySelector('#ctx-edit').onclick = async () => {
    menu.remove();
    const d = await getData();
    if (!d) { toast('Task not found.', 'error'); return; }
    openFullEditTaskModal(docId, col, d);
  };
  menu.querySelector('#ctx-date').onclick = async () => {
    menu.remove();
    const d = await getData();
    const currentDue = d ? d.dueDate || '' : '';
    openRescheduleTask(docId, col, currentDue);
  };
  menu.querySelector('#ctx-move-urgent').onclick = () => { menu.remove(); moveTaskStatus(docId, col, 'urgent'); };
  menu.querySelector('#ctx-move-scheduled').onclick = () => { menu.remove(); moveTaskStatus(docId, col, 'scheduled'); };
  menu.querySelector('#ctx-move-monitoring').onclick = () => { menu.remove(); moveTaskStatus(docId, col, 'monitoring'); };
  menu.querySelector('#ctx-move-done').onclick = () => { menu.remove(); agendaMarkDone_dispatch(docId, col); };
  menu.querySelector('#ctx-vehicle').onclick = async () => {
    menu.remove();
    const d = await getData();
    if (d && d.vehicleId) {
      closeTaskPanel();
      openVehiclePage(d.vehicleId);
    } else {
      openLinkVehicleModal(docId, col);
    }
  };
  menu.querySelector('#ctx-delete').onclick = async () => {
    menu.remove();
    const ok = await confirm('Delete Task', 'Permanently remove this task?');
    if (!ok) return;
    try {
      await db.collection(col).doc(docId).delete();
      toast('Task deleted.', 'success');
      loadDashboardFollowUps();
      if (col === 'generalNotes') loadGeneralNotes();
    } catch (err) {
      console.error('Delete task error:', err);
      toast('Failed to delete.', 'error');
    }
  };

  // Close menu on outside click
  setTimeout(() => {
    document.addEventListener('click', function handler(e) {
      if (!menu.contains(e.target)) {
        menu.remove();
        document.removeEventListener('click', handler);
      }
    });
  }, 10);
};

// Link a vehicle to any task (vehicleNotes or generalNotes)
window.openLinkVehicleModal = function(docId, col) {
  const existing = document.querySelector('.link-vehicle-overlay');
  if (existing) existing.remove();

  const sorted = [...vehiclesCache].sort((a, b) => (a.plate || '').localeCompare(b.plate || ''));
  const opts = sorted.map(v =>
    `<option value="${v.id}">${escapeHtml(v.plate)} — ${escapeHtml(v.make || '')} ${escapeHtml(v.model || '')}</option>`
  ).join('');

  const overlay = document.createElement('div');
  overlay.className = 'link-vehicle-overlay';
  overlay.innerHTML = `
    <div class="link-vehicle-modal">
      <h4>🔗 Link Vehicle</h4>
      <p style="font-size:0.85rem;color:#6b7280;margin:0 0 14px;">Choose a vehicle to associate with this task.</p>
      <select id="link-vehicle-select" class="form-select" style="width:100%;">
        <option value="">— Select vehicle —</option>
        ${opts}
      </select>
      <div style="display:flex;gap:8px;margin-top:14px;">
        <button class="btn btn-primary" id="btn-link-vehicle-save">Link Vehicle</button>
        <button class="btn btn-outline" id="btn-link-vehicle-cancel">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
  overlay.querySelector('#btn-link-vehicle-cancel').onclick = () => overlay.remove();
  overlay.querySelector('#btn-link-vehicle-save').onclick = async () => {
    const vehicleId = overlay.querySelector('#link-vehicle-select').value;
    if (!vehicleId) { toast('Please select a vehicle.', 'warning'); return; }
    const v = vehiclesCache.find(x => x.id === vehicleId);
    try {
      await db.collection(col).doc(docId).update({ vehicleId, vehiclePlate: v ? v.plate : '' });
      toast('Vehicle linked! 🚗', 'success');
      overlay.remove();
      loadDashboardFollowUps();
    } catch (err) {
      console.error('Link vehicle error:', err);
      toast('Failed to link vehicle.', 'error');
    }
  };
};

// Full edit modal: allows editing text + followup/urgent/dueDate
window.openFullEditTaskModal = function(docId, col, d) {
  const existing = document.querySelector('.task-full-edit-overlay');
  if (existing) existing.remove();
  const overlay = document.createElement('div');
  overlay.className = 'task-full-edit-overlay';
  overlay.innerHTML = `
    <div class="task-full-edit-modal">
      <h4>✏️ Edit Task</h4>
      <div class="form-group">
        <label>Task Text</label>
        <textarea id="tfe-text" class="note-textarea" rows="3" maxlength="500">${escapeHtml(d.text || '')}</textarea>
      </div>
      <div class="form-group">
        <label class="note-followup-label">
          <input type="checkbox" id="tfe-followup" ${d.isFollowUp ? 'checked' : ''}> ⚑ Follow Up Task
        </label>
      </div>
      <div id="tfe-followup-opts" style="${d.isFollowUp ? '' : 'display:none;'}">
        <div class="form-group">
          <label class="note-followup-label">
            <input type="checkbox" id="tfe-urgent" ${d.urgent ? 'checked' : ''}> 🚨 Urgent
          </label>
        </div>
        <div class="form-group">
          <label>Due Date</label>
          <input type="date" id="tfe-due-date" class="form-select" value="${d.dueDate || ''}">
        </div>
        <div class="form-group">
          <label>Due Time <span style="color:#9ca3af;font-size:0.8rem;">(optional)</span></label>
          <input type="time" id="tfe-due-time" class="form-select" value="${d.dueTime || ''}">
        </div>
        <div class="form-group">
          <label>Assign To <span style="color:#9ca3af;font-size:0.8rem;">(optional)</span></label>
          <select id="tfe-assignee" class="form-select">
            <option value="">— Team (unassigned) —</option>
          </select>
        </div>
      </div>
      <div class="task-log-section">
        <div class="note-edit-section-label" style="margin-bottom:6px;">📋 Activity Log</div>
        <div id="tfe-log-entries" class="task-log-entries">${renderTaskLogEntries(d.taskLog || [])}</div>
        <div class="task-log-input-row">
          <textarea id="tfe-log-input" class="task-log-textarea" placeholder="Add a note or update…" rows="2"></textarea>
          <button class="btn btn-sm btn-outline" id="btn-tfe-log-add">Add</button>
        </div>
      </div>
      <div class="reassign-modal-actions">
        <button class="btn btn-primary" id="btn-tfe-save">Save Changes</button>
        <button class="btn btn-outline" id="btn-tfe-cancel">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelector('#tfe-followup').addEventListener('change', function() {
    overlay.querySelector('#tfe-followup-opts').style.display = this.checked ? '' : 'none';
  });
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
  overlay.querySelector('#btn-tfe-cancel').onclick = () => overlay.remove();

  // Populate assignee dropdown
  (async () => {
    const sel = overlay.querySelector('#tfe-assignee');
    try {
      const snap = await db.collection('users').orderBy('displayName').get();
      snap.forEach(doc => {
        const ud = doc.data();
        const opt = document.createElement('option');
        opt.value = doc.id;
        opt.dataset.name = ud.displayName || ud.email;
        opt.textContent = ud.displayName || ud.email;
        if (doc.id === (d.assignedTo || '')) opt.selected = true;
        sel.appendChild(opt);
      });
    } catch (e) { /* non-critical */ }
  })();

  // Log entry
  overlay.querySelector('#btn-tfe-log-add').onclick = async () => {
    const logText = overlay.querySelector('#tfe-log-input').value.trim();
    if (!logText) return;
    const entry = {
      text: logText,
      by: currentUser.displayName || currentUser.email,
      at: new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: APP_TIMEZONE })
    };
    try {
      await db.collection(col).doc(docId).update({
        taskLog: firebase.firestore.FieldValue.arrayUnion(entry)
      });
      overlay.querySelector('#tfe-log-input').value = '';
      const snap = await db.collection(col).doc(docId).get();
      const updated = snap.data();
      overlay.querySelector('#tfe-log-entries').innerHTML = renderTaskLogEntries(updated.taskLog || []);
      toast('Log entry added.', 'success');
    } catch (err) {
      console.error('Log add error:', err);
      toast('Failed to add log entry.', 'error');
    }
  };
  overlay.querySelector('#tfe-log-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); overlay.querySelector('#btn-tfe-log-add').click(); }
  });

  overlay.querySelector('#btn-tfe-save').onclick = async () => {
    const newText = overlay.querySelector('#tfe-text').value.trim();
    if (!newText) { toast('Task text cannot be empty.', 'warning'); return; }
    const isFollowUp = overlay.querySelector('#tfe-followup').checked || overlay.querySelector('#tfe-urgent').checked;
    const urgent = overlay.querySelector('#tfe-urgent').checked;
    const dueDate = isFollowUp ? overlay.querySelector('#tfe-due-date').value : '';
    const dueTime = isFollowUp ? overlay.querySelector('#tfe-due-time').value : '';
    const assignSel = overlay.querySelector('#tfe-assignee');
    const assignedTo = (isFollowUp && assignSel && assignSel.value) ? assignSel.value : null;
    const assignedToName = assignedTo ? (assignSel.options[assignSel.selectedIndex] ? assignSel.options[assignSel.selectedIndex].dataset.name || assignSel.options[assignSel.selectedIndex].textContent.trim() : null) : null;
    const updates = { text: newText, isFollowUp, urgent, taskStatus: urgent ? 'urgent' : 'scheduled' };
    if (dueDate) updates.dueDate = dueDate;
    else updates.dueDate = firebase.firestore.FieldValue.delete();
    if (dueTime) updates.dueTime = dueTime;
    else updates.dueTime = firebase.firestore.FieldValue.delete();
    if (assignedTo) { updates.assignedTo = assignedTo; updates.assignedToName = assignedToName; }
    else { updates.assignedTo = firebase.firestore.FieldValue.delete(); updates.assignedToName = firebase.firestore.FieldValue.delete(); }
    try {
      await db.collection(col).doc(docId).update(updates);
      toast('Task updated!', 'success');
      overlay.remove();
      loadDashboardFollowUps();
      if (col === 'vehicleNotes' && selectedVehicle) loadVehicleNotes(selectedVehicle.id);
      if (col === 'generalNotes') loadGeneralNotes();
    } catch (err) {
      console.error('Edit task error:', err);
      toast('Failed to save changes.', 'error');
    }
  };
};

// ---- Reschedule task (swipe / hold) — works for all roles ----
window.openRescheduleTask = function(docId, col, currentDue) {
  if (!docId || !col) return;
  const existing = document.querySelector('.reassign-modal-overlay');
  if (existing) existing.remove();
  const overlay = document.createElement('div');
  overlay.className = 'reassign-modal-overlay';
  overlay.innerHTML = `
    <div class="reassign-modal">
      <h4>📅 Reschedule Task</h4>
      ${currentDue ? `<p>Current due date: <strong>${currentDue}</strong></p>` : '<p>Set a due date for this task</p>'}
      <div class="form-group">
        <label>New Due Date</label>
        <input type="date" id="reschedule-new-date" class="form-select" value="${todayDateString()}">
      </div>
      <div class="reassign-modal-actions">
        <button class="btn btn-primary" id="btn-reschedule-confirm">Save</button>
        <button class="btn btn-outline" id="btn-reschedule-cancel">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('#btn-reschedule-cancel').onclick = () => overlay.remove();
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
  overlay.querySelector('#btn-reschedule-confirm').onclick = async () => {
    const newDate = overlay.querySelector('#reschedule-new-date').value;
    if (!newDate) { toast('Pick a date.', 'warning'); return; }
    try {
      await db.collection(col).doc(docId).update({ dueDate: newDate });
      toast('Task rescheduled to ' + newDate, 'success');
      overlay.remove();
      loadDashboardFollowUps();
    } catch (err) {
      console.error('Reschedule error:', err);
      toast('Failed to reschedule.', 'error');
    }
  };
};

// ---- Gesture setup: swipe-left or long-press on followup items to reschedule ----
(function setupFollowupGestures() {
  const overlay = $('task-panel-overlay');
  if (!overlay) return;
  let startX = 0, startY = 0, activeWrap = null, pressTimer = null, swiping = false;

  function getWrap(t) {
    let el = t;
    while (el && el !== overlay) {
      if (el.classList && el.classList.contains('followup-item-wrap')) return el;
      el = el.parentElement;
    }
    return null;
  }

  overlay.addEventListener('touchstart', e => {
    const wrap = getWrap(e.target);
    if (!wrap) return;
    activeWrap = wrap;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    swiping = false;
    pressTimer = setTimeout(() => {
      pressTimer = null;
      const w = activeWrap;
      activeWrap = null;
      if (w) openRescheduleTask(w.dataset.id, w.dataset.col, w.dataset.due);
    }, 600);
  }, { passive: true });

  overlay.addEventListener('touchmove', e => {
    if (!activeWrap) return;
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;
    if (!swiping && Math.abs(dx) > 8) { clearTimeout(pressTimer); pressTimer = null; swiping = true; }
    if (swiping && dx < 0 && Math.abs(dx) > Math.abs(dy)) {
      const item = activeWrap.querySelector('.followup-item');
      if (item) item.style.transform = `translateX(${Math.max(dx, -90)}px)`;
    }
  }, { passive: true });

  overlay.addEventListener('touchend', e => {
    clearTimeout(pressTimer); pressTimer = null;
    if (!activeWrap) return;
    const wrap = activeWrap; activeWrap = null;
    const dx = startX - e.changedTouches[0].clientX;
    const item = wrap.querySelector('.followup-item');
    if (item) {
      item.style.transition = 'transform 0.2s ease';
      item.style.transform = '';
      setTimeout(() => { item.style.transition = ''; }, 220);
    }
    if (swiping && dx > 60) openRescheduleTask(wrap.dataset.id, wrap.dataset.col, wrap.dataset.due);
    swiping = false;
  }, { passive: true });

  // Desktop: long-press via mousedown
  overlay.addEventListener('mousedown', e => {
    const wrap = getWrap(e.target);
    if (!wrap) return;
    pressTimer = setTimeout(() => {
      pressTimer = null;
      openRescheduleTask(wrap.dataset.id, wrap.dataset.col, wrap.dataset.due);
    }, 700);
  });
  overlay.addEventListener('mouseup', () => { clearTimeout(pressTimer); pressTimer = null; });
  overlay.addEventListener('mousemove', () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } });
})();

// Photo preview for new task form
(function() {
  const photoInput = $('new-task-photo');
  if (photoInput) {
    photoInput.addEventListener('change', () => {
      const file = photoInput.files[0];
      const wrap = $('new-task-photo-wrap');
      const prev = $('new-task-photo-preview');
      if (file && wrap && prev) {
        const reader = new FileReader();
        reader.onload = e => { prev.src = e.target.result; wrap.style.display = ''; };
        reader.readAsDataURL(file);
      } else if (wrap) {
        wrap.style.display = 'none';
      }
    });
  }
})();

$('btn-save-task') && $('btn-save-task').addEventListener('click', async () => {
  const title = ($('new-task-title').value || '').trim();
  if (!title) { $('new-task-title').focus(); toast('Please enter a task title.', 'warning'); return; }
  const desc     = ($('new-task-desc').value || '').trim();
  const priority = $('new-task-priority').value || 'normal';
  const dueDate  = $('new-task-due').value || '';
  const isUrgent = priority === 'critical';
  const assignSel = $('new-task-assignee');
  const assignedTo = (assignSel && assignSel.value) ? assignSel.value : null;
  const assignedToName = assignedTo
    ? (assignSel.options[assignSel.selectedIndex] ? assignSel.options[assignSel.selectedIndex].dataset.name || assignSel.options[assignSel.selectedIndex].textContent.trim() : null)
    : null;

  const btn = $('btn-save-task');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  let photoUrl = null;
  const photoInput = $('new-task-photo');
  if (photoInput && photoInput.files[0]) {
    try {
      const file = photoInput.files[0];
      const tempId = 'task_' + Date.now();
      const ext = file.name.split('.').pop() || 'jpg';
      const ref = storage.ref(`taskPhotos/${tempId}.${ext}`);
      await ref.put(file);
      photoUrl = await ref.getDownloadURL();
    } catch(e) { console.error(e); toast('Photo upload failed — saving without photo.', 'warning'); }
  }

  try {
    const taskData = {
      text: title,
      description: desc,
      priority,
      isFollowUp: true,
      done: false,
      urgent: isUrgent,
      taskStatus: isUrgent ? 'urgent' : 'scheduled',
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      createdBy: currentUser.uid,
      createdByName: currentUser.displayName || currentUser.email,
    };
    if (dueDate) taskData.dueDate = dueDate;
    if (assignedTo) { taskData.assignedTo = assignedTo; taskData.assignedToName = assignedToName; }
    if (photoUrl) taskData.photoUrl = photoUrl;
    await db.collection('generalNotes').add(taskData);
    // Reset form
    $('new-task-title').value = '';
    $('new-task-desc').value = '';
    $('new-task-priority').value = 'normal';
    $('new-task-due').value = '';
    if (assignSel) assignSel.value = '';
    if (photoInput) photoInput.value = '';
    const wrap = $('new-task-photo-wrap');
    if (wrap) wrap.style.display = 'none';
    toast('Task saved! ✅', 'success');
    loadGeneralNotes();
    loadDashboardFollowUps();
  } catch(err) {
    console.error(err);
    toast('Failed to save task.', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '💾 Save Task'; }
  }
});

async function loadGeneralNotes() {
  const container = $('general-notes-list');
  if (!container) return;

  try {
    const snap = await db.collection('generalNotes')
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get();

    if (snap.empty) {
      container.innerHTML = '<p class="hint" style="margin:0; padding:8px 0;">No general notes yet.</p>';
      return;
    }

    const canManage = (currentUserRole === 'admin' || currentUserRole === 'manager');
    const canDelete = (currentUserRole === 'admin');
    let html = '';
    snap.forEach(doc => {
      const d = doc.data();
      const dateStr = d.createdAt ? new Date(d.createdAt.toDate()).toLocaleDateString('en-US', { timeZone: APP_TIMEZONE }) : '';
      let followUpBadge = '';
      if (d.isFollowUp) {
        if (d.done) {
          const completer = d.completedByName ? ` by ${escapeHtml(d.completedByName)}` : '';
          const completedDate = d.completedAt ? ' · ' + new Date(d.completedAt.toDate()).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: APP_TIMEZONE }) : '';
          followUpBadge = `<span class="note-badge note-badge-done">✅ Done${completer}${completedDate}</span>`;
        } else {
          const dueLabel = d.dueDate ? ` · Due ${d.dueDate}` : '';
          followUpBadge = `<span class="note-badge note-badge-followup">⚑ Follow Up${dueLabel}</span>`;
        }
      }
      const urgentBadge = d.urgent && !d.done ? '<span class="note-badge note-badge-urgent">🚨 Urgent</span>' : '';
      const doneClass = d.done ? ' note-done' : '';
      html += `
        <div class="note-item${doneClass}">
          <div class="note-content">
            ${urgentBadge}${followUpBadge}
            <div class="note-text">${escapeHtml(d.text)}</div>
            ${d.invoiceUrls && d.invoiceUrls.length > 0 ? `<div class="note-invoice-row">${d.invoiceUrls.map(url => `<img src="${escapeHtml(url)}" class="note-invoice-thumb" onclick="window.open('${escapeHtml(url)}','_blank')" title="View invoice/photo">`).join('')}</div>` : ''}
            <div class="note-meta">👤 ${escapeHtml(d.createdByName || 'Unknown')} · ${dateStr}</div>
          </div>
          <div class="note-actions">
            ${d.isFollowUp && !d.done && canManage ? `<button class="btn btn-sm btn-outline" onclick="markGeneralNoteDone('${doc.id}')">✓ Done</button>` : ''}
            ${d.done && canManage ? `<button class="btn btn-sm btn-undo" onclick="markGeneralNoteUndone('${doc.id}')">↩ Undo</button>` : ''}
            ${canManage ? `<button class="btn btn-sm btn-outline" onclick="openNoteEditModal('${doc.id}', 'generalNotes')">✏️ Edit</button>` : ''}
            ${canDelete ? `<button class="btn btn-sm btn-danger" onclick="deleteGeneralNote('${doc.id}')">Delete</button>` : ''}
          </div>
        </div>`;
    });
    container.innerHTML = html;
  } catch (err) {
    console.error('Load general notes error:', err);
    container.innerHTML = '<p class="hint">Failed to load notes.</p>';
  }
}

window.markGeneralNoteDone = async function(docId) {
  try {
    await db.collection('generalNotes').doc(docId).update({
      done: true,
      completedBy: currentUser.uid,
      completedByName: currentUser.displayName || currentUser.email,
      completedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    toast('Follow-up marked done.', 'success');
    loadGeneralNotes();
    loadDashboardFollowUps();
  } catch (err) {
    console.error('Mark general note done error:', err);
    toast('Failed to update.', 'error');
  }
};

window.deleteGeneralNote = async function(docId) {
  const ok = await confirm('Delete Note', 'Remove this note?');
  if (!ok) return;
  try {
    await db.collection('generalNotes').doc(docId).delete();
    toast('Note deleted.', 'success');
    loadGeneralNotes();
    loadDashboardFollowUps();
  } catch (err) {
    console.error('Delete general note error:', err);
    toast('Failed to delete note.', 'error');
  }
};

// ================================================================
// INIT - Set today's date as default in admin date filter
// ================================================================
$('admin-date-filter').value = todayDateString();

// ================================================================
// MAILBOX SYSTEM
// ================================================================

let currentMailTab = 'inbox';

window.openMailbox = function() {
  const overlay = $('mailbox-overlay');
  if (!overlay) return;
  overlay.style.display = 'flex';
  switchMailTab('inbox');
  loadMailboxInbox();
  loadMailboxSent();
  loadMailboxUsers();
  // Wire up attach photo preview (idempotent)
  const attachInput = $('mb-attach-input');
  if (attachInput && !attachInput._wired) {
    attachInput._wired = true;
    attachInput.addEventListener('change', () => {
      const files = Array.from(attachInput.files);
      const previews = $('mb-attach-previews');
      const countEl = $('mb-attach-count');
      if (previews) {
        previews.innerHTML = files.map((f, i) =>
          `<div class="mb-attach-thumb-wrap" id="mb-thumb-${i}">
            <img src="${URL.createObjectURL(f)}" class="mb-attach-thumb" alt="photo">
            <button class="mb-attach-remove" onclick="removeMbAttach(${i})">✕</button>
          </div>`
        ).join('');
      }
      if (countEl) countEl.textContent = files.length ? files.length + ' photo' + (files.length > 1 ? 's' : '') + ' attached' : '';
    });
  }
};

window.closeMailbox = function() {
  const overlay = $('mailbox-overlay');
  if (overlay) overlay.style.display = 'none';
};

window.switchMailTab = function(tab) {
  currentMailTab = tab;
  document.querySelectorAll('.mailbox-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.mb-tab-content').forEach(c => c.style.display = 'none');
  const tabBtn = $('mb-tab-' + tab);
  const tabContent = $('mb-' + tab);
  if (tabBtn) tabBtn.classList.add('active');
  if (tabContent) tabContent.style.display = '';
  // Load time clock data when switching to that tab
  if (tab === 'timeclock') initTimeClock();
};

async function loadMailboxUsers() {
  if (!currentUser) return;
  const sel = $('mb-to-user');
  if (!sel) return;
  try {
    const snap = await db.collection('users').orderBy('displayName').get();
    sel.innerHTML = '<option value="">— Select recipient —</option>';
    snap.forEach(doc => {
      if (doc.id === currentUser.uid) return;
      const d = doc.data();
      const opt = document.createElement('option');
      opt.value = doc.id;
      opt.dataset.name = d.displayName || d.email;
      opt.textContent = d.displayName || d.email;
      sel.appendChild(opt);
    });
  } catch (e) {
    console.error('Load mailbox users:', e);
  }
}

async function loadMailboxInbox() {
  if (!currentUser) return;
  const list = $('mb-inbox-list');
  if (!list) return;
  list.innerHTML = '<p class="hint">Loading...</p>';
  try {
    const snap = await db.collection('messages')
      .where('to', '==', currentUser.uid)
      .limit(80)
      .get();
    renderMailboxInbox(snap);
  } catch (e) {
    console.error('Inbox load error:', e);
    list.innerHTML = '<p class="hint">Could not load inbox.</p>';
  }
}

function renderMailboxInbox(snap) {
  const list = $('mb-inbox-list');
  if (!list) return;
  if (snap.empty) {
    list.innerHTML = '<p class="hint" style="text-align:center;padding:24px 0;">No messages yet. \ud83d\udcad</p>';
    return;
  }
  const msgs = [];
  snap.forEach(doc => msgs.push({ id: doc.id, ...doc.data() }));
  msgs.sort((a, b) => {
    const ta = a.sentAt ? (a.sentAt.toMillis ? a.sentAt.toMillis() : 0) : 0;
    const tb = b.sentAt ? (b.sentAt.toMillis ? b.sentAt.toMillis() : 0) : 0;
    return tb - ta;
  });
  list.innerHTML = msgs.map(m => {
    const unread = !m.read;
    const ts = m.sentAt ? (m.sentAt.toMillis ? m.sentAt.toMillis() : null) : null;
    const timeStr = ts ? new Date(ts).toLocaleString('en-US', { timeZone: APP_TIMEZONE, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    const preview = m.body ? m.body.substring(0, 90) + (m.body.length > 90 ? '…' : '') : '';
    return `
      <div class="mb-message-item ${unread ? 'mb-unread' : ''}" id="mb-msg-${m.id}">
        <div class="mb-msg-header" onclick="openMessage('${m.id}')">
          <span class="mb-msg-from">${unread ? '<span class="mb-dot"></span>' : ''}${escapeHtml(m.fromName || 'Unknown')}</span>
          <span class="mb-msg-time">${timeStr}</span>
        </div>
        <div class="mb-msg-preview" onclick="openMessage('${m.id}')">${escapeHtml(preview)}</div>
        <div class="mb-msg-actions">
          <button class="btn btn-sm btn-outline" onclick="replyToMessage('${m.from}', '${escapeHtml((m.fromName||'').replace(/'/g,''))}')">↩ Reply</button>
          <button class="btn btn-sm btn-danger" onclick="deleteMessage('${m.id}')">🗑️</button>
        </div>
      </div>`;
  }).join('');
}

async function loadMailboxSent() {
  if (!currentUser) return;
  const list = $('mb-sent-list');
  if (!list) return;
  list.innerHTML = '<p class="hint">Loading...</p>';
  try {
    const snap = await db.collection('messages')
      .where('from', '==', currentUser.uid)
      .limit(80)
      .get();
    const msgs = [];
    snap.forEach(doc => msgs.push({ id: doc.id, ...doc.data() }));
    msgs.sort((a, b) => {
      const ta = a.sentAt ? (a.sentAt.toMillis ? a.sentAt.toMillis() : 0) : 0;
      const tb = b.sentAt ? (b.sentAt.toMillis ? b.sentAt.toMillis() : 0) : 0;
      return tb - ta;
    });
    if (!msgs.length) {
      list.innerHTML = '<p class="hint" style="text-align:center;padding:24px 0;">No sent messages. \ud83d\udce4</p>';
      return;
    }
    list.innerHTML = msgs.map(m => {
      const ts = m.sentAt ? (m.sentAt.toMillis ? m.sentAt.toMillis() : null) : null;
      const timeStr = ts ? new Date(ts).toLocaleString('en-US', { timeZone: APP_TIMEZONE, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
      const preview = m.body ? m.body.substring(0, 100) + (m.body.length > 100 ? '…' : '') : '';
      return `
        <div class="mb-message-item mb-sent-item">
          <div class="mb-msg-header">
            <span class="mb-msg-from">To: ${escapeHtml(m.toName || 'Unknown')}</span>
            <span class="mb-msg-time">${timeStr}</span>
          </div>
          <div class="mb-msg-preview">${escapeHtml(preview)}</div>
        </div>`;
    }).join('');
  } catch (e) {
    if ($('mb-sent-list')) $('mb-sent-list').innerHTML = '<p class="hint">Could not load sent messages.</p>';
  }
}

window.removeMbAttach = function(idx) {
  // Re-build the file list minus the removed index using a DataTransfer
  const attachInput = $('mb-attach-input');
  if (!attachInput) return;
  const dt = new DataTransfer();
  Array.from(attachInput.files).forEach((f, i) => { if (i !== idx) dt.items.add(f); });
  attachInput.files = dt.files;
  // Trigger change event to re-render previews
  attachInput.dispatchEvent(new Event('change'));
};

window.openMessage = async function(msgId) {
  // Mark as read
  try {
    await db.collection('messages').doc(msgId).update({ read: true });
    const el = $('mb-msg-' + msgId);
    if (el) el.classList.remove('mb-unread');
    updateMailBadge();
  } catch (e) { /* ignore */ }

  // Fetch and display message in a modal
  try {
    const doc = await db.collection('messages').doc(msgId).get();
    if (!doc.exists) return;
    const m = doc.data();
    const ts = m.sentAt ? (m.sentAt.toMillis ? m.sentAt.toMillis() : null) : null;
    const timeStr = ts ? new Date(ts).toLocaleString('en-US', { timeZone: APP_TIMEZONE, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

    const existing = document.querySelector('.msg-detail-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.className = 'msg-detail-overlay';
    const photosHtml = (m.photoUrls && m.photoUrls.length)
      ? `<div class="msg-detail-photos">${m.photoUrls.map(url => `<a href="${url}" target="_blank"><img src="${url}" class="msg-detail-photo-thumb" alt="attachment"></a>`).join('')}</div>`
      : '';
    overlay.innerHTML = `
      <div class="msg-detail-modal">
        <div class="msg-detail-header">
          <div class="msg-detail-from"><strong>From:</strong> ${escapeHtml(m.fromName || 'Unknown')}</div>
          <div class="msg-detail-time">${timeStr}</div>
        </div>
        <div class="msg-detail-body">${escapeHtml(m.body || '').replace(/\n/g, '<br>')}</div>
        ${photosHtml}
        <div class="msg-detail-actions">
          <button class="btn btn-sm btn-outline" id="btn-msg-reply">↩ Reply</button>
          <button class="btn btn-sm btn-outline" id="btn-msg-create-task">📋 Create Task</button>
          <button class="btn btn-sm btn-danger" id="btn-msg-delete">🗑️ Delete</button>
          <button class="btn btn-sm btn-outline" id="btn-msg-close">Close</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
    overlay.querySelector('#btn-msg-close').onclick = () => overlay.remove();

    overlay.querySelector('#btn-msg-reply').onclick = () => {
      overlay.remove();
      replyToMessage(m.from, m.fromName || '');
    };

    overlay.querySelector('#btn-msg-delete').onclick = async () => {
      const ok = await confirm('Delete Message', 'Permanently delete this message?');
      if (!ok) return;
      try {
        await db.collection('messages').doc(msgId).delete();
        toast('Message deleted.', 'success');
        overlay.remove();
        loadMailboxInbox();
        updateMailBadge();
      } catch (e) { toast('Failed to delete.', 'error'); }
    };

    overlay.querySelector('#btn-msg-create-task').onclick = () => {
      overlay.remove();
      openCreateTaskFromMessage(m.fromName || '', m.body || '');
    };
  } catch (e) {
    console.error('openMessage display error:', e);
  }
};

window.replyToMessage = function(fromUid, fromName) {
  switchMailTab('compose');
  const sel = $('mb-to-user');
  if (sel) {
    const opt = sel.querySelector(`option[value="${fromUid}"]`);
    if (opt) sel.value = fromUid;
  }
  const body = $('mb-message-body');
  if (body) body.focus();
};

// Create a general follow-up task pre-filled from a message
window.openCreateTaskFromMessage = async function(fromName, msgBody) {
  const existing = document.querySelector('.msg-task-overlay');
  if (existing) existing.remove();
  const overlay = document.createElement('div');
  overlay.className = 'msg-task-overlay';
  const prefill = (fromName ? `[From: ${fromName}] ` : '') + msgBody.substring(0, 300);
  overlay.innerHTML = `
    <div class="msg-task-modal">
      <h4>📋 Create Task from Message</h4>
      <div class="form-group">
        <label>Task Description</label>
        <textarea id="mct-text" class="note-textarea" rows="3" maxlength="500">${escapeHtml(prefill)}</textarea>
      </div>
      <div class="form-group">
        <label>Due Date <span style="color:#9ca3af;font-size:0.8rem;">(optional)</span></label>
        <input type="date" id="mct-due" class="form-select">
      </div>
      <div class="form-group">
        <label class="note-followup-label"><input type="checkbox" id="mct-urgent"> 🚨 Urgent</label>
      </div>
      <div class="form-group">
        <label>Assign To <span style="color:#9ca3af;font-size:0.8rem;">(optional)</span></label>
        <select id="mct-assignee" class="form-select">
          <option value="">— Team (unassigned) —</option>
        </select>
      </div>
      <div class="reassign-modal-actions">
        <button class="btn btn-primary" id="btn-mct-save">Create Task</button>
        <button class="btn btn-outline" id="btn-mct-cancel">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
  overlay.querySelector('#btn-mct-cancel').onclick = () => overlay.remove();

  // Populate users
  try {
    const snap = await db.collection('users').orderBy('displayName').get();
    const sel = overlay.querySelector('#mct-assignee');
    snap.forEach(doc => {
      if (doc.id === currentUser.uid) return;
      const d = doc.data();
      const opt = document.createElement('option');
      opt.value = doc.id;
      opt.dataset.name = d.displayName || d.email;
      opt.textContent = d.displayName || d.email;
      sel.appendChild(opt);
    });
  } catch (e) { /* non-critical */ }

  overlay.querySelector('#btn-mct-save').onclick = async () => {
    const text = overlay.querySelector('#mct-text').value.trim();
    if (!text) { toast('Enter a task description.', 'warning'); return; }
    const urgent = overlay.querySelector('#mct-urgent').checked;
    const dueDate = overlay.querySelector('#mct-due').value;
    const assignSel = overlay.querySelector('#mct-assignee');
    const assignedTo = assignSel.value || null;
    const assignedToName = assignedTo ? (assignSel.options[assignSel.selectedIndex].dataset.name || assignSel.options[assignSel.selectedIndex].textContent.trim()) : null;
    const data = {
      text,
      isFollowUp: true,
      done: false,
      urgent,
      taskStatus: urgent ? 'urgent' : 'scheduled',
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      createdBy: currentUser.uid,
      createdByName: currentUser.displayName || currentUser.email
    };
    if (dueDate) data.dueDate = dueDate;
    if (assignedTo) { data.assignedTo = assignedTo; data.assignedToName = assignedToName; }
    try {
      await db.collection('generalNotes').add(data);
      toast('Task created from message! 📋', 'success');
      overlay.remove();
    } catch (e) {
      console.error('Create task from message error:', e);
      toast('Failed to create task.', 'error');
    }
  };
};

window.deleteMessage = async function(msgId) {
  const ok = await confirm('Delete Message', 'Permanently delete this message?');
  if (!ok) return;
  try {
    await db.collection('messages').doc(msgId).delete();
    toast('Message deleted.', 'success');
    loadMailboxInbox();
    updateMailBadge();
  } catch (e) {
    toast('Failed to delete.', 'error');
  }
};

window.sendMailMessage = async function() {
  const sel = $('mb-to-user');
  const body = $('mb-message-body');
  if (!sel || !body) return;
  const toUid = sel.value;
  const toName = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].textContent.trim() : '';
  const msgBody = body.value.trim();
  if (!toUid) { toast('Select a recipient.', 'warning'); return; }
  if (!msgBody) { toast('Write a message first.', 'warning'); return; }
  const fromName = ($('user-display') || {}).textContent || currentUser.email;

  // Upload any staged photos
  const photoUrls = [];
  const attachInput = $('mb-attach-input');
  const files = attachInput && attachInput.files ? Array.from(attachInput.files) : [];
  if (files.length) {
    const st = getStorage();
    for (const file of files) {
      try {
        const compressed = await compressImage(file);
        const ref = st.ref('messages/' + currentUser.uid + '/' + Date.now() + '_' + Math.random().toString(36).slice(2,6) + '.jpg');
        await ref.put(compressed, { contentType: 'image/jpeg' });
        photoUrls.push(await ref.getDownloadURL());
      } catch(e) { console.warn('Mail photo upload error:', e); }
    }
  }

  try {
    const msgData = {
      from: currentUser.uid,
      fromName,
      to: toUid,
      toName,
      body: msgBody,
      sentAt: firebase.firestore.FieldValue.serverTimestamp(),
      read: false
    };
    if (photoUrls.length) msgData.photoUrls = photoUrls;
    await db.collection('messages').add(msgData);
    body.value = '';
    sel.value = '';
    if (attachInput) attachInput.value = '';
    const previews = $('mb-attach-previews');
    if (previews) previews.innerHTML = '';
    const countEl = $('mb-attach-count');
    if (countEl) countEl.textContent = '';
    toast('Message sent! ✉️', 'success');
    loadMailboxSent();
    switchMailTab('sent');
  } catch (e) {
    console.error('Send message error:', e);
    toast('Failed to send.', 'error');
  }
};

async function updateMailBadge() {
  if (!currentUser) return;
  try {
    const snap = await db.collection('messages')
      .where('to', '==', currentUser.uid)
      .where('read', '==', false)
      .get();
    const count = snap.size;
    [$('mail-unread-count'), $('mail-unread-count-vehicle')].forEach(badge => {
      if (!badge) return;
      badge.textContent = count;
      badge.classList.toggle('count-zero', count === 0);
    });
    const inboxCount = $('mb-inbox-count');
    if (inboxCount) inboxCount.textContent = count || '';
  } catch (e) { /* ignore */ }
}

function startMailListener() {
  if (!currentUser) return;
  if (mailUnsubscribe) { mailUnsubscribe(); mailUnsubscribe = null; }
  try {
    mailUnsubscribe = db.collection('messages')
      .where('to', '==', currentUser.uid)
      .where('read', '==', false)
      .onSnapshot(snap => {
        const count = snap.size;
        [$('mail-unread-count'), $('mail-unread-count-vehicle')].forEach(badge => {
          if (!badge) return;
          badge.textContent = count;
          badge.classList.toggle('count-zero', count === 0);
        });
        const inboxCount = $('mb-inbox-count');
        if (inboxCount) inboxCount.textContent = count || '';
        updateMailboxIcon(count);
      }, () => {
        // Fallback polling on listener error
        updateMailBadge();
      });
  } catch (e) {
    updateMailBadge();
  }
}

function updateMailboxIcon(count) {
  const btn = $('btn-mailbox');
  if (!btn) return;
  const iconEl = btn.querySelector('.task-alert-icon');
  if (!iconEl) return;
  if (count > 0) {
    if (!btn._mailAnimRunning) {
      btn._mailAnimRunning = true;
      let open = true;
      iconEl.textContent = '📬';
      iconEl.classList.add('mail-bounce');
      btn._mailAnimIv = setInterval(() => {
        const currentCount = parseInt(($('mail-unread-count') || {}).textContent) || 0;
        if (currentCount === 0) {
          clearInterval(btn._mailAnimIv);
          btn._mailAnimRunning = false;
          iconEl.textContent = '📪';
          iconEl.classList.remove('mail-bounce');
          return;
        }
        open = !open;
        iconEl.textContent = open ? '📬' : '📪';
        iconEl.classList.toggle('mail-bounce', open);
      }, 1200);
    }
  } else {
    if (btn._mailAnimIv) clearInterval(btn._mailAnimIv);
    btn._mailAnimRunning = false;
    iconEl.textContent = '📪';
    iconEl.classList.remove('mail-bounce');
  }
}

// ================================================================
// INCIDENT REPORTS
// ================================================================

const INCIDENT_TYPES = {
  damage:      { label: '🛠️ Vehicle Damage',      color: '#f59e0b' },
  accident:    { label: '💥 Accident / Collision', color: '#ef4444' },
  maintenance: { label: '🔧 Maintenance Issue',    color: '#0ea5e9' },
  key_lost:    { label: '🔑 Key Lost',             color: '#8b5cf6' },
  theft:       { label: '🚔 Theft / Break-in',     color: '#dc2626' },
  smoking:     { label: '🚬 Smoking Violation',    color: '#dc2626' },
  cleaning:    { label: '🧹 Cleaning Violation',   color: '#f97316' },
  citation:    { label: '🎫 Citation / Ticket',    color: '#7c3aed' },
  complaint:   { label: '📢 Customer Complaint',   color: '#0ea5e9' },
  other:       { label: '📝 Other',                color: '#6b7280' },
};

const INCIDENT_STATUS = {
  open:        { label: '🔴 Open',        cls: 'inc-status-open' },
  in_progress: { label: '🔄 In Progress', cls: 'inc-status-inprogress' },
  resolved:    { label: '✅ Resolved',    cls: 'inc-status-resolved' },
};

// ---- Real-time badge listener (open incidents for admin/manager) ----
function startIncidentListener() {
  if (!currentUser) return;
  if (incidentUnsubscribe) { incidentUnsubscribe(); incidentUnsubscribe = null; }
  const isPriv = currentUserRole === 'admin' || currentUserRole === 'manager';
  const tabBtn = $('incidents-tab-btn');
  if (!isPriv) { if (tabBtn) tabBtn.style.display = 'none'; return; }
  if (tabBtn) tabBtn.style.display = '';
  try {
    incidentUnsubscribe = db.collection('incidents')
      .where('status', 'in', ['open', 'in_progress'])
      .onSnapshot(() => loadAllOpenIncidentsDashboard(), () => loadAllOpenIncidentsDashboard());
  } catch(e) { loadAllOpenIncidentsDashboard(); }
}

// Turo-eligible incident types (24-hour claim window)
const TURO_ELIGIBLE_INCIDENT_TYPES = ['damage', 'accident', 'cleaning', 'smoking'];

let _cachedIncidentDocs = [];
let _currentIncidentFilter = 'all';

window.setIncidentFilter = function(filter) {
  _currentIncidentFilter = filter;
  document.querySelectorAll('.inc-filter-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.filter === filter);
  });
  _renderFilteredIncidentList(_cachedIncidentDocs);
};

function _renderFilteredIncidentList(docs) {
  let filtered = docs;
  if (_currentIncidentFilter === 'open') {
    filtered = docs.filter(d => d.data().status !== 'resolved');
  } else if (_currentIncidentFilter === 'turo') {
    filtered = docs.filter(d => TURO_ELIGIBLE_INCIDENT_TYPES.includes(d.data().type));
  }
  // Reuse existing render logic inline
  const list = $('incidents-dashboard-list');
  if (!list) return;
  if (!filtered.length) {
    list.innerHTML = '<p class="hint" style="padding:16px 0;">No incidents in this view.</p>';
    return;
  }
  const isPriv = currentUserRole === 'admin' || currentUserRole === 'manager';
  const nowMs = Date.now();
  list.innerHTML = filtered.map(doc => {
    const d = doc.data();
    const typeInfo   = INCIDENT_TYPES[d.type]   || INCIDENT_TYPES.other;
    const statusInfo = INCIDENT_STATUS[d.status] || INCIDENT_STATUS.open;
    const dateStr    = d.createdAt ? new Date(d.createdAt.toMillis ? d.createdAt.toMillis() : d.createdAt).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }) : '';
    const photosHTML = (d.photoUrls && d.photoUrls.length)
      ? `<div class="inc-photos">${d.photoUrls.map(url => `<a href="${url}" target="_blank"><img src="${url}" class="inc-thumb" alt="incident photo"></a>`).join('')}</div>`
      : '';
    const followUpHTML = d.followUpDate ? `<div class="inc-followup">📅 Follow-up: <strong>${d.followUpDate}</strong></div>` : '';
    const citationHTML2 = d.type === 'citation' ? `<div class="inc-citation-summary">
      ${d.citationNumber ? `<span class="inc-cite-tag">🎫 #${escapeHtml(d.citationNumber)}</span>` : ''}
      ${d.citationViolation ? `<span class="inc-cite-tag">${{parking:'🅿️ Parking',red_light:'🚦 Red Light',speeding:'💨 Speeding',toll:'🛣️ Toll',other:'📝 Other'}[d.citationViolation]||d.citationViolation}</span>` : ''}
      ${d.citationAmount != null ? `<span class="inc-cite-tag">💵 $${Number(d.citationAmount).toFixed(2)}</span>` : ''}
      ${d.citationDueDate ? `<span class="inc-cite-tag">⏰ Due ${d.citationDueDate}</span>` : ''}
      ${d.citationCustomer ? `<span class="inc-cite-tag">👤 ${escapeHtml(d.citationCustomer)}</span>` : ''}
      ${d.citationReimbStatus ? `<span class="inc-cite-reimb inc-cite-reimb-${d.citationReimbStatus}">${{pending:'⏳ Pending',paid_by_company:'💳 Paid by Co.',reimbursed:'✅ Reimbursed',escalated:'⚠️ Escalated',written_off:'🗑️ Written Off'}[d.citationReimbStatus]||d.citationReimbStatus}</span>` : ''}
    </div>` : '';
    const REIMB_LABELS = {na:'🚫 N/A',pending:'⏳ Pending',paid:'💵 Paid ✅',partial:'🔁 Partial',denied:'❌ Denied',escalated:'⚠️ Escalated'};
    const TURO_LABELS  = {no:'❌ No Claim',yes:'✅ Claim Filed',pending:'🕐 Pending'};
    const damageHTML2 = TURO_ELIGIBLE_INCIDENT_TYPES.includes(d.type) ? `<div class="inc-damage-summary">
      ${d.damgeTuroClaim && d.damgeTuroClaim !== 'no' ? `<span class="inc-dmg-tag">🛡️ Turo: ${TURO_LABELS[d.damgeTuroClaim]||d.damgeTuroClaim}</span>` : ''}
      ${d.damgeTuroClaimNum ? `<span class="inc-dmg-tag">📋 ${escapeHtml(d.damgeTuroClaimNum)}</span>` : ''}
      ${d.damgeAmountClaimed != null ? `<span class="inc-dmg-tag">💸 Claimed $${Number(d.damgeAmountClaimed).toFixed(2)}</span>` : ''}
      ${d.damgeAmountReceived != null ? `<span class="inc-dmg-tag">💰 Received $${Number(d.damgeAmountReceived).toFixed(2)}</span>` : ''}
      ${d.damgeReimbStatus ? `<span class="inc-dmg-reimb inc-dmg-reimb-${d.damgeReimbStatus}">${REIMB_LABELS[d.damgeReimbStatus]||d.damgeReimbStatus}</span>` : ''}
      ${d.damgeClaimNotes ? `<span class="inc-dmg-tag">📝 ${escapeHtml(d.damgeClaimNotes)}</span>` : ''}
      ${_buildTuroCountdown(d, nowMs)}
    </div>` : '';
    const REC_STATUS_LABELS2 = {na:'🚫 N/A',pending:'⏳ Pending',collected:'✅ Collected',partial:'🔁 Partial',written_off:'🗑️ Written Off'};
    const RECOVERY_CARD_TYPES2 = ['key_lost','theft','maintenance','complaint','other'];
    const recoveryHTML2 = RECOVERY_CARD_TYPES2.includes(d.type) && (d.recoveryCost != null || d.recoveryBilled != null || (d.recoveryStatus && d.recoveryStatus !== 'na')) ? `<div class="inc-recovery-summary">
      ${d.recoveryCost   != null ? `<span class="inc-rec-tag">💸 Cost: $${Number(d.recoveryCost).toFixed(2)}</span>` : ''}
      ${d.recoveryBilled != null ? `<span class="inc-rec-tag">📋 Billed: $${Number(d.recoveryBilled).toFixed(2)}</span>` : ''}
      ${d.recoveryStatus && d.recoveryStatus !== 'na' ? `<span class="inc-rec-status inc-rec-status-${d.recoveryStatus}">${REC_STATUS_LABELS2[d.recoveryStatus]||d.recoveryStatus}</span>` : ''}
      ${d.recoveryNotes ? `<span class="inc-rec-tag">📝 ${escapeHtml(d.recoveryNotes)}</span>` : ''}
    </div>` : '';
    const resolvedBlock = d.status === 'resolved' && d.resolution
      ? `<div class="inc-resolution"><span class="inc-res-label">✅ Resolution:</span> <span>${escapeHtml(d.resolution)}</span>${d.resolvedByName ? ` <span class="inc-res-by">— ${escapeHtml(d.resolvedByName)}</span>` : ''}</div>`
      : '';
    const canResolve = d.status !== 'resolved';
    return `<div class="inc-card ${d.status === 'resolved' ? 'inc-resolved' : ''} ${d.urgent ? 'inc-urgent' : ''}">
      <div class="inc-header">
        <span class="inc-plate-tag">${escapeHtml(d.vehiclePlate||'—')}</span>
        <span class="inc-type-badge" style="background:${typeInfo.color}20;color:${typeInfo.color};border-color:${typeInfo.color}40;">${typeInfo.label}</span>
        ${d.urgent ? '<span class="inc-urgent-badge">🚨 URGENT</span>' : ''}
        <span class="inc-status-badge ${statusInfo.cls}">${statusInfo.label}</span>
        <span class="inc-date">${dateStr}</span>
      </div>
      <div class="inc-title">${escapeHtml(d.title||'')}</div>
      ${d.description ? `<div class="inc-desc">${escapeHtml(d.description)}</div>` : ''}
      ${citationHTML2}
      ${damageHTML2}
      ${recoveryHTML2}
      <div class="inc-reporter">Reported by: ${escapeHtml(d.reportedByName||'—')}</div>
      ${followUpHTML}${photosHTML}${resolvedBlock}
      <div class="inc-actions">
        ${canResolve ? `<button class="btn btn-sm inc-resolve-btn" onclick="openIncidentEditFromDashboard('${doc.id}',true)">Update Status</button>` : ''}
        <button class="btn btn-sm btn-outline" onclick="openIncidentEditFromDashboard('${doc.id}',false)">Edit</button>
        ${currentUserRole === 'admin' ? `<button class="btn btn-sm btn-danger" onclick="deleteIncident('${doc.id}')">Delete</button>` : ''}
      </div>
    </div>`;
  }).join('');
}

// Build a countdown chip for Turo-eligible incidents
function _buildTuroCountdown(d, nowMs) {
  if (!TURO_ELIGIBLE_INCIDENT_TYPES.includes(d.type)) return '';
  if (d.status === 'resolved') return '';
  if (d.damgeTuroClaim === 'yes') return '<span class="turo-countdown turo-cd-filed">🛡️ Turo Claim Filed</span>';
  if (d.damgeTuroClaim === 'no') return '';
  const createdMs = d.createdAt ? (d.createdAt.toMillis ? d.createdAt.toMillis() : 0) : 0;
  if (!createdMs) return '';
  const deadlineMs = createdMs + 24 * 3600 * 1000;
  const msLeft = deadlineMs - nowMs;
  const hoursLeft = msLeft / 3600000;
  if (hoursLeft < 0) {
    const hoursAgo = Math.abs(hoursLeft);
    return `<span class="turo-countdown turo-cd-expired">⚠️ Turo window expired ${hoursAgo < 24 ? Math.floor(hoursAgo)+'h ago' : Math.floor(hoursAgo/24)+'d ago'}</span>`;
  }
  if (hoursLeft < 4) return `<span class="turo-countdown turo-cd-critical">🔴 ${Math.floor(hoursLeft)}h ${Math.floor((hoursLeft%1)*60)}m — FILE TURO NOW</span>`;
  if (hoursLeft < 12) return `<span class="turo-countdown turo-cd-warning">🟡 ${Math.floor(hoursLeft)}h left to file Turo claim</span>`;
  return `<span class="turo-countdown turo-cd-ok">🟢 ${Math.floor(hoursLeft)}h left to file Turo claim</span>`;
}

// Turo Claims banner — shows at top of incidents tab for open Turo-eligible incidents
function renderTuroClaimsBanner(docs) {
  const banner = $('turo-claims-banner');
  if (!banner) return;
  const nowMs = Date.now();
  const TURO_ELIGIBLE = TURO_ELIGIBLE_INCIDENT_TYPES;
  const turoOpen = docs.filter(d => {
    const data = d.data();
    return TURO_ELIGIBLE.includes(data.type) && data.status !== 'resolved' && data.damgeTuroClaim !== 'yes' && data.damgeTuroClaim !== 'no';
  });
  if (!turoOpen.length) { banner.style.display = 'none'; return; }

  // Show within 48h only (beyond that it's clearly expired, less urgent)
  const relevant = turoOpen.filter(d => {
    const createdMs = d.data().createdAt ? (d.data().createdAt.toMillis ? d.data().createdAt.toMillis() : 0) : 0;
    return !createdMs || (nowMs - createdMs) < 48 * 3600000;
  });
  if (!relevant.length) { banner.style.display = 'none'; return; }

  relevant.sort((a, b) => {
    const aMs = a.data().createdAt ? (a.data().createdAt.toMillis ? a.data().createdAt.toMillis() : 0) : 0;
    const bMs = b.data().createdAt ? (b.data().createdAt.toMillis ? b.data().createdAt.toMillis() : 0) : 0;
    return aMs - bMs; // oldest first = most urgent
  });

  banner.style.display = '';
  const items = relevant.map(doc => {
    const d = doc.data();
    const createdMs = d.createdAt ? (d.createdAt.toMillis ? d.createdAt.toMillis() : 0) : 0;
    const msLeft = createdMs ? (createdMs + 24 * 3600000) - nowMs : null;
    const hoursLeft = msLeft !== null ? msLeft / 3600000 : null;
    let countdownHtml, urgencyClass;
    if (hoursLeft === null) {
      countdownHtml = '<span class="turo-countdown turo-cd-ok">⏱️ File within 24h</span>';
      urgencyClass = '';
    } else if (hoursLeft < 0) {
      const ago = Math.abs(hoursLeft);
      countdownHtml = `<span class="turo-countdown turo-cd-expired">⚠️ Expired ${ago < 24 ? Math.floor(ago)+'h ago' : Math.floor(ago/24)+'d ago'}</span>`;
      urgencyClass = 'turo-item-expired';
    } else if (hoursLeft < 4) {
      countdownHtml = `<span class="turo-countdown turo-cd-critical">🔴 ${Math.floor(hoursLeft)}h ${Math.floor((hoursLeft%1)*60)}m LEFT</span>`;
      urgencyClass = 'turo-item-critical';
    } else if (hoursLeft < 12) {
      countdownHtml = `<span class="turo-countdown turo-cd-warning">🟡 ${Math.floor(hoursLeft)}h left</span>`;
      urgencyClass = 'turo-item-warning';
    } else {
      countdownHtml = `<span class="turo-countdown turo-cd-ok">🟢 ${Math.floor(hoursLeft)}h left</span>`;
      urgencyClass = '';
    }
    const typeInfo = INCIDENT_TYPES[d.type] || INCIDENT_TYPES.other;
    return `<div class="turo-claim-item ${urgencyClass}" onclick="openIncidentEditFromDashboard('${doc.id}',false)" title="Click to update claim">
      <div class="turo-item-left">
        <span class="turo-item-type" style="color:${typeInfo.color};">${typeInfo.label}</span>
        <span class="turo-item-plate">🚗 ${escapeHtml(d.vehiclePlate||'—')}</span>
        <span class="turo-item-title">${escapeHtml(d.title||'')}</span>
      </div>
      <div class="turo-item-right">
        ${countdownHtml}
        <button class="btn btn-sm turo-file-btn" onclick="event.stopPropagation(); openIncidentEditFromDashboard('${doc.id}',false)">Update Claim →</button>
      </div>
    </div>`;
  }).join('');

  banner.innerHTML = `<div class="turo-claims-banner">
    <div class="turo-banner-header">
      <span class="turo-banner-title">🛡️ Turo Claim Window — File Within 24 Hours</span>
      <span class="turo-banner-count">${relevant.length} pending</span>
    </div>
    <div class="turo-banner-items">${items}</div>
  </div>`;
}

async function loadAllOpenIncidentsDashboard() {
  const list = $('incidents-dashboard-list');
  if (!list) return;
  const isPriv = currentUserRole === 'admin' || currentUserRole === 'manager';
  const tabBtn = $('incidents-tab-btn');
  if (!isPriv) { if (tabBtn) tabBtn.style.display = 'none'; return; }
  if (tabBtn) tabBtn.style.display = '';
  try {
    const snap = await db.collection('incidents').get();
    const docs = snap.docs.sort((a, b) => {
      const as = a.data().status, bs2 = b.data().status;
      const aOpen = as !== 'resolved' ? 1 : 0, bOpen = bs2 !== 'resolved' ? 1 : 0;
      if (aOpen !== bOpen) return bOpen - aOpen;
      const au = a.data().urgent ? 1 : 0, bu = b.data().urgent ? 1 : 0;
      if (au !== bu) return bu - au;
      const at = a.data().createdAt ? (a.data().createdAt.toMillis ? a.data().createdAt.toMillis() : 0) : 0;
      const bt = b.data().createdAt ? (b.data().createdAt.toMillis ? b.data().createdAt.toMillis() : 0) : 0;
      return bt - at;
    });
    _cachedIncidentDocs = docs;
    // Sync vehicle page incidents if open
    if (selectedVehicle) {
      const vid = selectedVehicle.id || selectedVehicle;
      currentVehicleIncidents = docs.filter(d => d.data().vehicleId === vid);
      renderIncidentsList(currentVehicleIncidents);
    }
    const openCount = docs.filter(d => d.data().status !== 'resolved').length;
    const badge = $('incidents-tab-badge');
    if (badge) {
      badge.textContent = openCount > 0 ? openCount : '';
      badge.style.display = openCount > 0 ? '' : 'none';
    }
    if (!docs.length) {
      if (list) list.innerHTML = '<p class="hint">No incidents reported yet. Use + Report Incident to log one.</p>';
      const banner = $('turo-claims-banner');
      if (banner) banner.style.display = 'none';
      return;
    }
    // Render Turo claims deadline banner
    renderTuroClaimsBanner(docs);
    // Render filtered list
    _renderFilteredIncidentList(docs);
  } catch(e) { console.error(e); }
}

// ---- Load incidents for a specific vehicle ----
async function loadVehicleIncidents(vehicleId) {
  const list = $('incidents-list');
  if (!list) return;
  list.innerHTML = '<p class="hint">Loading…</p>';
  try {
    const snap = await db.collection('incidents')
      .where('vehicleId', '==', vehicleId)
      .get();
    const docs = snap.docs.sort((a, b) => {
      const at = a.data().createdAt ? (a.data().createdAt.toMillis ? a.data().createdAt.toMillis() : 0) : 0;
      const bt = b.data().createdAt ? (b.data().createdAt.toMillis ? b.data().createdAt.toMillis() : 0) : 0;
      return bt - at; // newest first
    });
    currentVehicleIncidents = docs;
    // Update vehicle header badge
    const vBadge = $('incident-count-vehicle');
    const vBtn   = $('btn-incidents-vehicle');
    const openCount = docs.filter(d => d.data().status !== 'resolved').length;
    if (vBadge) { vBadge.textContent = openCount; vBadge.classList.toggle('count-zero', openCount === 0); }
    if (vBtn) vBtn.style.display = openCount > 0 ? '' : 'none';
    renderIncidentsList(docs);
  } catch(e) { console.error(e); list.innerHTML = '<p class="hint" style="color:#ef4444;">Error loading incidents.</p>'; }
}

function renderIncidentsList(docs) {
  const list = $('incidents-list');
  if (!list) return;
  const isPriv = currentUserRole === 'admin' || currentUserRole === 'manager';
  if (!docs.length) {
    list.innerHTML = '<p class="hint">No incidents reported for this vehicle.</p>';
    return;
  }
  list.innerHTML = docs.map(doc => {
    const d = doc.data();
    const typeInfo   = INCIDENT_TYPES[d.type]   || INCIDENT_TYPES.other;
    const statusInfo = INCIDENT_STATUS[d.status] || INCIDENT_STATUS.open;
    const dateStr    = d.createdAt ? new Date(d.createdAt.toMillis ? d.createdAt.toMillis() : d.createdAt).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }) : '';
    const urgentBadge = d.urgent ? '<span class="inc-urgent-badge">🚨 URGENT</span>' : '';
    const photosHTML = (d.photoUrls && d.photoUrls.length)
      ? `<div class="inc-photos">${d.photoUrls.map(url => `<a href="${url}" target="_blank"><img src="${url}" class="inc-thumb" alt="photo"></a>`).join('')}</div>`
      : '';
    const followUpHTML = d.followUpDate ? `<div class="inc-followup">📅 Follow-up: <strong>${d.followUpDate}</strong></div>` : '';
    const citationHTML = d.type === 'citation' ? `<div class="inc-citation-summary">
      ${d.citationNumber ? `<span class="inc-cite-tag">🎫 #${escapeHtml(d.citationNumber)}</span>` : ''}
      ${d.citationViolation ? `<span class="inc-cite-tag">${{parking:'🅿️ Parking',red_light:'🚦 Red Light',speeding:'💨 Speeding',toll:'🛣️ Toll',other:'📝 Other'}[d.citationViolation]||d.citationViolation}</span>` : ''}
      ${d.citationAmount != null ? `<span class="inc-cite-tag">💵 $${Number(d.citationAmount).toFixed(2)}</span>` : ''}
      ${d.citationDueDate ? `<span class="inc-cite-tag">⏰ Due ${d.citationDueDate}</span>` : ''}
      ${d.citationCustomer ? `<span class="inc-cite-tag">👤 ${escapeHtml(d.citationCustomer)}</span>` : ''}
      ${d.citationReimbStatus ? `<span class="inc-cite-reimb inc-cite-reimb-${d.citationReimbStatus}">${{pending:'⏳ Pending',paid_by_company:'💳 Paid by Co.',reimbursed:'✅ Reimbursed',escalated:'⚠️ Escalated',written_off:'🗑️ Written Off'}[d.citationReimbStatus]||d.citationReimbStatus}</span>` : ''}
    </div>` : '';
    const REIMB_LABELS = {na:'🚫 N/A',pending:'⏳ Pending',paid:'💵 Paid ✅',partial:'🔁 Partial',denied:'❌ Denied',escalated:'⚠️ Escalated'};
    const TURO_LABELS  = {no:'❌ No Claim',yes:'✅ Claim Filed',pending:'🕐 Pending'};
    const REC_STATUS_LABELS = {na:'🚫 N/A',pending:'⏳ Pending',collected:'✅ Collected',partial:'🔁 Partial',written_off:'🗑️ Written Off'};
    const damageHTML = (d.type === 'damage' || d.type === 'accident') ? `<div class="inc-damage-summary">
      ${d.damgeTuroClaim && d.damgeTuroClaim !== 'no' ? `<span class="inc-dmg-tag">🛡️ Turo: ${TURO_LABELS[d.damgeTuroClaim]||d.damgeTuroClaim}</span>` : ''}
      ${d.damgeTuroClaimNum ? `<span class="inc-dmg-tag">📋 ${escapeHtml(d.damgeTuroClaimNum)}</span>` : ''}
      ${d.damgeAmountClaimed != null ? `<span class="inc-dmg-tag">💸 Claimed $${Number(d.damgeAmountClaimed).toFixed(2)}</span>` : ''}
      ${d.damgeAmountReceived != null ? `<span class="inc-dmg-tag">💰 Received $${Number(d.damgeAmountReceived).toFixed(2)}</span>` : ''}
      ${d.damgeReimbStatus ? `<span class="inc-dmg-reimb inc-dmg-reimb-${d.damgeReimbStatus}">${REIMB_LABELS[d.damgeReimbStatus]||d.damgeReimbStatus}</span>` : ''}
      ${d.damgeClaimNotes ? `<span class="inc-dmg-tag">📝 ${escapeHtml(d.damgeClaimNotes)}</span>` : ''}
    </div>` : '';
    const RECOVERY_CARD_TYPES = ['key_lost','theft','maintenance','complaint','other'];
    const recoveryHTML = RECOVERY_CARD_TYPES.includes(d.type) && (d.recoveryCost != null || d.recoveryBilled != null || (d.recoveryStatus && d.recoveryStatus !== 'na')) ? `<div class="inc-recovery-summary">
      ${d.recoveryCost   != null ? `<span class="inc-rec-tag">💸 Cost: $${Number(d.recoveryCost).toFixed(2)}</span>` : ''}
      ${d.recoveryBilled != null ? `<span class="inc-rec-tag">📋 Billed: $${Number(d.recoveryBilled).toFixed(2)}</span>` : ''}
      ${d.recoveryStatus && d.recoveryStatus !== 'na' ? `<span class="inc-rec-status inc-rec-status-${d.recoveryStatus}">${REC_STATUS_LABELS[d.recoveryStatus]||d.recoveryStatus}</span>` : ''}
      ${d.recoveryNotes ? `<span class="inc-rec-tag">📝 ${escapeHtml(d.recoveryNotes)}</span>` : ''}
    </div>` : '';
    const resolvedBlock = d.status === 'resolved' && d.resolution
      ? `<div class="inc-resolution"><span class="inc-res-label">✅ Resolution:</span> <span>${escapeHtml(d.resolution)}</span>${d.resolvedByName ? ` <span class="inc-res-by">— ${escapeHtml(d.resolvedByName)}</span>` : ''}</div>`
      : '';
    const canResolve = isPriv && d.status !== 'resolved';
    const canEdit    = isPriv || d.reportedBy === currentUser.uid;
    const canDelete  = currentUserRole === 'admin';
    const actionBtns = `<div class="inc-actions">
      ${canResolve ? `<button class="btn btn-sm inc-resolve-btn" onclick="openIncidentEditFromDashboard('${doc.id}',true)">Update Status</button>` : ''}
      ${canEdit    ? `<button class="btn btn-sm btn-outline" onclick="openIncidentEditFromDashboard('${doc.id}',false)">Edit</button>` : ''}
      ${canDelete  ? `<button class="btn btn-sm btn-danger" onclick="deleteIncident('${doc.id}')">Delete</button>` : ''}
    </div>`;
    return `<div class="inc-card ${d.status === 'resolved' ? 'inc-resolved' : ''} ${d.urgent ? 'inc-urgent' : ''}">
      <div class="inc-header">
        <span class="inc-type-badge" style="background:${typeInfo.color}20;color:${typeInfo.color};border-color:${typeInfo.color}40;">${typeInfo.label}</span>
        ${urgentBadge}
        <span class="inc-status-badge ${statusInfo.cls}">${statusInfo.label}</span>
        <span class="inc-date">${dateStr}</span>
      </div>
      <div class="inc-title">${escapeHtml(d.title || '')}</div>
      ${d.description ? `<div class="inc-desc">${escapeHtml(d.description)}</div>` : ''}
      ${citationHTML}
      ${damageHTML}
      ${recoveryHTML}
      <div class="inc-reporter">Reported by: ${escapeHtml(d.reportedByName || '—')}</div>
      ${followUpHTML}${photosHTML}${resolvedBlock}
      ${actionBtns}
    </div>`;
  }).join('');
}

// Photo file staging for incident modal
let incidentStagedFiles = [];

// ---- Open "Report / Edit / Resolve" modal ----
window.openIncidentModal = function(incidentId, focusResolve) {
  const overlay = $('incident-overlay');
  if (!overlay) return;
  incidentStagedFiles = [];
  const previews = $('incident-photo-previews');
  if (previews) previews.innerHTML = '';
  const statusSel = $('incident-status-select');
  const resRow    = $('incident-resolution-row');

  $('incident-edit-id').value = incidentId || '';
  $('incident-modal-title').textContent = incidentId ? '✏️ Edit Incident' : '🚨 Report Incident';

  if (incidentId) {
    const doc = currentVehicleIncidents.find(d => d.id === incidentId);
    if (!doc) return;
    const d = doc.data();
    $('incident-type').value              = d.type || 'other';
    $('incident-title').value             = d.title || '';
    $('incident-description').value       = d.description || '';
    $('incident-urgent').checked          = !!d.urgent;
    $('incident-followup-date').value     = d.followUpDate || '';
    if (statusSel) statusSel.value        = d.status || 'open';
    if (resRow) resRow.style.display      = (d.status === 'in_progress' || d.status === 'resolved') ? '' : 'none';
    const inlineRes = $('incident-resolution-inline');
    if (inlineRes) inlineRes.value        = d.resolution || '';
    // Show existing photos
    if (previews && d.photoUrls && d.photoUrls.length) {
      previews.innerHTML = d.photoUrls.map(url =>
        `<a href="${url}" target="_blank"><img src="${url}" class="inc-thumb-preview" alt="photo"></a>`
      ).join('');
    }
    const vehicleRow = $('incident-vehicle-row');
    if (vehicleRow) vehicleRow.style.display = 'none';
    // Populate citation fields if applicable
    if ($('citation-number')) $('citation-number').value = d.citationNumber || '';
    if ($('citation-violation-type')) $('citation-violation-type').value = d.citationViolation || 'parking';
    if ($('citation-amount')) $('citation-amount').value = d.citationAmount != null ? d.citationAmount : '';
    if ($('citation-due-date')) $('citation-due-date').value = d.citationDueDate || '';
    if ($('citation-customer')) $('citation-customer').value = d.citationCustomer || '';
    if ($('citation-reimb-status')) $('citation-reimb-status').value = d.citationReimbStatus || 'pending';
    // Populate damage/claim fields if applicable
    if ($('damage-turo-claim')) $('damage-turo-claim').value = d.damgeTuroClaim || 'no';
    if ($('damage-turo-claim-num')) $('damage-turo-claim-num').value = d.damgeTuroClaimNum || '';
    if ($('damage-reimb-status')) $('damage-reimb-status').value = d.damgeReimbStatus || 'na';
    if ($('damage-amount-claimed')) $('damage-amount-claimed').value = d.damgeAmountClaimed != null ? d.damgeAmountClaimed : '';
    if ($('damage-amount-received')) $('damage-amount-received').value = d.damgeAmountReceived != null ? d.damgeAmountReceived : '';
    if ($('damage-claim-notes')) $('damage-claim-notes').value = d.damgeClaimNotes || '';
    // Populate cost/recovery fields if applicable
    if ($('recovery-cost'))   $('recovery-cost').value   = d.recoveryCost   != null ? d.recoveryCost   : '';
    if ($('recovery-billed')) $('recovery-billed').value = d.recoveryBilled != null ? d.recoveryBilled : '';
    if ($('recovery-status')) $('recovery-status').value = d.recoveryStatus || 'na';
    if ($('recovery-notes'))  $('recovery-notes').value  = d.recoveryNotes  || '';
    toggleIncidentTypeFields();
  } else {
    $('incident-type').value          = 'damage';
    $('incident-title').value         = '';
    $('incident-description').value   = '';
    $('incident-urgent').checked      = false;
    $('incident-followup-date').value = '';
    if (statusSel) statusSel.value    = 'open';
    if (resRow) resRow.style.display  = 'none';
    const inlineRes = $('incident-resolution-inline');
    if (inlineRes) inlineRes.value    = '';
    // Clear citation fields
    if ($('citation-number')) $('citation-number').value = '';
    if ($('citation-amount')) $('citation-amount').value = '';
    if ($('citation-due-date')) $('citation-due-date').value = '';
    if ($('citation-customer')) $('citation-customer').value = '';
    if ($('citation-violation-type')) $('citation-violation-type').value = 'parking';
    if ($('citation-reimb-status')) $('citation-reimb-status').value = 'pending';
    // Clear damage/claim fields
    if ($('damage-turo-claim')) $('damage-turo-claim').value = 'no';
    if ($('damage-turo-claim-num')) $('damage-turo-claim-num').value = '';
    if ($('damage-reimb-status')) $('damage-reimb-status').value = 'na';
    if ($('damage-amount-claimed')) $('damage-amount-claimed').value = '';
    if ($('damage-amount-received')) $('damage-amount-received').value = '';
    if ($('damage-claim-notes')) $('damage-claim-notes').value = '';
    // Clear cost/recovery fields
    if ($('recovery-cost'))   $('recovery-cost').value   = '';
    if ($('recovery-billed')) $('recovery-billed').value = '';
    if ($('recovery-status')) $('recovery-status').value = 'na';
    if ($('recovery-notes'))  $('recovery-notes').value  = '';
    toggleIncidentTypeFields();
    const vehicleRow = $('incident-vehicle-row');
    const vehicleSel = $('incident-vehicle-select');
    if (vehicleRow) vehicleRow.style.display = '';
    if (vehicleSel) {
      vehicleSel.innerHTML = vehiclesCache.map(v =>
        `<option value="${v.id}">${escapeHtml(v.plate)} ${escapeHtml(v.make||'')} ${escapeHtml(v.model||'')}</option>`
      ).join('');
      if (selectedVehicle) vehicleSel.value = selectedVehicle.id || selectedVehicle;
    }
  }

  // Wire status change to show/hide resolution field
  if (statusSel) {
    statusSel.onchange = () => {
      if (resRow) resRow.style.display = (statusSel.value === 'in_progress' || statusSel.value === 'resolved') ? '' : 'none';
    };
  }

  // Wire photo input
  const photoInput = $('incident-photo-input');
  if (photoInput) {
    photoInput.value = '';
    photoInput.onchange = function() {
      const files = Array.from(this.files);
      incidentStagedFiles = [...incidentStagedFiles, ...files];
      const prev = $('incident-photo-previews');
      if (prev) {
        const newPreviews = files.map(f => {
          const url = URL.createObjectURL(f);
          return `<img src="${url}" class="inc-thumb-preview" alt="${escapeHtml(f.name)}">`;
        }).join('');
        prev.innerHTML += newPreviews;
      }
    };
  }

  overlay.style.display = 'flex';
  if (focusResolve && statusSel) {
    statusSel.value = 'in_progress';
    if (resRow) resRow.style.display = '';
    setTimeout(() => { const r = $('incident-resolution-inline'); if (r) r.focus(); }, 100);
  }
};

// Edit from dashboard (load from Firestore since currentVehicleIncidents may not have dashboard items)
window.openIncidentEditFromDashboard = async function(incidentId, focusResolve) {
  try {
    const snap = await db.collection('incidents').doc(incidentId).get();
    if (!snap.exists) return;
    const existing = currentVehicleIncidents.find(d => d.id === incidentId);
    if (!existing) currentVehicleIncidents.push(snap);
    else {
      // replace stale entry
      const idx = currentVehicleIncidents.findIndex(d => d.id === incidentId);
      currentVehicleIncidents[idx] = snap;
    }
    openIncidentModal(incidentId, focusResolve);
  } catch(e) { toast('Failed to load incident.', 'error'); }
};

window.closeIncidentModal = function() {
  const overlay = $('incident-overlay');
  if (overlay) overlay.style.display = 'none';
};

window.toggleIncidentTypeFields = function() {
  const type = $('incident-type') ? $('incident-type').value : '';
  const citPanel = $('citation-fields');
  const dmgPanel = $('damage-fields');
  const recPanel = $('recovery-fields');
  const dmgHeader = dmgPanel ? dmgPanel.querySelector('.damage-fields-header') : null;
  if (citPanel) citPanel.style.display = type === 'citation' ? '' : 'none';
  const turoTypes = ['damage', 'accident', 'cleaning', 'smoking'];
  if (dmgPanel) {
    dmgPanel.style.display = turoTypes.includes(type) ? '' : 'none';
    if (dmgHeader) {
      if (type === 'cleaning') dmgHeader.textContent = '🧹 Turo Cleaning Claim';
      else if (type === 'smoking') dmgHeader.textContent = '🚬 Turo Smoking Claim';
      else dmgHeader.textContent = '🛡️ Claim & Reimbursement';
    }
  }
  const recoveryTypes = ['key_lost', 'theft', 'maintenance', 'complaint', 'other'];
  if (recPanel) recPanel.style.display = recoveryTypes.includes(type) ? '' : 'none';
};
// Legacy alias
window.toggleCitationFields = window.toggleIncidentTypeFields;

window.saveIncident = async function() {
  const title = ($('incident-title').value || '').trim();
  if (!title) { $('incident-title').focus(); toast('Please enter a title / summary.', 'error'); return; }

  const editId     = $('incident-edit-id').value;
  const type       = $('incident-type').value;
  const desc       = ($('incident-description').value || '').trim();
  const urgent     = $('incident-urgent').checked;
  const status     = $('incident-status-select') ? $('incident-status-select').value : 'open';
  const resolution = ($('incident-resolution-inline') ? $('incident-resolution-inline').value : '').trim();
  const followUpDate = ($('incident-followup-date') ? $('incident-followup-date').value : '').trim();

  // Citation-specific fields
  const isCitation = type === 'citation';
  const citationData = isCitation ? {
    citationNumber:     ($('citation-number')       ? $('citation-number').value.trim()       : ''),
    citationViolation:  ($('citation-violation-type')? $('citation-violation-type').value      : 'parking'),
    citationAmount:     ($('citation-amount')        ? parseFloat($('citation-amount').value) || null : null),
    citationDueDate:    ($('citation-due-date')      ? $('citation-due-date').value            : ''),
    citationCustomer:   ($('citation-customer')      ? $('citation-customer').value.trim()     : ''),
    citationReimbStatus:($('citation-reimb-status')  ? $('citation-reimb-status').value        : 'pending'),
  } : null;

  // Damage/accident-specific fields
  const isDamage = ['damage', 'accident', 'cleaning', 'smoking'].includes(type);
  const damageData = isDamage ? {
    damgeTuroClaim:     ($('damage-turo-claim')       ? $('damage-turo-claim').value           : 'no'),
    damgeTuroClaimNum:  ($('damage-turo-claim-num')   ? $('damage-turo-claim-num').value.trim(): ''),
    damgeReimbStatus:   ($('damage-reimb-status')     ? $('damage-reimb-status').value         : 'na'),
    damgeAmountClaimed: ($('damage-amount-claimed')   ? parseFloat($('damage-amount-claimed').value) || null : null),
    damgeAmountReceived:($('damage-amount-received')  ? parseFloat($('damage-amount-received').value) || null : null),
    damgeClaimNotes:    ($('damage-claim-notes')      ? $('damage-claim-notes').value.trim()   : ''),
  } : null;

  // Cost/recovery fields — for key_lost, theft, maintenance, complaint, other
  const RECOVERY_TYPES = ['key_lost', 'theft', 'maintenance', 'complaint', 'other'];
  const isRecovery = RECOVERY_TYPES.includes(type);
  const recoveryData = isRecovery ? {
    recoveryCost:   ($('recovery-cost')   ? parseFloat($('recovery-cost').value)   || null : null),
    recoveryBilled: ($('recovery-billed') ? parseFloat($('recovery-billed').value) || null : null),
    recoveryStatus: ($('recovery-status') ? $('recovery-status').value             : 'na'),
    recoveryNotes:  ($('recovery-notes')  ? $('recovery-notes').value.trim()       : ''),
  } : null;

  const vehicleId    = selectedVehicle ? (selectedVehicle.id || selectedVehicle) : ($('incident-vehicle-select') ? $('incident-vehicle-select').value : '');
  const vehiclePlate = selectedVehicle ? selectedVehicle.plate : (vehiclesCache.find(v => v.id === vehicleId) || {}).plate || '';

  const statusEl = $('incident-upload-status');
  if (statusEl) statusEl.textContent = '';

  // Upload any staged photos
  let newPhotoUrls = [];
  if (incidentStagedFiles.length) {
    if (statusEl) statusEl.textContent = `Uploading ${incidentStagedFiles.length} photo(s)…`;
    try {
      const incId = editId || ('temp_' + Date.now());
      const st = getStorage();
      if (!st) throw new Error('Storage not available');
      newPhotoUrls = await Promise.all(incidentStagedFiles.map(async (file, i) => {
        const ext  = file.name.split('.').pop() || 'jpg';
        const path = `incidents/${vehicleId || 'general'}/${incId}_${Date.now()}_${i}.${ext}`;
        const ref  = st.ref(path);
        await ref.put(file);
        return await ref.getDownloadURL();
      }));
    } catch(e) {
      console.error(e);
      toast('Photo upload failed. Saving without photos.', 'error');
      newPhotoUrls = [];
    }
    if (statusEl) statusEl.textContent = '';
  }

  try {
    let docId = editId;
    if (editId) {
      const existingDoc = currentVehicleIncidents.find(d => d.id === editId);
      const existingUrls = existingDoc ? (existingDoc.data().photoUrls || []) : [];
      const updateData = {
        type, title, description: desc, urgent, status,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        photoUrls: [...existingUrls, ...newPhotoUrls],
      };
      if (citationData) Object.assign(updateData, citationData);
      else {
        // clear citation fields if type changed away from citation
        ['citationNumber','citationViolation','citationAmount','citationDueDate','citationCustomer','citationReimbStatus']
          .forEach(k => { updateData[k] = firebase.firestore.FieldValue.delete(); });
      }
      if (damageData) Object.assign(updateData, damageData);
      else {
        // clear damage fields if type changed away from damage/accident
        ['damgeTuroClaim','damgeTuroClaimNum','damgeReimbStatus','damgeAmountClaimed','damgeAmountReceived','damgeClaimNotes']
          .forEach(k => { updateData[k] = firebase.firestore.FieldValue.delete(); });
      }
      if (recoveryData) Object.assign(updateData, recoveryData);
      else {
        // clear recovery fields if type changed away from recovery types
        ['recoveryCost','recoveryBilled','recoveryStatus','recoveryNotes']
          .forEach(k => { updateData[k] = firebase.firestore.FieldValue.delete(); });
      }
      if (followUpDate) updateData.followUpDate = followUpDate;
      if (resolution) {
        updateData.resolution     = resolution;
        updateData.resolvedBy     = currentUser.uid;
        updateData.resolvedByName = currentUser.displayName || currentUser.email;
        if (status === 'resolved') updateData.resolvedAt = firebase.firestore.FieldValue.serverTimestamp();
      }
      await db.collection('incidents').doc(editId).update(updateData);
      toast('Incident updated.', 'success');
    } else {
      // For Turo-eligible types on new incidents: force urgent + store deadline timestamp
      const TURO_ELIGIBLE = ['damage', 'accident', 'cleaning', 'smoking'];
      const isTuroEligible = TURO_ELIGIBLE.includes(type);
      const finalUrgent = isTuroEligible ? true : urgent;
      const turoDeadlineAt = isTuroEligible
        ? firebase.firestore.Timestamp.fromDate(new Date(Date.now() + 24 * 3600 * 1000))
        : null;

      const docRef = await db.collection('incidents').add({
        vehicleId,
        vehiclePlate,
        type,
        title,
        description: desc,
        urgent: finalUrgent,
        status,
        resolution: resolution || '',
        resolvedBy: resolution ? currentUser.uid : '',
        resolvedByName: resolution ? (currentUser.displayName || currentUser.email) : '',
        resolvedAt: (resolution && status === 'resolved') ? firebase.firestore.FieldValue.serverTimestamp() : null,
        followUpDate: followUpDate || '',
        photoUrls: newPhotoUrls,
        ...(turoDeadlineAt ? { turoDeadlineAt } : {}),
        ...(citationData || {}),
        ...(damageData || {}),
        ...(recoveryData || {}),
        reportedBy: currentUser.uid,
        reportedByName: currentUser.displayName || currentUser.email,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      docId = docRef.id;
      toast('Incident reported.' + (isTuroEligible ? ' ⚠️ Turo claim window: 24 hours.' : ''), 'success');

      // Auto-create urgent Turo claim follow-up task on the dashboard
      if (isTuroEligible) {
        try {
          const turoTaskText = `🛡️ FILE TURO CLAIM: ${title}${vehiclePlate ? ' [' + vehiclePlate + ']' : ''}`;
          await db.collection('generalNotes').add({
            text: turoTaskText,
            isFollowUp: true,
            done: false,
            urgent: true,
            taskStatus: 'urgent',
            dueDate: todayDateString(),
            sourceType: 'incident_turo',
            incidentDocId: docId,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            createdBy: currentUser.uid,
            createdByName: currentUser.displayName || currentUser.email,
          });
        } catch(calErr) {
          console.warn('Could not create Turo follow-up task:', calErr);
        }
      }
    }

    incidentStagedFiles = [];
    closeIncidentModal();
    if (selectedVehicle) loadVehicleIncidents(selectedVehicle.id || selectedVehicle);
    loadAllOpenIncidentsDashboard();

    // If a follow-up date was set, attempt to create a calendar task (admin/manager only)
    if (followUpDate) {
      try {
        const taskText = `🚨 Incident Follow-Up: ${title}${vehiclePlate ? ' [' + vehiclePlate + ']' : ''}`;
        await db.collection('generalNotes').add({
          text: taskText,
          isFollowUp: true,
          done: false,
          urgent: urgent,
          dueDate: followUpDate,
          sourceType: 'incident',
          incidentDocId: docId,
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          createdBy: currentUser.uid,
          createdByName: currentUser.displayName || currentUser.email,
        });
        loadGeneralNotes();
        loadDashboardFollowUps();
      } catch(calErr) {
        console.warn('Could not create follow-up calendar task (requires manager/admin):', calErr);
      }
    }
  } catch(e) { console.error(e); toast('Failed to save incident.', 'error'); }
};

// ---- Delete ----
window.deleteIncident = async function(docId) {
  if (!(await confirm('Delete Incident', 'Delete this incident report? This cannot be undone.'))) return;
  try {
    await db.collection('incidents').doc(docId).delete();
    toast('Incident deleted.', 'success');
    if (selectedVehicle) loadVehicleIncidents(selectedVehicle.id || selectedVehicle);
    loadAllOpenIncidentsDashboard();
  } catch(e) { toast('Delete failed.', 'error'); }
};

// ================================================================
// TIME CLOCK WIDGET (Owner Only)
// ================================================================

function initTimeClock() {
  if (!currentUser) return;
  const tabBtn = $('mb-tab-timeclock');
  if (!currentUserTimeclockAccess) {
    if (tabBtn) tabBtn.style.display = 'none';
    return;
  }
  if (tabBtn) tabBtn.style.display = '';
  tcViewingUid = currentUser.uid;
  if (currentUserCanViewAllTimeclocks) {
    loadTcEmployees().then(() => loadWeekData(0));
  } else {
    loadWeekData(0);
  }
}

async function loadTcEmployees() {
  try {
    const snap = await db.collection('users').get();
    tcEmployees = [];
    snap.forEach(doc => {
      const d = doc.data();
      if (d.timeclockAccess || d.role === 'admin') {
        tcEmployees.push({ uid: doc.id, name: d.displayName || d.email, email: d.email });
      }
    });
  } catch(e) { console.error('loadTcEmployees error:', e); }
}

// Returns 7 YYYY-MM-DD strings (Mon-Sun) for the week at the given offset from the current week
function getWeekDates(offset) {
  const todayStr = todayDateString();
  const [y, mo, d] = todayStr.split('-').map(Number);
  const today = new Date(y, mo - 1, d);
  const dow = today.getDay(); // 0=Sun
  const daysToMon = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(y, mo - 1, d + daysToMon + (offset || 0) * 7);
  return Array.from({ length: 7 }, (_, i) => {
    const dd = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
    return `${dd.getFullYear()}-${String(dd.getMonth() + 1).padStart(2, '0')}-${String(dd.getDate()).padStart(2, '0')}`;
  });
}

// Sum net ms for completed sessions on a day doc
function calcDayCompletedMs(dayData) {
  if (!dayData) return 0;
  return (dayData.sessions || []).reduce((total, s) => {
    if (!s.clockIn || !s.clockOut) return total;
    const start = s.clockIn.toDate ? s.clockIn.toDate() : new Date(s.clockIn);
    const end = s.clockOut.toDate ? s.clockOut.toDate() : new Date(s.clockOut);
    const breakMs = (s.breaks || []).filter(b => b.end).reduce((sum, b) => {
      const bs = b.start.toDate ? b.start.toDate() : new Date(b.start);
      const be = b.end.toDate ? b.end.toDate() : new Date(b.end);
      return sum + (be - bs);
    }, 0);
    return total + Math.max(0, (end - start) - breakMs);
  }, 0);
}

function fmtMs(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (ms < 60000) return '< 1m';
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

async function loadWeekData(offset) {
  currentWeekOffset = offset;
  if (!currentUser) return;
  const viewUid = tcViewingUid || currentUser.uid;
  const dates = getWeekDates(offset);
  try {
    const snaps = await Promise.all(
      dates.map(d => db.collection('timeclock').doc(viewUid + '_' + d).get())
    );
    weeklyTimeclockData = {};
    snaps.forEach((snap, i) => { weeklyTimeclockData[dates[i]] = snap.exists ? snap.data() : null; });
    const today = todayDateString();
    timeclockData = weeklyTimeclockData[today] || null;
    renderTimeClock();
  } catch (e) {
    console.error('Load week data error:', e);
    renderTimeClock();
  }
}

function renderTimeClock() {
  const content = $('time-clock-content');
  if (!content) return;
  if (elapsedInterval) { clearInterval(elapsedInterval); elapsedInterval = null; }

  const isOwnClock = !tcViewingUid || tcViewingUid === currentUser.uid;
  const today = todayDateString();
  const dates = getWeekDates(currentWeekOffset);
  const isCurrentWeek = currentWeekOffset === 0;

  // ── Week header label ──
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const fmtD = (str) => { const [, mo, d] = str.split('-'); return `${MONTHS[+mo - 1]} ${+d}`; };
  const weekLabel = `${fmtD(dates[0])} – ${fmtD(dates[6])}, ${dates[6].slice(0, 4)}`;

  // ── Weekly grid ──
  const DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  let weekRows = '';
  let totalWeekMs = 0, totalGoal = 0, totalAchieved = 0;

  for (let i = 0; i < 7; i++) {
    const d = dates[i];
    const dd = weeklyTimeclockData[d];
    const isToday = d === today;
    const netMs = calcDayCompletedMs(dd);
    totalWeekMs += netMs;
    const goal = dd?.revenueGoal || 0;
    const achieved = dd?.revenueAchieved || 0;
    totalGoal += goal;
    totalAchieved += achieved;
    const [, mo, dy] = d.split('-');
    const dayLabel = `${DAYS[i]} ${+mo}/${+dy}`;
    const hasActive = isToday && dd?.activeSession;
    const hoursStr = netMs > 0
      ? fmtMs(netMs) + (hasActive ? ' <span class="tc-live-dot">⏱</span>' : '')
      : (hasActive ? '<span class="tc-live-dot">⏱ In Progress</span>' : '—');
    const revStr = goal > 0 ? `$${Number(achieved).toLocaleString()} / $${Number(goal).toLocaleString()}` : '—';
    const hasSessions = (dd?.sessions || []).length > 0 || !!dd?.activeSession;
    weekRows += `<div class="tc-day-row${isToday ? ' tc-today-row' : ''}${hasActive ? ' tc-active-row' : ''}"${hasSessions && !isToday ? ` style="cursor:pointer;" onclick="tcExpandDay('${d}')"` : ''}>
      <span class="tc-day-label">${dayLabel}${isToday ? ' <span class="tc-today-pill">Today</span>' : ''}${hasSessions && !isToday ? ' <span class="tc-expand-hint">›</span>' : ''}</span>
      <span class="tc-day-hours">${hoursStr}</span>
      <span class="tc-day-rev">${revStr}</span>
    </div>`;
  }
  const totalRevStr = totalGoal > 0
    ? `$${Number(totalAchieved).toLocaleString()} / $${Number(totalGoal).toLocaleString()}`
    : '—';

  // ── Today section (only on current week) ──
  let todaySectionHTML = '';
  if (isCurrentWeek) {
    const todayData = weeklyTimeclockData[today] || null;
    const activeSession = todayData?.activeSession || null;
    const pastSessions = todayData?.sessions || [];

    // Past sessions list
    let sessionsHTML = '';
    if (pastSessions.length > 0) {
      sessionsHTML = '<div class="tc-sessions-list">';
      pastSessions.forEach((s, idx) => {
        const inT = s.clockIn.toDate ? s.clockIn.toDate() : new Date(s.clockIn);
        const outT = s.clockOut ? (s.clockOut.toDate ? s.clockOut.toDate() : new Date(s.clockOut)) : null;
        const sTz = s.timezone || TC_TIMEZONE;
        const inStr = fmtTcTime(inT, sTz);
        const outStr = outT ? fmtTcTime(outT, sTz) : '—';
        const brkMs = (s.breaks || []).filter(b => b.end).reduce((sum, b) => {
          const bs = b.start.toDate ? b.start.toDate() : new Date(b.start);
          const be = b.end.toDate ? b.end.toDate() : new Date(b.end);
          return sum + (be - bs);
        }, 0);
        const sessMs = outT ? Math.max(0, (outT - inT) - brkMs) : 0;
        const schedNote = s.scheduledStart ? ` · sched ${s.scheduledStart}` : '';
        sessionsHTML += `<div class="tc-session-row">
          <span class="tc-session-num">Session ${idx + 1}${schedNote}</span>
          <span class="tc-session-time">${inStr} – ${outStr}</span>
          <span class="tc-session-dur">${sessMs > 0 ? fmtMs(sessMs) : ''}</span>
          <span class="tc-session-actions">
            <button class="tc-icon-btn" title="Edit" onclick="tcEditSession('${today}',${idx})">✏️</button>
            <button class="tc-icon-btn tc-icon-del" title="Delete" onclick="tcDeleteSession('${today}',${idx})">🗑️</button>
          </span>
        </div>`;
      });
      sessionsHTML += '</div>';
    }

    // Active session
    let activeHTML = '';
    if (activeSession && activeSession.clockIn) {
      const clockInTime = activeSession.clockIn.toDate ? activeSession.clockIn.toDate() : new Date(activeSession.clockIn);
      const aTz = activeSession.timezone || TC_TIMEZONE;
      const clockInStr = fmtTcTime(clockInTime, aTz);
      const onBreak = !!activeSession.onBreak;
      const compBreaks = (activeSession.breaks || []).filter(b => b.end);
      const compBreakMs = compBreaks.reduce((sum, b) => {
        const bs = b.start.toDate ? b.start.toDate() : new Date(b.start);
        const be = b.end.toDate ? b.end.toDate() : new Date(b.end);
        return sum + (be - bs);
      }, 0);
      const breakLabel = compBreaks.length
        ? `${compBreaks.length} break${compBreaks.length > 1 ? 's' : ''} (${Math.floor(compBreakMs / 60000)}m total)`
        : 'No breaks';

      let schedNote = '';
      if (activeSession.scheduledStart) {
        const [sh, sm] = activeSession.scheduledStart.split(':').map(Number);
        const inHST = new Date(clockInTime.toLocaleString('en-US', { timeZone: aTz }));
        const diffMin = Math.round(((inHST.getHours() * 60 + inHST.getMinutes()) - (sh * 60 + sm)));
        schedNote = diffMin === 0 ? ' · ✅ On time'
          : diffMin > 0 ? ` · <span class="tc-late">⚠️ ${diffMin}m late</span>`
          : ` · <span class="tc-early">🌟 ${Math.abs(diffMin)}m early</span>`;
      }

      const currentBreakStart = onBreak && activeSession.currentBreakStart
        ? (activeSession.currentBreakStart.toDate ? activeSession.currentBreakStart.toDate() : new Date(activeSession.currentBreakStart))
        : null;

      activeHTML = `
        <div class="tc-status ${onBreak ? 'tc-status-break' : 'tc-status-in'}">
          <div class="tc-status-dot ${onBreak ? 'tc-dot-yellow' : 'tc-dot-green'}"></div>
          <div>
            <div class="tc-status-label">${onBreak ? '☕ On Break' : `🟢 Session ${pastSessions.length + 1} Active`}</div>
            <div class="tc-clock-time">Since ${clockInStr}${schedNote}</div>
            <div class="tc-clock-time">${breakLabel}</div>
          </div>
          <div class="tc-elapsed-wrap">
            <div class="tc-elapsed-label">This Session</div>
            <div class="tc-elapsed-badge" id="tc-elapsed">00:00:00</div>
          </div>
        </div>
        <div class="tc-action-row">
          ${isOwnClock ? (onBreak
            ? `<button class="btn tc-break-btn tc-end-break-btn" onclick="endBreak()">▶️ End Break</button>`
            : `<button class="btn tc-break-btn" onclick="startBreak()">☕ Start Break</button>`)
            : ''}
          ${isOwnClock ? `<button class="btn btn-danger tc-btn-half" onclick="clockOut()">⏹️ Punch Out</button>` : ''}
        </div>`;
      startElapsedTimer(clockInTime, activeSession.breaks || [], currentBreakStart);
    } else if (isOwnClock) {
      activeHTML = `
        <div class="tc-fields">
          <div class="tc-field-row">
            <label class="tc-label">🕐 Scheduled Start</label>
            <input type="time" id="tc-scheduled-input" class="tc-input-time">
          </div>
        </div>
        <button class="btn btn-primary tc-btn" onclick="clockIn()">⏱️ Punch In${pastSessions.length > 0 ? ' (New Session)' : ''}</button>`;
    }

    // Revenue section (read-only for view-all)
    const goal = todayData?.revenueGoal ?? '';
    const achieved = todayData?.revenueAchieved ?? '';
    const revenueHTML = isOwnClock ? `
      <div class="tc-revenue-section">
        <div class="tc-rev-row">
          <div class="tc-field-row">
            <label class="tc-label">🎯 Daily Goal</label>
            <div class="tc-input-row"><span class="tc-dollar">$</span><input type="number" id="tc-goal-input" class="tc-input" min="0" step="100" placeholder="e.g. 2000" value="${goal}"></div>
          </div>
          <div class="tc-field-row">
            <label class="tc-label">💰 End of Day Revenue</label>
            <div class="tc-input-row"><span class="tc-dollar">$</span><input type="number" id="tc-achieved-input" class="tc-input" min="0" step="100" placeholder="0" value="${achieved}"></div>
          </div>
        </div>
        <button class="btn btn-outline tc-btn-sm" onclick="tcSaveRevenue()">💾 Save Revenue</button>
      </div>` : (goal || achieved ? `
      <div class="tc-revenue-section" style="opacity:0.7;">
        <div style="font-size:0.78rem;color:#6b7280;">Revenue: $${Number(achieved||0).toLocaleString()} / $${Number(goal||0).toLocaleString()}</div>
      </div>` : '');

    todaySectionHTML = `
      <div class="tc-today-section">
        <div class="tc-today-title">📅 Today — ${today}</div>
        ${sessionsHTML}
        ${activeHTML}
        ${revenueHTML}
      </div>`;
  }

  const selectorHTML = (currentUserCanViewAllTimeclocks && tcEmployees.length > 0) ? `
    <div class="tc-user-selector-row">
      <label class="tc-label" style="font-size:0.78rem;white-space:nowrap;">👥 Viewing:</label>
      <select class="tc-user-select" onchange="tcSwitchUser(this.value)">
        <option value="${currentUser.uid}"${isOwnClock ? ' selected' : ''}>My Timeclock</option>
        ${tcEmployees.filter(e => e.uid !== currentUser.uid).map(e =>
          `<option value="${e.uid}"${tcViewingUid === e.uid ? ' selected' : ''}>${escapeHtml(e.name)}</option>`
        ).join('')}
      </select>
    </div>` : '';

  const viewingBanner = !isOwnClock ? `
    <div class="tc-viewing-banner">👁️ Viewing: ${escapeHtml(tcEmployees.find(e => e.uid === tcViewingUid)?.name || 'Employee')}</div>` : '';

  content.innerHTML = `
    ${selectorHTML}
    ${viewingBanner}
    <div class="tc-week-nav">
      <button class="tc-nav-btn" onclick="tcPrevWeek()">‹ Prev</button>
      <span class="tc-week-label">${weekLabel}</span>
      <button class="tc-nav-btn" onclick="tcNextWeek()"${isCurrentWeek ? ' disabled style="opacity:.4;cursor:default;"' : ''}>Next ›</button>
    </div>
    <div class="tc-week-grid">
      <div class="tc-week-header"><span>Day</span><span>Hours</span><span>Revenue</span></div>
      ${weekRows}
      <div class="tc-week-total">
        <span>Week Total</span>
        <span>${totalWeekMs > 0 ? fmtMs(totalWeekMs) : '—'}</span>
        <span>${totalRevStr}</span>
      </div>
    </div>
    ${todaySectionHTML}
  `;
}


window.clockIn = async function() {
  if (!currentUser) return;
  const today = todayDateString();
  const docId = currentUser.uid + '_' + today;
  const scheduledInput = $('tc-scheduled-input');
  const scheduledStart = scheduledInput ? scheduledInput.value : '';
  const newSession = {
    scheduledStart: scheduledStart || null,
    clockIn: firebase.firestore.FieldValue.serverTimestamp(),
    clockOut: null,
    breaks: [],
    onBreak: false,
    currentBreakStart: null,
    timezone: TC_TIMEZONE
  };
  try {
    const snap = await db.collection('timeclock').doc(docId).get();
    if (snap.exists) {
      await db.collection('timeclock').doc(docId).update({ activeSession: newSession });
    } else {
      await db.collection('timeclock').doc(docId).set({
        uid: currentUser.uid,
        email: currentUser.email,
        date: today,
        sessions: [],
        activeSession: newSession,
        revenueGoal: 0,
        revenueAchieved: null
      });
    }
    toast('Punched in! ⏱️', 'success');
    await loadWeekData(0);
  } catch (e) {
    console.error('Clock in error:', e);
    toast('Failed to punch in.', 'error');
  }
};

window.startBreak = async function() {
  if (!currentUser) return;
  const today = todayDateString();
  const docId = currentUser.uid + '_' + today;
  try {
    await db.collection('timeclock').doc(docId).update({
      'activeSession.onBreak': true,
      'activeSession.currentBreakStart': firebase.firestore.FieldValue.serverTimestamp()
    });
    toast('Break started ☕', 'info');
    await loadWeekData(0);
  } catch (e) {
    console.error('Start break error:', e);
    toast('Failed to start break.', 'error');
  }
};

window.endBreak = async function() {
  if (!currentUser) return;
  const today = todayDateString();
  const docId = currentUser.uid + '_' + today;
  const snap = await db.collection('timeclock').doc(docId).get();
  if (!snap.exists) return;
  const active = snap.data().activeSession || {};
  const breaks = active.breaks || [];
  if (active.currentBreakStart) {
    breaks.push({ start: active.currentBreakStart, end: firebase.firestore.Timestamp.now() });
  }
  try {
    await db.collection('timeclock').doc(docId).update({
      'activeSession.onBreak': false,
      'activeSession.currentBreakStart': null,
      'activeSession.breaks': breaks
    });
    toast('Break ended ▶️', 'success');
    await loadWeekData(0);
  } catch (e) {
    console.error('End break error:', e);
    toast('Failed to end break.', 'error');
  }
};

window.clockOut = async function() {
  if (!currentUser) return;
  const today = todayDateString();
  const docId = currentUser.uid + '_' + today;
  const snap = await db.collection('timeclock').doc(docId).get();
  if (!snap.exists) return;
  const d = snap.data();
  const active = d.activeSession;
  if (!active || !active.clockIn) return;
  const breaks = active.breaks || [];
  if (active.onBreak && active.currentBreakStart) {
    breaks.push({ start: active.currentBreakStart, end: firebase.firestore.Timestamp.now() });
  }
  const completed = {
    scheduledStart: active.scheduledStart || null,
    clockIn: active.clockIn,
    clockOut: firebase.firestore.Timestamp.now(),
    breaks
  };
  const sessions = d.sessions || [];
  sessions.push(completed);
  try {
    await db.collection('timeclock').doc(docId).update({ sessions, activeSession: null });
    if (elapsedInterval) { clearInterval(elapsedInterval); elapsedInterval = null; }
    toast('Punched out! ✅', 'success');
    await loadWeekData(0);
  } catch (e) {
    console.error('Clock out error:', e);
    toast('Failed to punch out.', 'error');
  }
};

window.tcSaveRevenue = async function() {
  if (!currentUser) return;
  const today = todayDateString();
  const docId = currentUser.uid + '_' + today;
  const goalStr = $('tc-goal-input')?.value;
  const achStr = $('tc-achieved-input')?.value;
  const goal = goalStr !== '' && goalStr != null ? parseFloat(goalStr) : null;
  const achieved = achStr !== '' && achStr != null ? parseFloat(achStr) : null;
  try {
    const snap = await db.collection('timeclock').doc(docId).get();
    if (snap.exists) {
      await db.collection('timeclock').doc(docId).update({ revenueGoal: goal, revenueAchieved: achieved });
    } else {
      await db.collection('timeclock').doc(docId).set({
        uid: currentUser.uid, email: currentUser.email, date: today,
        sessions: [], activeSession: null, revenueGoal: goal, revenueAchieved: achieved
      });
    }
    toast('Revenue saved! 💰', 'success');
    await loadWeekData(currentWeekOffset);
  } catch (e) {
    console.error('Save revenue error:', e);
    toast('Failed to save revenue.', 'error');
  }
};

window.tcPrevWeek = async function() { await loadWeekData(currentWeekOffset - 1); };
window.tcNextWeek = async function() { if (currentWeekOffset < 0) await loadWeekData(currentWeekOffset + 1); };

window.tcSwitchUser = async function(uid) {
  tcViewingUid = uid;
  await loadWeekData(0);
};

// ── Expand past day into modal ──
window.tcExpandDay = function(date) {
  const dd = weeklyTimeclockData[date];
  if (!dd) return;
  const sessions = dd.sessions || [];
  if (!sessions.length) return;
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const [, mo, dy] = date.split('-');
  const dateLabel = `${MONTHS[+mo - 1]} ${+dy}`;
  const isOwnClockExpand = !tcViewingUid || tcViewingUid === currentUser.uid;
  const rows = sessions.map((s, idx) => {
    const inT = s.clockIn.toDate ? s.clockIn.toDate() : new Date(s.clockIn);
    const outT = s.clockOut ? (s.clockOut.toDate ? s.clockOut.toDate() : new Date(s.clockOut)) : null;
    const sTz = s.timezone || TC_TIMEZONE;
    const inStr = fmtTcTime(inT, sTz);
    const outStr = outT ? fmtTcTime(outT, sTz) : '—';
    const brkMs = (s.breaks || []).filter(b => b.end).reduce((sum, b) => {
      const bs = b.start.toDate ? b.start.toDate() : new Date(b.start);
      const be = b.end.toDate ? b.end.toDate() : new Date(b.end);
      return sum + (be - bs);
    }, 0);
    const sessMs = outT ? Math.max(0, (outT - inT) - brkMs) : 0;
    return `<div class="tc-session-row">
      <span class="tc-session-num">Session ${idx + 1}</span>
      <span class="tc-session-time">${inStr} – ${outStr}</span>
      <span class="tc-session-dur">${sessMs > 0 ? fmtMs(sessMs) : ''}</span>
      <span class="tc-session-actions">
        ${isOwnClockExpand ? `
        <button class="tc-icon-btn" title="Edit" onclick="tcEditSession('${date}',${idx})">✏️</button>
        <button class="tc-icon-btn tc-icon-del" title="Delete" onclick="tcDeleteSession('${date}',${idx})">🗑️</button>
        ` : ''}
      </span>
    </div>`;
  }).join('');
  const goalVal = dd.revenueGoal || '';
  const achVal = dd.revenueAchieved != null ? dd.revenueAchieved : '';
  let overlay = $('tc-day-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'tc-day-overlay';
    overlay.className = 'modal-overlay';
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = `
    <div class="modal-box" style="max-width:480px;">
      <div class="modal-header">
        <h3>📅 ${dateLabel} Sessions</h3>
        <button class="modal-close" onclick="$('tc-day-overlay').style.display='none'">&times;</button>
      </div>
      <div class="modal-body">
        <div class="tc-sessions-list">${rows}</div>
        <div style="border-top:1px solid #e5e7eb;margin-top:12px;padding-top:12px;display:flex;flex-direction:column;gap:10px;">
          <div class="tc-rev-row">
            <div class="tc-field-row">
              <label class="tc-label">🎯 Daily Goal</label>
              <div class="tc-input-row"><span class="tc-dollar">$</span><input type="number" id="tcd-goal-input" class="tc-input" min="0" step="100" value="${goalVal}"></div>
            </div>
            <div class="tc-field-row">
              <label class="tc-label">💰 Revenue Achieved</label>
              <div class="tc-input-row"><span class="tc-dollar">$</span><input type="number" id="tcd-achieved-input" class="tc-input" min="0" step="100" value="${achVal}"></div>
            </div>
          </div>
          <button class="btn btn-outline tc-btn-sm" onclick="tcSaveRevenueForDate('${date}')">💾 Save Revenue</button>
        </div>
      </div>
    </div>`;
  overlay.style.display = 'flex';
};

window.tcSaveRevenueForDate = async function(date) {
  if (!currentUser) return;
  const docId = currentUser.uid + '_' + date;
  const goalStr = $('tcd-goal-input')?.value;
  const achStr = $('tcd-achieved-input')?.value;
  const goal = goalStr !== '' && goalStr != null ? parseFloat(goalStr) : null;
  const achieved = achStr !== '' && achStr != null ? parseFloat(achStr) : null;
  try {
    await db.collection('timeclock').doc(docId).update({ revenueGoal: goal, revenueAchieved: achieved });
    toast('Revenue saved! 💰', 'success');
    $('tc-day-overlay').style.display = 'none';
    await loadWeekData(currentWeekOffset);
  } catch (e) {
    toast('Failed to save.', 'error');
  }
};

window.tcDeleteSession = async function(date, idx) {
  const ok = await confirm('Delete Session', 'Remove this session permanently? This cannot be undone.');
  if (!ok) return;
  if (!currentUser) return;
  const docId = currentUser.uid + '_' + date;
  try {
    const snap = await db.collection('timeclock').doc(docId).get();
    if (!snap.exists) return;
    const sessions = snap.data().sessions || [];
    sessions.splice(idx, 1);
    await db.collection('timeclock').doc(docId).update({ sessions });
    toast('Session deleted.', 'info');
    await loadWeekData(currentWeekOffset);
    const overlay = $('tc-day-overlay');
    if (overlay && overlay.style.display !== 'none') window.tcExpandDay(date);
  } catch (e) {
    console.error('Delete session error:', e);
    toast('Failed to delete.', 'error');
  }
};

window.tcEditSession = function(date, idx) {
  const dd = weeklyTimeclockData[date];
  if (!dd) return;
  const s = (dd.sessions || [])[idx];
  if (!s) return;
  const inT = s.clockIn.toDate ? s.clockIn.toDate() : new Date(s.clockIn);
  const outT = s.clockOut ? (s.clockOut.toDate ? s.clockOut.toDate() : new Date(s.clockOut)) : null;
  function toHHMM(d) {
    const sTz = s.timezone || TC_TIMEZONE;
    return d.toLocaleTimeString('en-US', { timeZone: sTz, hour: '2-digit', minute: '2-digit', hour12: false }).replace(/^24:/, '00:');
  }
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const [, mo, dy] = date.split('-');
  const dateLabel = `${MONTHS[+mo - 1]} ${+dy}`;
  let overlay = $('tc-edit-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'tc-edit-overlay';
    overlay.className = 'modal-overlay';
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = `
    <div class="modal-box" style="max-width:380px;">
      <div class="modal-header">
        <h3>✏️ Edit Session — ${dateLabel}</h3>
        <button class="modal-close" onclick="$('tc-edit-overlay').style.display='none'">&times;</button>
      </div>
      <div class="modal-body">
        <div class="tc-fields">
          <div class="tc-field-row">
            <label class="tc-label">🕐 Scheduled Start</label>
            <input type="time" id="tce-sched" class="tc-input-time" value="${s.scheduledStart || ''}">
          </div>
          <div class="tc-field-row">
            <label class="tc-label">⏱️ Punch In</label>
            <input type="time" id="tce-in" class="tc-input-time" value="${toHHMM(inT)}" required>
          </div>
          <div class="tc-field-row">
            <label class="tc-label">⏹️ Punch Out</label>
            <input type="time" id="tce-out" class="tc-input-time" value="${outT ? toHHMM(outT) : ''}">
          </div>
        </div>
        <div style="margin-top:16px;display:flex;gap:8px;">
          <button class="btn btn-primary" style="flex:1;" onclick="tcSaveEditSession('${date}',${idx})">💾 Save Changes</button>
          <button class="btn btn-outline" style="flex:1;" onclick="$('tc-edit-overlay').style.display='none'">Cancel</button>
        </div>
      </div>
    </div>`;
  overlay.style.display = 'flex';
};

window.tcSaveEditSession = async function(date, idx) {
  if (!currentUser) return;
  const inVal = $('tce-in')?.value;
  const outVal = $('tce-out')?.value;
  const schedVal = $('tce-sched')?.value || null;
  if (!inVal) { toast('Punch In time is required.', 'error'); return; }
  // Convert HH:MM in user's local timezone to Firestore Timestamp
  function toTimestamp(dateStr, timeStr) {
    if (!timeStr) return null;
    // new Date('YYYY-MM-DDTHH:MM:00') parses as local browser time → correct for any TZ
    return firebase.firestore.Timestamp.fromMillis(new Date(dateStr + 'T' + timeStr + ':00').getTime());
  }
  const clockIn = toTimestamp(date, inVal);
  const clockOut = outVal ? toTimestamp(date, outVal) : null;
  if (clockOut && clockOut.toMillis() <= clockIn.toMillis()) {
    toast('Punch Out must be after Punch In.', 'error'); return;
  }
  const docId = currentUser.uid + '_' + date;
  try {
    const snap = await db.collection('timeclock').doc(docId).get();
    if (!snap.exists) return;
    const sessions = snap.data().sessions || [];
    sessions[idx] = { ...sessions[idx], clockIn, clockOut, scheduledStart: schedVal };
    await db.collection('timeclock').doc(docId).update({ sessions });
    toast('Session updated! ✅', 'success');
    $('tc-edit-overlay').style.display = 'none';
    await loadWeekData(currentWeekOffset);
    const dayOverlay = $('tc-day-overlay');
    if (dayOverlay && dayOverlay.style.display !== 'none') window.tcExpandDay(date);
  } catch (e) {
    console.error('Edit session error:', e);
    toast('Failed to save.', 'error');
  }
};



function startElapsedTimer(clockInTime, breaks, currentBreakStart) {
  if (elapsedInterval) clearInterval(elapsedInterval);
  const completedBreakMs = (breaks || []).filter(b => b.end).reduce((sum, b) => {
    const s = b.start.toDate ? b.start.toDate() : new Date(b.start);
    const e = b.end.toDate ? b.end.toDate() : new Date(b.end);
    return sum + (e - s);
  }, 0);
  function update() {
    const el = $('tc-elapsed');
    if (!el) { clearInterval(elapsedInterval); elapsedInterval = null; return; }
    const now = Date.now();
    let breakDeduct = completedBreakMs;
    if (currentBreakStart) breakDeduct += now - currentBreakStart.getTime();
    const net = Math.max(0, (now - clockInTime.getTime()) - breakDeduct);
    const h = Math.floor(net / 3600000);
    const m = Math.floor((net % 3600000) / 60000);
    const s = Math.floor((net % 60000) / 1000);
    el.textContent = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }
  update();
  elapsedInterval = setInterval(update, 1000);
}

// ================================================================
// EXPENSE TRACKER
// ================================================================
const EXPENSE_CATEGORIES = ['Venmo Payment', 'Vendor Payment', 'Fuel', 'Supplies', 'Maintenance', 'Insurance', 'Registration', 'Cleaning', 'Other'];

function _finMonthRange(monthInputId) {
  const raw = $(monthInputId)?.value;
  const [y, m] = raw ? raw.split('-').map(Number) : todayDateString().split('-').map(Number).slice(0,2);
  const start = `${y}-${String(m).padStart(2,'0')}-01`;
  const end = `${y}-${String(m).padStart(2,'0')}-${String(new Date(y, m, 0).getDate()).padStart(2,'0')}`;
  return { y, m, start, end, label: new Date(y, m-1, 1).toLocaleDateString('en-US', { month:'long', year:'numeric' }) };
}

function _todayMonthVal() {
  const [y, m] = todayDateString().split('-');
  return y + '-' + m;
}

async function loadExpenseWidget() {
  const overlay = $('finance-overlay');
  if (!overlay) return;
  if (currentUserRole !== 'admin' && currentUserRole !== 'manager') return;

  const dateInput = $('exp-date');
  if (dateInput && !dateInput.value) dateInput.value = todayDateString();

  // Set default month filter to current month
  const filterEl = $('exp-month-filter');
  if (filterEl && !filterEl.value) filterEl.value = _todayMonthVal();

  const { start: monthStart, end: monthEnd } = _finMonthRange('exp-month-filter');

  const list = $('expense-list');
  const totalEl = $('expense-month-total');
  if (!list) return;
  list.innerHTML = '<p class="hint">Loading...</p>';

  try {
    const snap = await db.collection('expenses')
      .where('date', '>=', monthStart)
      .where('date', '<=', monthEnd)
      .orderBy('date', 'desc')
      .get();

    const expenses = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    const monthTotal = expenses.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);

    if (totalEl) totalEl.textContent = `$${monthTotal.toFixed(2)}`;

    if (expenses.length === 0) {
      list.innerHTML = '<p class="hint">No expenses this period.</p>';
      return;
    }

    list.innerHTML = expenses.map(e => {
      const catCls = 'exp-cat-' + (e.category || 'other').toLowerCase().replace(/\s+/g, '-');
      const canDelete = currentUserRole === 'admin' || e.submittedBy === currentUser.uid;
      const vehicleTag = e.vehiclePlate ? `<span class="exp-vehicle-tag">${escapeHtml(e.vehiclePlate)}</span>` : '';
      return `
        <div class="exp-row">
          <div class="exp-row-left">
            <span class="exp-cat-badge ${catCls}">${escapeHtml(e.category || 'Other')}</span>
            <div class="exp-row-info">
              <span class="exp-desc">${vehicleTag}${escapeHtml(e.description || '')}</span>
              <span class="exp-meta">${e.date} · ${escapeHtml(e.submittedByName || '')}</span>
            </div>
          </div>
          <div class="exp-row-right">
            <span class="exp-amount">$${parseFloat(e.amount || 0).toFixed(2)}</span>
            ${canDelete ? `<button class="btn btn-sm btn-danger exp-del-btn" onclick="deleteExpense('${e.id}')">✕</button>` : ''}
          </div>
        </div>`;
    }).join('');
  } catch (err) {
    console.error('loadExpenseWidget error:', err);
    list.innerHTML = '<p class="hint">Failed to load expenses.</p>';
  }
}

function populateExpenseVehicleDropdown() {
  const sel = $('exp-vehicle');
  if (!sel) return;
  sel.innerHTML = '<option value="">Fleet / General</option>';
  (vehiclesCache || []).slice().sort((a,b) => (a.plate||'').localeCompare(b.plate||'')).forEach(v => {
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = v.plate + (v.make && v.model ? ' – ' + v.make + ' ' + v.model : '');
    sel.appendChild(opt);
  });
}

window.saveExpense = async function() {
  const date = $('exp-date').value || todayDateString();
  const amount = parseFloat($('exp-amount').value);
  const category = $('exp-category').value;
  const description = $('exp-desc-input').value.trim();
  const vehicleId = $('exp-vehicle')?.value || '';
  const vehicleObj = vehicleId ? vehiclesCache.find(v => v.id === vehicleId) : null;

  if (!amount || amount <= 0) { toast('Enter a valid amount.', 'warning'); return; }
  if (!description) { toast('Enter a description.', 'warning'); return; }

  const btn = $('exp-save-btn');
  btn.disabled = true;
  btn.textContent = 'Saving...';
  try {
    const record = {
      date, amount, category, description,
      submittedBy: currentUser.uid,
      submittedByName: currentUser.displayName || currentUser.email,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    };
    if (vehicleId) { record.vehicleId = vehicleId; record.vehiclePlate = vehicleObj?.plate || ''; }
    await db.collection('expenses').add(record);
    $('exp-amount').value = '';
    $('exp-desc-input').value = '';
    $('exp-date').value = todayDateString();
    if ($('exp-vehicle')) $('exp-vehicle').value = '';
    toast('Expense saved!', 'success');
    loadExpenseWidget();
  } catch (err) {
    console.error('saveExpense error:', err);
    toast('Failed to save expense.', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save';
  }
};

window.deleteExpense = async function(docId) {
  if (currentUserRole !== 'admin') {
    if (!(await confirm('Delete Expense', 'Delete this expense?'))) return;
  }
  try {
    await db.collection('expenses').doc(docId).delete();
    toast('Expense deleted.', 'success');
    loadExpenseWidget();
  } catch (err) {
    console.error('deleteExpense error:', err);
    toast('Failed to delete.', 'error');
  }
};

// ================================================================
// FINANCE TABS
// ================================================================
window.switchFinanceTab = function(tab) {
  ['overview','revenue','expenses','pl'].forEach(t => {
    const btn = $('ftab-' + t);
    const content = $('finance-tab-' + t);
    if (btn) btn.classList.toggle('active', t === tab);
    if (content) content.style.display = t === tab ? '' : 'none';
  });
  if (tab === 'overview') loadFinanceOverview();
  if (tab === 'revenue') { const el = $('fin-rev-month'); if (el && !el.value) el.value = _todayMonthVal(); loadFinanceRevenue(); }
  if (tab === 'expenses') loadExpenseWidget();
  if (tab === 'pl') { const el = $('fin-pl-month'); if (el && !el.value) el.value = _todayMonthVal(); loadFinancePL(); }
};

async function loadFinanceOverview() {
  const body = $('finance-overview-body');
  if (!body) return;
  body.innerHTML = '<p class="hint" style="padding:24px;text-align:center;">Loading…</p>';
  const { start: monthStart, end: monthEnd, label: monthName } = _finMonthRange('fin-rev-month');
  try {
    let revSnap = { forEach: () => {} };
    try { revSnap = await db.collection('tripLogs').where('startDate','>=',monthStart).where('startDate','<=',monthEnd).get(); } catch(e) {}
    let turoRev = 0, privRev = 0;
    revSnap.forEach(doc => {
      const d = doc.data();
      if (d.cancelled) return;
      const rev = Number(d.revenue) || 0;
      if (d.tripType === 'private-trip') privRev += rev; else turoRev += rev;
    });
    const totalRev = turoRev + privRev;

    const expSnap = await db.collection('expenses').where('date','>=',monthStart).where('date','<=',monthEnd).get();
    const totalExp = expSnap.docs.reduce((s,d) => s + (Number(d.data().amount)||0), 0);

    const maintSnap = await db.collection('maintenance').where('date','>=',monthStart).where('date','<=',monthEnd).get();
    const totalMaint = maintSnap.docs.reduce((s,d) => s + (Number(d.data().cost)||0), 0);

    const totalCosts = totalExp + totalMaint;
    const netPL = totalRev - totalCosts;
    const fmtD = n => '$' + n.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});

    body.innerHTML = `
      <div class="fin-overview-month">${monthName}</div>
      <div class="fin-overview-cards">
        <div class="fin-card fin-card-revenue fin-card-clickable" onclick="switchFinanceTab('revenue')" title="View revenue details">
          <div class="fin-card-label">💰 Revenue</div>
          <div class="fin-card-amount">${fmtD(totalRev)}</div>
          <div class="fin-card-sub">📅 Turo ${fmtD(turoRev)} · 🔒 Private ${fmtD(privRev)}</div>
        </div>
        <div class="fin-card fin-card-expense fin-card-clickable" onclick="switchFinanceTab('expenses')" title="View expense details">
          <div class="fin-card-label">🧾 Expenses</div>
          <div class="fin-card-amount">${fmtD(totalCosts)}</div>
          <div class="fin-card-sub">General ${fmtD(totalExp)} · Maintenance ${fmtD(totalMaint)}</div>
        </div>
        <div class="fin-card ${netPL >= 0 ? 'fin-card-profit' : 'fin-card-loss'} fin-card-clickable" onclick="switchFinanceTab('pl')" title="View P&amp;L by vehicle">
          <div class="fin-card-label">📈 Net P&amp;L</div>
          <div class="fin-card-amount">${netPL >= 0 ? '+' : ''}${fmtD(netPL)}</div>
          <div class="fin-card-sub">${netPL >= 0 ? 'Profitable ✅' : 'Operating at a loss ⚠️'}</div>
        </div>
      </div>
      <div class="fin-overview-actions">
        <button class="btn btn-sm btn-outline" onclick="switchFinanceTab('revenue')">Revenue Details →</button>
        <button class="btn btn-sm btn-outline" onclick="switchFinanceTab('expenses')">Expenses →</button>
        <button class="btn btn-sm btn-outline" onclick="switchFinanceTab('pl')">P&amp;L by Vehicle →</button>
      </div>
      <p class="hint" style="font-size:0.78rem;margin-top:12px;">💡 Revenue is pulled from Trip Logs. Add revenue to trips via the 📊 Productivity button → 📋 Trips.</p>
    `;
  } catch(e) {
    console.error('Finance overview error:', e);
    body.innerHTML = '<p class="hint" style="color:#ef4444;padding:16px;">Failed to load overview.</p>';
  }
}

window.toggleFinRevForm = function() {
  const form = $('fin-rev-add-form');
  if (!form) return;
  const isOpen = form.style.display !== 'none';
  form.style.display = isOpen ? 'none' : '';
  if (!isOpen) {
    // Populate vehicle dropdown
    const sel = $('fin-rev-vehicle');
    if (sel) {
      sel.innerHTML = '<option value="">-- Select Vehicle --</option>';
      (vehiclesCache || []).slice().sort((a,b) => (a.plate||'').localeCompare(b.plate||'')).forEach(v => {
        const opt = document.createElement('option');
        opt.value = v.id;
        opt.dataset.plate = v.plate || '';
        opt.dataset.model = ((v.make||'') + ' ' + (v.model||'')).trim();
        opt.textContent = v.plate + (v.make && v.model ? ' – ' + v.make + ' ' + v.model : '');
        sel.appendChild(opt);
      });
    }
    // Default date to today within selected month
    const dateEl = $('fin-rev-date');
    if (dateEl && !dateEl.value) {
      const { start, end } = _finMonthRange('fin-rev-month');
      const today = todayDateString();
      dateEl.value = today >= start && today <= end ? today : start;
    }
    setTimeout(() => { const s = $('fin-rev-vehicle'); if (s) s.focus(); }, 60);
  }
};

window.saveFinanceRevenue = async function() {
  const vehicleSel = $('fin-rev-vehicle');
  const vehicleId = vehicleSel?.value;
  const vehiclePlate = vehicleSel?.selectedOptions[0]?.dataset.plate || '';
  const vehicleModel = vehicleSel?.selectedOptions[0]?.dataset.model || '';
  const tripType = $('fin-rev-type').value;
  const date = $('fin-rev-date').value;
  const amount = parseFloat($('fin-rev-amount').value);
  const note = $('fin-rev-note')?.value.trim() || '';
  const extrasType = $('fin-rev-extras-type')?.value || '';
  const extrasAmount = parseFloat($('fin-rev-extras-amount')?.value) || 0;

  if (!vehicleId) { toast('Select a vehicle.', 'warning'); return; }
  if (!date) { toast('Enter a date.', 'warning'); return; }
  if ((!amount || amount <= 0) && (!extrasType || extrasAmount <= 0)) {
    toast('Enter an amount or an extras amount.', 'warning'); return;
  }

  const btn = $('fin-rev-save-btn');
  btn.disabled = true; btn.textContent = 'Saving…';

  try {
    const logKey = vehicleId + '_' + date + '_manrev_' + Date.now();
    const record = {
      vehicleId,
      vehiclePlate,
      vehicleMakeModel: vehicleModel,
      startDate: date,
      endDate: date,
      tripType,
      revenue: amount > 0 ? amount : 0,
      manualRevenueEntry: true,
      loggedAt: firebase.firestore.FieldValue.serverTimestamp(),
      loggedBy: currentUser.uid,
      loggedByName: currentUser.displayName || currentUser.email,
    };
    if (note) record.notes = note;
    if (extrasType && extrasAmount > 0) {
      record.extras = [{ type: extrasType, amount: extrasAmount }];
    }
    await db.collection('tripLogs').doc(logKey).set(record);
    toast('Revenue added!', 'success');
    // Reset form fields
    $('fin-rev-amount').value = '';
    $('fin-rev-note').value = '';
    $('fin-rev-vehicle').value = '';
    if ($('fin-rev-extras-type')) $('fin-rev-extras-type').value = '';
    if ($('fin-rev-extras-amount')) $('fin-rev-extras-amount').value = '';
    toggleFinRevForm();
    loadFinanceRevenue();
  } catch(e) {
    console.error('saveFinanceRevenue error:', e);
    toast('Failed to save revenue.', 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Save';
  }
};

window.deleteManualRevenue = async function(docId) {
  if (!(await confirm('Delete Entry', 'Delete this manual revenue entry?'))) return;
  try {
    await db.collection('tripLogs').doc(docId).delete();
    toast('Revenue entry deleted.', 'success');
    loadFinanceRevenue();
  } catch(e) {
    toast('Failed to delete.', 'error');
  }
};

window.loadFinanceRevenue = async function() {
  const body = $('finance-revenue-body');
  if (!body) return;
  body.innerHTML = '<p class="hint" style="padding:16px;text-align:center;">Loading…</p>';
  const { start, end, label } = _finMonthRange('fin-rev-month');
  try {
    let snap = { forEach: () => {} };
    try { snap = await db.collection('tripLogs').where('startDate','>=',start).where('startDate','<=',end).get(); } catch(e) {}
    const byVehicle = {};
    const manualEntries = []; // track for delete buttons
    snap.forEach(doc => {
      const d = doc.data();
      if (d.cancelled) return;
      if (!byVehicle[d.vehicleId]) byVehicle[d.vehicleId] = { plate: d.vehiclePlate, makeModel: d.vehicleMakeModel, turo: 0, priv: 0, extrasByType: {}, trips: 0, untracked: 0, manual: 0 };
      const rev = Number(d.revenue) || 0;
      if (d.tripType === 'private-trip') byVehicle[d.vehicleId].priv += rev;
      else byVehicle[d.vehicleId].turo += rev;
      // Handle both new array format and legacy extrasType/extrasAmount
      const extrasArr = Array.isArray(d.extras) ? d.extras
        : (d.extrasType && d.extrasAmount ? [{ type: d.extrasType, amount: Number(d.extrasAmount) }] : []);
      extrasArr.forEach(e => {
        const t = e.type || 'other';
        const a = Number(e.amount) || 0;
        if (a > 0) byVehicle[d.vehicleId].extrasByType[t] = (byVehicle[d.vehicleId].extrasByType[t] || 0) + a;
      });
      if (!rev) byVehicle[d.vehicleId].untracked++;
      if (d.manualRevenueEntry) byVehicle[d.vehicleId].manual++;
      byVehicle[d.vehicleId].trips++;
      if (d.manualRevenueEntry) manualEntries.push({ id: doc.id, ...d });
    });
    const rows = Object.values(byVehicle).sort((a,b) => (b.turo+b.priv) - (a.turo+a.priv));
    if (!rows.length) {
      body.innerHTML = '<p class="hint" style="padding:24px;text-align:center;">No trips or revenue found for this period. Use <strong>➕ Add Revenue</strong> above to log a payout.</p>';
      return;
    }
    const fmtR = n => n > 0 ? '$' + n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) : '—';
    const totalTuro = rows.reduce((s,r) => s+r.turo, 0);
    const totalPriv = rows.reduce((s,r) => s+r.priv, 0);

    const extraLabels = { 'beach-gear':'🏖️ Beach Gear', 'parking':'🅿️ Parking', 'snorkeling-gear':'🤿 Snorkeling Gear', 'beach-tent':'⛺ Beach Tent', 'car-seat':'🪱 Car Seat', 'other':'✏️ Other' };

    // Aggregate extras by type across all rows
    const totalExtrasByType = {};
    rows.forEach(r => {
      Object.entries(r.extrasByType).forEach(([t, a]) => {
        totalExtrasByType[t] = (totalExtrasByType[t] || 0) + a;
      });
    });
    const totalExtras = Object.values(totalExtrasByType).reduce((s,a) => s+a, 0);
    const extrasBadges = Object.entries(totalExtrasByType).map(([t, a]) =>
      `<span class="prod-rev-badge extras">${extraLabels[t]||t}: <strong>$${a.toFixed(2)}</strong></span>`
    ).join('');

    // Manual entries section (deleteable)
    const manualHtml = manualEntries.length ? `
      <div class="fin-manual-entries">
        <div class="fin-manual-entries-title">📝 Manual Revenue Entries</div>
        ${manualEntries.sort((a,b) => a.startDate.localeCompare(b.startDate)).map(e => `
          <div class="fin-manual-row">
            <div>
              <span class="fin-manual-plate">${escapeHtml(e.vehiclePlate||'')}</span>
              <span class="fin-manual-type">${e.tripType === 'private-trip' ? '🔒 Private' : '📅 Turo'}</span>
              <span class="fin-manual-date">${e.startDate}</span>
              ${e.notes ? `<span class="fin-manual-note">${escapeHtml(e.notes)}</span>` : ''}
              ${(() => { const ea = Array.isArray(e.extras) ? e.extras : (e.extrasType && e.extrasAmount ? [{type:e.extrasType,amount:e.extrasAmount}] : []); return ea.map(ex => `<span class="fin-manual-extras">${extraLabels[ex.type]||ex.type}: $${Number(ex.amount||0).toFixed(2)}</span>`).join(''); })()}
            </div>
            <div class="fin-manual-right">
              <span class="fin-manual-amount">$${(Number(e.revenue||0) + (Array.isArray(e.extras) ? e.extras.reduce((s,ex)=>s+Number(ex.amount||0),0) : Number(e.extrasAmount||0))).toFixed(2)}</span>
              <button class="btn btn-xs btn-danger" onclick="deleteManualRevenue('${e.id}')">✕</button>
            </div>
          </div>`).join('')}
      </div>` : '';

    body.innerHTML = `
      <div class="fin-rev-totals">
        <span class="prod-rev-badge turo">📅 Turo: <strong>$${totalTuro.toFixed(2)}</strong></span>
        <span class="prod-rev-badge private">🔒 Private: <strong>$${totalPriv.toFixed(2)}</strong></span>
        ${extrasBadges}
        <span class="prod-rev-badge total">Total: <strong>$${(totalTuro+totalPriv+totalExtras).toFixed(2)}</strong></span>
      </div>
      <table class="fin-table">
        <thead><tr><th>Vehicle</th><th>Trips</th><th>Turo $</th><th>Private $</th><th>Extras $</th><th>Total</th></tr></thead>
        <tbody>
          ${rows.map(r => `<tr>
            <td><strong>${escapeHtml(r.plate||'')}</strong><br><span style="font-size:0.78rem;color:#6b7280;">${escapeHtml(r.makeModel||'')}</span></td>
            <td>${r.trips}${r.untracked ? `<span style="font-size:0.72rem;color:#f59e0b;margin-left:4px;">(${r.untracked} no $)</span>` : ''}${r.manual ? `<span style="font-size:0.72rem;color:#6b7280;margin-left:4px;">(${r.manual} manual)</span>` : ''}</td>
            <td class="fin-td-rev">${fmtR(r.turo)}</td>
            <td class="fin-td-rev">${fmtR(r.priv)}</td>
            <td class="fin-td-extras">${Object.entries(r.extrasByType).length > 0 ? Object.entries(r.extrasByType).map(([t,a]) => `<span style="display:block;font-size:0.78rem;">${extraLabels[t]||t}: $${a.toFixed(2)}</span>`).join('') : '—'}</td>
            <td><strong>${fmtR(r.turo+r.priv+Object.values(r.extrasByType).reduce((s,a)=>s+a,0))}</strong></td>
          </tr>`).join('')}
        </tbody>
      </table>
      ${manualHtml}
      <p class="hint" style="font-size:0.78rem;margin-top:8px;">Trips showing "no $" have no revenue yet. Add via ➕ above or 📊 Productivity → 📋 Trips.</p>
    `;
  } catch(e) {
    console.error('Finance revenue error:', e);
    body.innerHTML = '<p class="hint" style="color:#ef4444;padding:16px;">Failed to load revenue.</p>';
  }
};

window.loadFinancePL = async function() {
  const body = $('finance-pl-body');
  if (!body) return;
  body.innerHTML = '<p class="hint" style="padding:16px;text-align:center;">Loading…</p>';
  const { start, end, label } = _finMonthRange('fin-pl-month');
  try {
    // Revenue by vehicle
    let revSnap = { forEach: () => {} };
    try { revSnap = await db.collection('tripLogs').where('startDate','>=',start).where('startDate','<=',end).get(); } catch(e) {}
    const revByV = {};
    revSnap.forEach(doc => {
      const d = doc.data();
      if (d.cancelled) return;
      if (!revByV[d.vehicleId]) revByV[d.vehicleId] = { plate: d.vehiclePlate, turo: 0, priv: 0, extras: 0 };
      const rev = Number(d.revenue) || 0;
      if (d.tripType === 'private-trip') revByV[d.vehicleId].priv += rev; else revByV[d.vehicleId].turo += rev;
      const plExtrasArr = Array.isArray(d.extras) ? d.extras
        : (d.extrasType && d.extrasAmount ? [{ type: d.extrasType, amount: Number(d.extrasAmount) }] : []);
      revByV[d.vehicleId].extras += plExtrasArr.reduce((s, e) => s + (Number(e.amount) || 0), 0);
    });

    // Expenses by vehicle
    const expSnap = await db.collection('expenses').where('date','>=',start).where('date','<=',end).get();
    const expByV = {}; let generalExp = 0;
    expSnap.forEach(doc => {
      const d = doc.data();
      const amt = Number(d.amount) || 0;
      if (d.vehicleId) expByV[d.vehicleId] = (expByV[d.vehicleId]||0) + amt;
      else generalExp += amt;
    });

    // Maintenance costs by vehicle
    const maintSnap = await db.collection('maintenance').where('date','>=',start).where('date','<=',end).get();
    const maintByV = {};
    maintSnap.forEach(doc => {
      const d = doc.data();
      const cost = Number(d.cost) || 0;
      if (cost && d.vehicleId) maintByV[d.vehicleId] = (maintByV[d.vehicleId]||0) + cost;
    });

    const allIds = new Set([...Object.keys(revByV),...Object.keys(expByV),...Object.keys(maintByV)]);
    const rows = [...allIds].map(vid => {
      const rv = revByV[vid] || { plate: '', turo: 0, priv: 0 };
      const v = vehiclesCache.find(x => x.id === vid);
      const plate = rv.plate || v?.plate || vid;
      const totalRev = rv.turo + rv.priv + (rv.extras || 0);
      const expenses = expByV[vid] || 0;
      const maint = maintByV[vid] || 0;
      const totalCost = expenses + maint;
      const net = totalRev - totalCost;
      return { plate, totalRev, expenses, maint, totalCost, net };
    });
    rows.sort((a,b) => b.net - a.net);

    const fmtR = n => '$' + Math.abs(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
    const fleetRev = rows.reduce((s,r) => s+r.totalRev, 0);
    const fleetExp = rows.reduce((s,r) => s+r.expenses, 0) + generalExp;
    const fleetMaint = rows.reduce((s,r) => s+r.maint, 0);
    const fleetNet = fleetRev - fleetExp - fleetMaint;

    body.innerHTML = `
      <div class="fin-pl-header">
        <strong>${label}</strong>
        <span class="fin-pl-net ${fleetNet >= 0 ? 'profit':'loss'}">${fleetNet >= 0 ? '+' : '−'}${fmtR(fleetNet)}</span>
      </div>
      <table class="fin-table">
        <thead><tr><th>Vehicle</th><th>Revenue</th><th>Expenses</th><th>Maint.</th><th>Net P&amp;L</th></tr></thead>
        <tbody>
          ${rows.map(r => `<tr>
            <td><strong>${escapeHtml(r.plate)}</strong></td>
            <td class="fin-td-rev">${r.totalRev > 0 ? fmtR(r.totalRev) : '—'}</td>
            <td class="fin-td-exp">${r.expenses > 0 ? fmtR(r.expenses) : '—'}</td>
            <td class="fin-td-maint">${r.maint > 0 ? fmtR(r.maint) : '—'}</td>
            <td class="fin-td-net ${r.net >= 0 ? 'profit':'loss'}">${r.net >= 0 ? '+' : '−'}${fmtR(r.net)}</td>
          </tr>`).join('')}
          ${generalExp > 0 ? `<tr class="fin-tr-general">
            <td><em style="color:#6b7280;">Fleet / General</em></td>
            <td>—</td>
            <td class="fin-td-exp">${fmtR(generalExp)}</td>
            <td>—</td>
            <td class="fin-td-net loss">−${fmtR(generalExp)}</td>
          </tr>` : ''}
        </tbody>
        <tfoot>
          <tr>
            <td><strong>TOTAL</strong></td>
            <td class="fin-td-rev"><strong>${fmtR(fleetRev)}</strong></td>
            <td class="fin-td-exp"><strong>${fmtR(fleetExp)}</strong></td>
            <td class="fin-td-maint"><strong>${fmtR(fleetMaint)}</strong></td>
            <td class="fin-td-net ${fleetNet >= 0 ? 'profit':'loss'}"><strong>${fleetNet >= 0 ? '+' : '−'}${fmtR(fleetNet)}</strong></td>
          </tr>
        </tfoot>
      </table>
    `;
  } catch(e) {
    console.error('Finance P&L error:', e);
    body.innerHTML = '<p class="hint" style="color:#ef4444;padding:16px;">Failed to load P&L.</p>';
  }
};

// ── Multi-extras helpers ─────────────────────────────────────────────────────
const EXTRAS_OPTIONS_HTML = `
  <option value="">-- None --</option>
  <option value="beach-gear">🏖️ Beach Gear</option>
  <option value="parking">🅿️ Parking</option>
  <option value="snorkeling-gear">🤿 Snorkeling Gear</option>
  <option value="beach-tent">⛺ Beach Tent</option>
  <option value="car-seat">🪱 Car Seat</option>
  <option value="other">✏️ Other</option>`;

window.addExtraRow = function(listId, type, amount) {
  const list = $(listId);
  if (!list) return;
  const row = document.createElement('div');
  row.className = 'loc-extra-row';
  row.innerHTML = `<select class="vehicle-location-custom extra-type-sel">${EXTRAS_OPTIONS_HTML}</select><input type="number" class="vehicle-location-custom extra-amt-inp" placeholder="0.00" min="0" step="0.01"><button type="button" class="btn btn-xs btn-danger extra-remove-btn" onclick="this.closest('.loc-extra-row').remove()">✕</button>`;
  if (type) row.querySelector('.extra-type-sel').value = type;
  if (amount) row.querySelector('.extra-amt-inp').value = amount;
  list.appendChild(row);
};

function getExtrasList(listId) {
  const list = $(listId);
  if (!list) return [];
  const result = [];
  list.querySelectorAll('.loc-extra-row').forEach(row => {
    const type = row.querySelector('.extra-type-sel')?.value || '';
    const amount = parseFloat(row.querySelector('.extra-amt-inp')?.value) || 0;
    if (type && amount > 0) result.push({ type, amount });
  });
  return result;
}
// ─────────────────────────────────────────────────────────────────────────────

window.openFinance = function() {
  const overlay = $('finance-overlay');
  if (!overlay) return;
  overlay.style.display = 'flex';
  populateExpenseVehicleDropdown();
  const revEl = $('fin-rev-month');
  if (revEl && !revEl.value) revEl.value = _todayMonthVal();
  const plEl = $('fin-pl-month');
  if (plEl && !plEl.value) plEl.value = _todayMonthVal();
  switchFinanceTab('overview');
};

window.closeFinance = function() {
  const overlay = $('finance-overlay');
  if (overlay) overlay.style.display = 'none';
};




