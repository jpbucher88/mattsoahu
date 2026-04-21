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
const APP_TIMEZONE = 'Pacific/Honolulu'; // Hawaii Standard Time
let currentUser = null;
let currentUserRole = null;
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

      $('user-display').textContent = userData.displayName || user.email;
      $('btn-admin').style.display = currentUserRole === 'admin' ? '' : 'none';

      // Run auto-cleanup on any login (not just admin)
      cleanupOldPhotos();

      await loadVehicles();
      showPage('dashboard');
      startMailListener();
      initTimeClock();
    } catch (err) {
      console.error('Auth state error:', err);
      toast('Error loading profile', 'error');
    } finally {
      hideLoading();
    }
  } else {
    currentUser = null;
    currentUserRole = null;
    if (mailUnsubscribe) { mailUnsubscribe(); mailUnsubscribe = null; }
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
    } catch (e) {
      v.lastPhotoAge = null;
      v.lastPhotoDate = null;
    }

    // Overdue maintenance count
    v.overdueCount = 0;
    if (v.mileage) {
      try {
        const mSnap = await db.collection('maintenance')
          .where('vehicleId', '==', v.id)
          .orderBy('mileage', 'desc')
          .get();
        const lastServices = {};
        mSnap.forEach(doc => {
          const d = doc.data();
          if (d.serviceType && !lastServices[d.serviceType]) lastServices[d.serviceType] = d.mileage || 0;
        });
        MAINTENANCE_SCHEDULE.forEach(item => {
          const customInterval = (v.customSchedule && v.customSchedule[item.service]) || item.interval;
          const lastMi = lastServices[item.service] || 0;
          if (lastMi + customInterval - v.mileage <= 0) v.overdueCount++;
        });
      } catch (e) { /* ignore */ }
    }
  });
  await Promise.all(checks);

  // Populate admin dropdown
  populateVehicleSelect($('admin-vehicle-select'));
  // Update vehicle count badge
  const countEl = $('vehicle-count');
  if (countEl) countEl.textContent = vehiclesCache.length;

  // Render fleet dashboard
  renderFleetDashboard();
  loadDashboardFollowUps();
  loadGeneralNotes();
}

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
    const isOnTrip = v.tripStatus === 'on-trip';
    const isAtRepair = v.tripStatus === 'repair-shop';
    const stillCleaning = v.needsCleaning;
    let withinGrace = false;
    if (v.cleaningFlaggedAt) {
      const flagTime = v.cleaningFlaggedAt.toDate ? v.cleaningFlaggedAt.toDate().getTime() : new Date(v.cleaningFlaggedAt).getTime();
      withinGrace = (Date.now() - flagTime) < MS_2H;
    }
    const suppressPhoto = isOnTrip || isAtRepair || stillCleaning || withinGrace;

    // Photo status
    let photoStatus, photoCls;
    if (suppressPhoto) {
      if (isOnTrip) {
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
    } else if (v.homeLocation) {
      locDisplay = `🏠 ${escapeHtml(v.homeLocation)}`;
      locCls = 'status-ok';
    } else {
      locDisplay = 'No location set';
      locCls = 'status-muted';
    }
    const cleaningFlag = v.needsCleaning ? '<span class="fleet-cleaning-flag">🧹</span>' : '';
    html += `<div class="fleet-card${needsPhotos ? ' fleet-card-alert' : ''}" data-vid="${v.id}">
      ${needsPhotos ? '<span class="fleet-card-badge">⚠️</span>' : ''}
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
  const onTrip = vehiclesCache.filter(v => v.tripStatus === 'on-trip');
  const atRepair = vehiclesCache.filter(v => v.tripStatus === 'repair-shop');
  // "at home" excludes vehicles needing cleaning OR needing photos-only
  function isAtHome(v) {
    return v.tripStatus !== 'on-trip' && v.tripStatus !== 'repair-shop' && !v.needsCleaning;
  }
  const atHome1585 = vehiclesCache.filter(v => isAtHome(v) && v.homeLocation === '1585 Kapiolani' && !needsPhotosCheck(v));
  const atHomeHNL = vehiclesCache.filter(v => isAtHome(v) && v.homeLocation === 'HNL' && !needsPhotosCheck(v));
  const noLocation = vehiclesCache.filter(v => isAtHome(v) && !v.homeLocation && !needsPhotosCheck(v));
  const cleaningHNL = vehiclesCache.filter(v => v.needsCleaning && v.homeLocation === 'HNL');
  const cleaning1585 = vehiclesCache.filter(v => v.needsCleaning && v.homeLocation === '1585 Kapiolani');
  const cleaningOther = vehiclesCache.filter(v => v.needsCleaning && v.homeLocation !== 'HNL' && v.homeLocation !== '1585 Kapiolani');

  // Check if vehicle needs photos (stale >24h, not suppressed by trip/repair/grace)
  function needsPhotosCheck(v) {
    const isOnTrip = v.tripStatus === 'on-trip';
    const isAtRepair = v.tripStatus === 'repair-shop';
    let withinGrace = false;
    if (v.cleaningFlaggedAt) {
      const flagTime = v.cleaningFlaggedAt.toDate ? v.cleaningFlaggedAt.toDate().getTime() : new Date(v.cleaningFlaggedAt).getTime();
      withinGrace = (Date.now() - flagTime) < MS_2H;
    }
    if (isOnTrip || isAtRepair || withinGrace) return false;
    return v.lastPhotoAge != null && v.lastPhotoAge > MS_24H;
  }
  // Photos-ONLY = needs photos but NOT cleaning (cleaning+photos merged into cleaning bucket)
  const photosOnlyHNL = vehiclesCache.filter(v => needsPhotosCheck(v) && !v.needsCleaning && v.homeLocation === 'HNL');
  const photosOnly1585 = vehiclesCache.filter(v => needsPhotosCheck(v) && !v.needsCleaning && v.homeLocation === '1585 Kapiolani');
  const photosOnlyOther = vehiclesCache.filter(v => needsPhotosCheck(v) && !v.needsCleaning && v.homeLocation !== 'HNL' && v.homeLocation !== '1585 Kapiolani');

  // Sort helpers
  const sortByReturn = (arr) => arr.sort((a, b) => {
    const aT = a.tripReturnDate ? (a.tripReturnDate.toDate ? a.tripReturnDate.toDate().getTime() : new Date(a.tripReturnDate).getTime()) : Infinity;
    const bT = b.tripReturnDate ? (b.tripReturnDate.toDate ? b.tripReturnDate.toDate().getTime() : new Date(b.tripReturnDate).getTime()) : Infinity;
    return aT - bT;
  });
  sortByReturn(onTrip);
  sortByReturn(atRepair);

  let html = '';

  // Helper for cleaning section (includes photo button if vehicle also needs photos)
  function renderCleaningSection(title, vehicles) {
    if (vehicles.length === 0) return '';
    let s = `<div class="location-group location-group-cleaning">
      <div class="location-group-header" style="background:#d97706;">
        <span class="location-group-name">\ud83e\uddf9 ${escapeHtml(title)}</span>
        <span class="location-group-count">${vehicles.length}</span>
      </div>
      <div class="location-group-vehicles cleaning-list">`;
    for (const v of vehicles) {
      const needsDamage = v.needsDamageCheck;
      const alsoNeedsPhotos = needsPhotosCheck(v);
      let photoTag = '';
      if (alsoNeedsPhotos) {
        let ageText = '';
        if (v.lastPhotoAge === Infinity) { ageText = 'No photos yet'; }
        else { const hrs = Math.floor(v.lastPhotoAge / (1000 * 60 * 60)); const days = Math.floor(hrs / 24); ageText = days > 0 ? `${days}d ${hrs % 24}h ago` : `${hrs}h ago`; }
        photoTag = `<span class="photo-age-tag">${ageText}</span>`;
      }
      s += `<div class="cleaning-item" data-vid="${v.id}">
        <div class="cleaning-vehicle-info">
          <span class="location-vehicle-chip" data-vid="${v.id}">${escapeHtml(v.plate)}</span>
          <span class="cleaning-meta">${escapeHtml(v.make)} ${escapeHtml(v.model)}</span>
          ${photoTag}
        </div>
        <div class="cleaning-actions">
          ${needsDamage ? `<button class="btn btn-sm btn-outline damage-check-btn" data-vid="${v.id}">🔍 Inspect</button>` : '<span class="damage-ok-badge">✅ Inspected</span>'}
          <button class="btn btn-sm btn-primary cleaning-done-btn" data-vid="${v.id}" ${needsDamage ? 'disabled title="Complete inspection first"' : ''}>✓ Cleaned</button>
          ${alsoNeedsPhotos ? `<button class="btn btn-sm btn-outline photo-done-btn" data-vid="${v.id}">\ud83d\udcf7</button>` : ''}
        </div>
      </div>`;
    }
    s += '</div></div>';
    return s;
  }

  // Helper for photos-needed section
  function renderPhotosSection(title, vehicles) {
    if (vehicles.length === 0) return '';
    let s = `<div class="location-group location-group-photos">
      <div class="location-group-header" style="background:#7c3aed;">
        <span class="location-group-name">\ud83d\udcf7 ${escapeHtml(title)}</span>
        <span class="location-group-count">${vehicles.length}</span>
      </div>
      <div class="location-group-vehicles cleaning-list">`;
    for (const v of vehicles) {
      let ageText = '';
      if (v.lastPhotoAge === Infinity) {
        ageText = 'No photos yet';
      } else {
        const hrs = Math.floor(v.lastPhotoAge / (1000 * 60 * 60));
        const days = Math.floor(hrs / 24);
        ageText = days > 0 ? `${days}d ${hrs % 24}h ago` : `${hrs}h ago`;
      }
      s += `<div class="cleaning-item" data-vid="${v.id}">
        <div class="cleaning-vehicle-info">
          <span class="location-vehicle-chip" data-vid="${v.id}">${escapeHtml(v.plate)}</span>
          <span class="cleaning-meta">${escapeHtml(v.make)} ${escapeHtml(v.model)}</span>
          <span class="photo-age-tag">${ageText}</span>
        </div>
        <button class="btn btn-sm btn-primary photo-done-btn" data-vid="${v.id}">\ud83d\udcf7 Done</button>
      </div>`;
    }
    s += '</div></div>';
    return s;
  }

  // Needs Cleaning (+ photos if both) — split by location
  html += renderCleaningSection('Needs Cleaning — HNL', cleaningHNL);
  html += renderCleaningSection('Needs Cleaning — 1585 Kapiolani', cleaning1585);
  if (cleaningOther.length > 0) html += renderCleaningSection('Needs Cleaning — Other', cleaningOther);

  // Photos Only (not cleaning) — split by location
  html += renderPhotosSection('Needs Photos — HNL', photosOnlyHNL);
  html += renderPhotosSection('Needs Photos — 1585 Kapiolani', photosOnly1585);
  if (photosOnlyOther.length > 0) html += renderPhotosSection('Needs Photos — Other', photosOnlyOther);

  // On the Road
  if (onTrip.length > 0) {
    html += `<div class="location-group">
      <div class="location-group-header" style="background:#2563eb;">
        <span class="location-group-name">\ud83d\ude97 On the Road</span>
        <span class="location-group-count">${onTrip.length}</span>
      </div>
      <div class="location-group-vehicles trip-list">`;
    for (const v of onTrip) {
      let returnLabel = '';
      if (v.tripReturnDate) {
        const rd = v.tripReturnDate.toDate ? v.tripReturnDate.toDate() : new Date(v.tripReturnDate);
        const now = new Date();
        const isOverdue = rd < now;
        returnLabel = `<span class="trip-return-label${isOverdue ? ' trip-overdue' : ''}">\u21a9 ${rd.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: APP_TIMEZONE })}${isOverdue ? ' OVERDUE' : ''}</span>`;
      }
      html += `<div class="trip-item">
        <span class="location-vehicle-chip" data-vid="${v.id}">${escapeHtml(v.plate)}</span>
        <span class="trip-meta">${escapeHtml(v.make)} ${escapeHtml(v.model)}</span>
        ${returnLabel}
      </div>`;
    }
    html += '</div></div>';
  }

  // At Home — 1585 Kapiolani
  if (atHome1585.length > 0) {
    html += `<div class="location-group">
      <div class="location-group-header">
        <span class="location-group-name">\ud83c\udfe0 1585 Kapiolani</span>
        <span class="location-group-count">${atHome1585.length}</span>
      </div>
      <div class="location-group-vehicles">`;
    for (const v of atHome1585) html += `<div class="location-vehicle-chip" data-vid="${v.id}">${escapeHtml(v.plate)}</div>`;
    html += '</div></div>';
  }

  // At Home — HNL
  if (atHomeHNL.length > 0) {
    html += `<div class="location-group">
      <div class="location-group-header">
        <span class="location-group-name">\ud83c\udfe0 HNL</span>
        <span class="location-group-count">${atHomeHNL.length}</span>
      </div>
      <div class="location-group-vehicles">`;
    for (const v of atHomeHNL) html += `<div class="location-vehicle-chip" data-vid="${v.id}">${escapeHtml(v.plate)}</div>`;
    html += '</div></div>';
  }

  // Repair Shop — with return date + parts info
  if (atRepair.length > 0) {
    html += `<div class="location-group">
      <div class="location-group-header" style="background:#dc2626;">
        <span class="location-group-name">\ud83d\udd27 Repair Shop</span>
        <span class="location-group-count">${atRepair.length}</span>
      </div>
      <div class="location-group-vehicles trip-list">`;
    for (const v of atRepair) {
      let returnLabel = '';
      if (v.tripReturnDate) {
        const rd = v.tripReturnDate.toDate ? v.tripReturnDate.toDate() : new Date(v.tripReturnDate);
        const now = new Date();
        const isOverdue = rd < now;
        returnLabel = `<span class="trip-return-label${isOverdue ? ' trip-overdue' : ''}">\u21a9 ${rd.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: APP_TIMEZONE })}${isOverdue ? ' OVERDUE' : ''}</span>`;
      }
      let partsInfo = '';
      if (v.repairShopName) partsInfo += `<span class="repair-parts-tag">\ud83c\udfe5 ${escapeHtml(v.repairShopName)}</span>`;
      if (v.repairOrderNumber) partsInfo += `<span class="repair-parts-tag">\ud83d\udce6 ${escapeHtml(v.repairOrderNumber)}</span>`;
      if (v.repairPartsEta) partsInfo += `<span class="repair-parts-tag">\ud83d\udcc5 Parts ETA: ${v.repairPartsEta}</span>`;
      html += `<div class="trip-item">
        <span class="location-vehicle-chip" data-vid="${v.id}">${escapeHtml(v.plate)}</span>
        <span class="trip-meta">${escapeHtml(v.make)} ${escapeHtml(v.model)}</span>
        ${returnLabel}
        ${partsInfo}
      </div>`;
    }
    html += '</div></div>';
  }

  // No Location
  if (noLocation.length > 0) {
    html += `<div class="location-group">
      <div class="location-group-header" style="background:#6b7280;">
        <span class="location-group-name">\u2753 No Location Set</span>
        <span class="location-group-count">${noLocation.length}</span>
      </div>
      <div class="location-group-vehicles">`;
    for (const v of noLocation) html += `<div class="location-vehicle-chip" data-vid="${v.id}">${escapeHtml(v.plate)}</div>`;
    html += '</div></div>';
  }

  if (!html) html = '<p class="hint">No vehicles to display.</p>';
  container.innerHTML = html;

  // Click chip to open vehicle (touchend for instant iOS response)
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

  // Damage inspection button handler — show checklist modal
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
        toast('Marked as cleaned! \u2713', 'success');
        renderLocationsWidget();
      } catch (err) {
        console.error('Mark cleaned error:', err);
        toast('Failed to update.', 'error');
      }
    });
  });

  // Photo done button handler — opens vehicle page to take photos
  container.querySelectorAll('.photo-done-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openVehiclePage(btn.dataset.vid);
    });
  });
}

// Damage check modal
function showDamageCheckModal(vid, plate) {
  // Remove existing modal if any
  const existing = document.querySelector('.damage-check-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'damage-check-overlay';
  overlay.innerHTML = `
    <div class="damage-check-modal">
      <h4>\ud83d\udd0d Vehicle Inspection \u2014 ${escapeHtml(plate)}</h4>
      <p>Complete all checks before marking as cleaned:</p>
      <div class="damage-checklist">
        <label class="damage-check-item"><input type="checkbox" class="dmg-check" data-check="exterior"> Exterior \u2014 No new damage</label>
        <label class="damage-check-item"><input type="checkbox" class="dmg-check" data-check="interior"> Interior \u2014 No new damage</label>
        <label class="damage-check-item"><input type="checkbox" class="dmg-check" data-check="tires"> Tires \u2014 Good condition</label>
        <label class="damage-check-item"><input type="checkbox" class="dmg-check" data-check="clean"> Vehicle cleaned</label>
      </div>
      <div class="damage-check-actions">
        <button class="btn btn-sm btn-outline dmg-cancel-btn">Cancel</button>
        <button class="btn btn-sm btn-primary dmg-confirm-btn" disabled>✓ Confirm All Clear</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const checks = overlay.querySelectorAll('.dmg-check');
  const confirmBtn = overlay.querySelector('.dmg-confirm-btn');

  // Enable confirm only when all checked
  checks.forEach(cb => {
    cb.addEventListener('change', () => {
      const allChecked = Array.from(checks).every(c => c.checked);
      confirmBtn.disabled = !allChecked;
    });
  });

  overlay.querySelector('.dmg-cancel-btn').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  confirmBtn.addEventListener('click', async () => {
    try {
      await db.collection('vehicles').doc(vid).update({
        needsDamageCheck: false,
        lastInspectedAt: firebase.firestore.FieldValue.serverTimestamp(),
        lastInspectedBy: currentUser.displayName || currentUser.email
      });
      const cached = vehiclesCache.find(v => v.id === vid);
      if (cached) cached.needsDamageCheck = false;
      toast('Inspection complete! \u2713', 'success');
      overlay.remove();
      renderLocationsWidget();
    } catch (err) {
      console.error('Damage check error:', err);
      toast('Failed to update.', 'error');
    }
  });
}

// Open the vehicle detail page
async function openVehiclePage(vid) {
  selectedVehicle = vehiclesCache.find(v => v.id === vid);
  if (!selectedVehicle) return;

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
    // Show/hide return row for on-trip and repair-shop
    tripReturnRow.style.display = (tripStatusSelect.value === 'on-trip' || tripStatusSelect.value === 'repair-shop') ? '' : 'none';
    repairPartsRow.style.display = tripStatusSelect.value === 'repair-shop' ? '' : 'none';
    if (selectedVehicle.tripReturnDate) {
      const rd = selectedVehicle.tripReturnDate.toDate ? selectedVehicle.tripReturnDate.toDate() : new Date(selectedVehicle.tripReturnDate);
      // Format for datetime-local input in HST (sv-SE gives ISO-like "YYYY-MM-DD HH:MM:SS")
      tripReturnInput.value = rd.toLocaleString('sv-SE', { timeZone: APP_TIMEZONE }).slice(0, 16).replace(' ', 'T');
    } else {
      tripReturnInput.value = '';
    }
    // Repair parts fields
    $('repair-shop-name').value = selectedVehicle.repairShopName || '';
    $('repair-order-number').value = selectedVehicle.repairOrderNumber || '';
    $('repair-parts-eta').value = selectedVehicle.repairPartsEta || '';
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
  const isOnTrip = selectedVehicle.tripStatus === 'on-trip';
  const isAtRepairShop = selectedVehicle.tripStatus === 'repair-shop';
  const stillNeedsCleaning = selectedVehicle.needsCleaning;
  // Grace: 2 hours after cleaning was flagged (vehicle returned)
  let withinGrace = false;
  if (selectedVehicle.cleaningFlaggedAt) {
    const flagTime = selectedVehicle.cleaningFlaggedAt.toDate ? selectedVehicle.cleaningFlaggedAt.toDate().getTime() : new Date(selectedVehicle.cleaningFlaggedAt).getTime();
    withinGrace = (Date.now() - flagTime) < MS_2H;
  }
  const suppressStale = isOnTrip || isAtRepairShop || stillNeedsCleaning || withinGrace;

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
    staleAlert.textContent = '\ud83d\ude97 Vehicle is on a trip \u2014 photos not required until after return & cleaning.';
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

  // Reset mileage prompt for this vehicle
  if (canUpload) {
    resetMileagePrompt();
  }

  const canMaintain = (currentUserRole === 'admin' || currentUserRole === 'manager');
  $('btn-add-maintenance').style.display = canMaintain ? '' : 'none';
  $('mileage-edit-row').style.display = canMaintain ? '' : 'none';
  $('btn-edit-schedule').style.display = canMaintain ? '' : 'none';
  $('schedule-editor').style.display = 'none';

  // Show notes section
  $('notes-section').style.display = 'block';

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

  // Load maintenance data
  loadMileage(vid);
  loadMaintenanceHistory(vid);
  loadVehicleNotes(vid);
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
// PHOTO UPLOAD
// ================================================================

$('file-input').addEventListener('change', handlePhotoFiles);

async function handlePhotoFiles(e) {
  const files = Array.from(e.target.files);
  if (!files.length || !selectedVehicle) return;

  if (!getStorage()) {
    toast('Photo uploads not available — Firebase Storage is not enabled yet. Contact your admin.', 'error');
    e.target.value = '';
    return;
  }

  const queue = $('photo-queue');
  const progressSection = $('upload-progress');
  progressSection.style.display = 'block';

  let uploaded = 0;
  const total = files.length;

  updateProgress(uploaded, total);

  const uploadedUrls = [];
  for (const file of files) {
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

    try {
      const compressed = await compressImage(file);
      const url = await uploadPhoto(compressed);
      uploadedUrls.push(url);

      statusIcon.className = 'status-icon status-done';
      statusIcon.textContent = '✓';
      uploaded++;
      updateProgress(uploaded, total);
    } catch (err) {
      console.error('Upload error:', err);
      statusIcon.className = 'status-icon status-error';
      statusIcon.textContent = '✗';
      uploaded++;
      updateProgress(uploaded, total);
      toast(`Failed to upload: ${file.name}`, 'error');
    }
  }

  toast(`${uploaded} photo(s) uploaded!`, 'success');
  e.target.value = '';
  await loadPhotosForDate(selectedVehicle.id, selectedDate);
}

// Core upload function — used by both file picker and camera
async function uploadPhoto(blobOrFile) {
  const st = getStorage();
  if (!st) {
    throw new Error('Firebase Storage is not enabled yet. Contact your admin to enable billing.');
  }
  const plate = sanitizePlate(selectedVehicle.plate);
  const date = todayDateString();
  const timestamp = Date.now();
  const fileName = `${timestamp}_${Math.random().toString(36).substring(2, 8)}.jpg`;
  const storagePath = `vehicles/${plate}/${date}/${fileName}`;

  const ref = st.ref(storagePath);
  await ref.put(blobOrFile, { contentType: 'image/jpeg' });
  const downloadURL = await ref.getDownloadURL();

  await db.collection('photos').add({
    vehicleId: selectedVehicle.id,
    plate: selectedVehicle.plate,
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

let cameraStream = null;
let cameraFacingMode = 'environment'; // back camera
let cameraFlashOn = false;
let cameraShotCount = 0;
let cameraUploadQueue = [];
let cameraUploading = false;
let cameraUploadedCount = 0;
let cameraTotalQueued = 0;
let cameraUploadedUrls = [];

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

async function openCamera() {
  cameraShotCount = 0;
  cameraUploadQueue = [];
  cameraUploadedCount = 0;
  cameraTotalQueued = 0;
  cameraUploadedUrls = [];
  cameraFlashOn = false;
  $('camera-thumbs').innerHTML = '';
  $('camera-count').textContent = '0 photos';
  $('camera-upload-bar').style.display = 'none';
  updateFlashButton();
  $('camera-overlay').style.display = 'flex';

  // Prevent pinch-to-zoom gestures on camera
  const preventZoom = (e) => { if (e.touches && e.touches.length > 1) e.preventDefault(); };
  $('camera-overlay').addEventListener('touchmove', preventZoom, { passive: false });
  $('camera-overlay').addEventListener('gesturestart', (e) => e.preventDefault());
  $('camera-overlay').addEventListener('gesturechange', (e) => e.preventDefault());

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
    { video: { facingMode: { exact: cameraFacingMode }, width: { ideal: 1920 }, height: { ideal: 1080 }, zoom: 1.0 }, audio: false },
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

  // Force zoom to 1x (minimum) and apply flash state
  const [track] = cameraStream.getVideoTracks();
  if (track && track.getCapabilities) {
    try {
      const caps = track.getCapabilities();
      const constraintUpdates = {};
      if (caps.zoom) {
        constraintUpdates.zoom = caps.zoom.min;
      }
      // Apply torch state if supported
      if (caps.torch) {
        constraintUpdates.torch = cameraFlashOn;
      }
      if (Object.keys(constraintUpdates).length) {
        await track.applyConstraints({ advanced: [constraintUpdates] });
      }
    } catch (e) { /* zoom/torch not supported — ok */ }
  }
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

// Shutter button — captures frame and queues upload
$('camera-shutter').addEventListener('click', () => {
  const video = $('camera-video');
  const canvas = $('camera-canvas');

  // Capture at video resolution
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0);

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
  // Compress first
  const compressed = await compressBlob(blob, 1920, 0.82);
  cameraUploadQueue.push(compressed);
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

  while (cameraUploadQueue.length > 0) {
    const blob = cameraUploadQueue.shift();
    try {
      const url = await uploadPhoto(blob);
      cameraUploadedUrls.push(url);
      cameraUploadedCount++;
      updateCameraUploadBar();
    } catch (err) {
      console.error('Camera upload error:', err);
      if (!getStorage() && !storageWarningShown) {
        storageWarningShown = true;
        toast('Photos saved locally but uploads need Firebase Storage enabled.', 'warning');
      }
    }
  }

  cameraUploading = false;
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
  const dt = new Date(y, m - 1, d);
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
  const firstDay = new Date(y, m - 1, 1).getDay();
  const daysInMonth = new Date(y, m, 0).getDate();
  const todayStr = todayDateString();

  const monthLabel = new Date(y, m - 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

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
        if (!confirm('Delete this photo permanently?')) return;
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
$('vehicle-trip-status').addEventListener('change', function() {
  $('trip-return-row').style.display = (this.value === 'on-trip' || this.value === 'repair-shop') ? '' : 'none';
  $('repair-parts-row').style.display = this.value === 'repair-shop' ? '' : 'none';
  // Hide needs-cleaning btn if switching to trip/repair
  const needsCleanBtn = $('btn-needs-cleaning');
  if (needsCleanBtn && selectedVehicle) {
    const showCleanBtn = this.value !== 'on-trip' && this.value !== 'repair-shop' && !selectedVehicle.needsCleaning;
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

  if (!homeLocation) {
    toast('Please select a home location.', 'warning');
    return;
  }

  const updateData = { homeLocation, tripStatus };

  // Compute the display location for backward compat
  if (tripStatus === 'on-trip') {
    updateData.location = 'On Trip';
    if (tripReturnVal) {
      // Append HST offset so the value is always parsed as Hawaii time (UTC-10), not the user's local timezone
      updateData.tripReturnDate = firebase.firestore.Timestamp.fromDate(new Date(tripReturnVal + ':00-10:00'));
    } else {
      updateData.tripReturnDate = firebase.firestore.FieldValue.delete();
    }
    updateData.repairShopName = firebase.firestore.FieldValue.delete();
    updateData.repairOrderNumber = firebase.firestore.FieldValue.delete();
    updateData.repairPartsEta = firebase.firestore.FieldValue.delete();
  } else if (tripStatus === 'repair-shop') {
    updateData.location = 'Repair Shop';
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
  } else {
    updateData.location = homeLocation;
    updateData.tripReturnDate = firebase.firestore.FieldValue.delete();
    updateData.repairShopName = firebase.firestore.FieldValue.delete();
    updateData.repairOrderNumber = firebase.firestore.FieldValue.delete();
    updateData.repairPartsEta = firebase.firestore.FieldValue.delete();
  }

  // If vehicle was on-trip and now returning home, flag for cleaning + damage check
  const wasOnTrip = selectedVehicle.tripStatus === 'on-trip';
  const nowHome = tripStatus === 'home';
  if (wasOnTrip && nowHome) {
    updateData.needsCleaning = true;
    updateData.needsDamageCheck = true;
    updateData.cleaningFlaggedAt = firebase.firestore.FieldValue.serverTimestamp();
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
    } else {
      delete selectedVehicle.repairShopName;
      delete selectedVehicle.repairOrderNumber;
      delete selectedVehicle.repairPartsEta;
    }
    if (wasOnTrip && nowHome) {
      selectedVehicle.needsCleaning = true;
      selectedVehicle.needsDamageCheck = true;
    }
    const cached = vehiclesCache.find(v => v.id === selectedVehicle.id);
    if (cached) Object.assign(cached, selectedVehicle);
    toast('Location saved!', 'success');
    renderFleetDashboard();
  } catch (err) {
    console.error('Save location error:', err);
    toast('Failed to save location.', 'error');
  }
});

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
    return `
    <div class="data-list-item">
      <div class="v-list-thumb-wrap">${hasPhoto}</div>
      <div class="item-info">
        <div class="item-title">${escapeHtml(v.plate)}</div>
        <div class="item-subtitle">${escapeHtml(v.make)} ${escapeHtml(v.model)}${v.year ? ` (${v.year})` : ''}${v.color ? ` - ${escapeHtml(v.color)}` : ''}</div>
      </div>
      <div class="item-actions">
        <button class="btn btn-sm btn-outline" onclick="openEditVehicle('${v.id}')">Edit</button>
        <button class="btn btn-sm btn-danger" onclick="deleteVehicle('${v.id}', '${escapeHtml(v.plate)}')">Delete</button>
      </div>
    </div>`;
  }).join('');
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
      plate, make, model, year, color
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
const MAINTENANCE_SCHEDULE = [
  { service: 'Oil Change',          interval: 5000,   icon: '🛢️' },
  { service: 'Tire Rotation',       interval: 7500,   icon: '🔄' },
  { service: 'Air Filter',          interval: 15000,  icon: '💨' },
  { service: 'Cabin Filter',        interval: 15000,  icon: '🌬️' },
  { service: 'Brake Inspection',    interval: 20000,  icon: '🔍' },
  { service: 'Transmission Fluid',  interval: 30000,  icon: '⚙️' },
  { service: 'Coolant Flush',       interval: 30000,  icon: '❄️' },
  { service: 'Spark Plugs',         interval: 30000,  icon: '⚡' },
  { service: 'Wiper Blades',        interval: 15000,  icon: '🌧️' },
  { service: 'Belts/Hoses',         interval: 60000,  icon: '🔧' },
  { service: 'Battery',             interval: 50000,  icon: '🔋' },
  { service: 'Tires (New)',         interval: 40000,  icon: '🛞' },
  { service: 'Alignment',           interval: 25000,  icon: '📐' },
  { service: 'Brake Pads/Rotors',   interval: 40000,  icon: '🛑' },
];

// Get schedule for a vehicle, merging custom overrides with defaults
function getScheduleForVehicle(vehicle) {
  const custom = (vehicle && vehicle.customSchedule) || {};
  return MAINTENANCE_SCHEDULE.map(item => ({
    ...item,
    interval: custom[item.service] || item.interval,
    isCustom: !!custom[item.service]
  }));
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

  // Get last service mileage and last service date for each type
  const lastServices = {};
  const lastServiceData = {};
  try {
    const snap = await db.collection('maintenance')
      .where('vehicleId', '==', vehicleId)
      .orderBy('date', 'desc')
      .get();
    snap.forEach(doc => {
      const d = doc.data();
      if (d.serviceType) {
        if (!lastServices[d.serviceType]) {
          lastServices[d.serviceType] = d.mileage || 0;
          lastServiceData[d.serviceType] = d;
        }
      }
    });
  } catch (e) {
    console.warn('Could not load maintenance for recommendations:', e);
  }

  const schedule = getScheduleForVehicle(v);
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

  // --- Mileage-based section (from MAINTENANCE_SCHEDULE defaults) ---
  const due = [];
  const upcoming = [];

  if (mileage) {
    schedule.forEach(item => {
      const lastMi = lastServices[item.service] || 0;
      const nextDue = lastMi + item.interval;
      const milesUntil = nextDue - mileage;
      if (milesUntil <= 0) {
        due.push({ ...item, milesUntil, nextDue, overdue: true });
      } else if (milesUntil <= 500) {
        // Early warning within 500 miles
        upcoming.push({ ...item, milesUntil, nextDue, overdue: false });
      } else if (milesUntil <= item.interval * 0.2) {
        upcoming.push({ ...item, milesUntil, nextDue, overdue: false });
      }
    });
  }

  if (timeDue.length === 0 && timeUpcoming.length === 0 && due.length === 0 && upcoming.length === 0 && miIntervalDue.length === 0 && miIntervalWarn.length === 0) {
    container.style.display = mileage ? 'block' : 'none';
    if (mileage) list.innerHTML = '<p class="hint" style="margin:0;">✅ All services up to date!</p>';
    return;
  }

  container.style.display = 'block';
  let html = '';

  // Time-based items first
  if (timeDue.length > 0 || timeUpcoming.length > 0) {
    html += '<div class="rec-section-title">⏱ Time-Based</div>';
    timeDue.sort((a, b) => a.nextDueDate.localeCompare(b.nextDueDate));
    timeDue.forEach(s => {
      html += `<div class="rec-item rec-time rec-time-overdue">🗓️ <strong>${escapeHtml(s.service)}</strong> — <span class="text-danger">Overdue</span> · Was due ${s.nextDueDate} <span class="hint">(every ${s.label})</span></div>`;
    });
    timeUpcoming.sort((a, b) => a.daysUntil - b.daysUntil);
    timeUpcoming.forEach(s => {
      html += `<div class="rec-item rec-time rec-time-upcoming">🗓️ <strong>${escapeHtml(s.service)}</strong> — Due in ${s.daysUntil} day${s.daysUntil === 1 ? '' : 's'} <span class="hint">(every ${s.label})</span></div>`;
    });
  }

  // Custom mileage-interval items
  if (miIntervalDue.length > 0 || miIntervalWarn.length > 0) {
    html += '<div class="rec-section-title">🛣 Custom Mileage Intervals</div>';
    miIntervalDue.sort((a, b) => a.milesLeft - b.milesLeft);
    miIntervalDue.forEach(s => {
      const over = Math.abs(s.milesLeft).toLocaleString();
      html += `<div class="rec-item rec-overdue">🔧 <strong>${escapeHtml(s.service)}</strong> — <span class="text-danger">Overdue by ${over} mi</span> · Due at ${s.nextDueMileage.toLocaleString()} mi <span class="hint">(every ${s.intervalMiles.toLocaleString()} mi)</span></div>`;
    });
    miIntervalWarn.sort((a, b) => a.milesLeft - b.milesLeft);
    miIntervalWarn.forEach(s => {
      html += `<div class="rec-item rec-upcoming">⚠️ <strong>${escapeHtml(s.service)}</strong> — Due in ${s.milesLeft.toLocaleString()} mi · at ${s.nextDueMileage.toLocaleString()} mi <span class="hint">(every ${s.intervalMiles.toLocaleString()} mi)</span></div>`;
    });
  }

  // Standard mileage-based items
  if (due.length > 0 || upcoming.length > 0) {
    if (timeDue.length > 0 || timeUpcoming.length > 0 || miIntervalDue.length > 0 || miIntervalWarn.length > 0) html += '<div class="rec-section-title">📋 Standard Schedule</div>';
    due.sort((a, b) => a.milesUntil - b.milesUntil);
    upcoming.sort((a, b) => a.milesUntil - b.milesUntil);
    due.forEach(s => {
      const overMiles = Math.abs(s.milesUntil).toLocaleString();
      html += `<div class="rec-item rec-overdue">${s.icon} <strong>${escapeHtml(s.service)}</strong> — <span class="text-danger">Overdue by ${overMiles} mi</span> <span class="hint">(every ${s.interval.toLocaleString()} mi)</span></div>`;
    });
    upcoming.forEach(s => {
      const untilMiles = s.milesUntil.toLocaleString();
      const warnClass = s.milesUntil <= 500 ? 'rec-overdue' : 'rec-upcoming';
      const warnIcon = s.milesUntil <= 500 ? '⚠️' : s.icon;
      html += `<div class="rec-item ${warnClass}">${warnIcon} <strong>${escapeHtml(s.service)}</strong> — Due in ${untilMiles} mi <span class="hint">(every ${s.interval.toLocaleString()} mi)</span></div>`;
    });
  }

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
// PER-VEHICLE SCHEDULE EDITOR
// ================================================================

$('btn-edit-schedule').addEventListener('click', () => {
  if (!selectedVehicle) return;
  const schedule = getScheduleForVehicle(selectedVehicle);
  const container = $('schedule-items');

  container.innerHTML = schedule.map(item => {
    const defaultVal = MAINTENANCE_SCHEDULE.find(d => d.service === item.service).interval;
    const customVal = item.isCustom ? item.interval : '';
    return `
      <div class="schedule-row">
        <div class="schedule-label">${item.icon} ${escapeHtml(item.service)}</div>
        <div class="schedule-input-wrap">
          <input type="number" class="schedule-input" data-service="${escapeHtml(item.service)}"
            placeholder="${defaultVal.toLocaleString()}" value="${customVal}" min="500" max="999999"
            inputmode="numeric">
          <span class="schedule-unit">mi</span>
        </div>
      </div>`;
  }).join('');

  // Populate custom service rows from vehicle's customServices array
  const customServicesContainer = $('custom-schedule-rows');
  customServicesContainer.innerHTML = '';
  const existingCustom = (selectedVehicle.customServices) || [];
  existingCustom.forEach(cs => addCustomScheduleRow(cs.name, cs.interval));
  // If none, start with one blank row
  if (existingCustom.length === 0) addCustomScheduleRow('', '');

  $('schedule-editor').style.display = 'block';
  $('recommended-services').style.display = 'none';
});

function addCustomScheduleRow(name = '', interval = '') {
  const container = $('custom-schedule-rows');
  const row = document.createElement('div');
  row.className = 'schedule-row schedule-custom-row';
  row.innerHTML = `
    <input type="text" class="custom-service-name" placeholder="Service name (e.g. Detail, Inspect)" value="${escapeHtml(name)}" maxlength="80">
    <div class="schedule-input-wrap">
      <input type="number" class="custom-service-interval" placeholder="mi interval" value="${escapeHtml(String(interval))}" min="100" max="999999" inputmode="numeric">
      <span class="schedule-unit">mi</span>
    </div>
    <button type="button" class="btn btn-sm btn-danger btn-remove-custom-row" title="Remove">✕</button>
  `;
  row.querySelector('.btn-remove-custom-row').addEventListener('click', () => row.remove());
  container.appendChild(row);
}
window.addCustomScheduleRow = addCustomScheduleRow;

$('btn-add-custom-service').addEventListener('click', () => addCustomScheduleRow('', ''));

$('btn-close-schedule').addEventListener('click', () => {
  $('schedule-editor').style.display = 'none';
  if (selectedVehicle) updateRecommendedServices(selectedVehicle.id);
});

$('btn-save-schedule').addEventListener('click', async () => {
  if (!selectedVehicle) return;
  const inputs = $('schedule-items').querySelectorAll('.schedule-input');
  const customSchedule = {};

  inputs.forEach(input => {
    const service = input.dataset.service;
    const val = parseInt(input.value);
    if (val && val >= 500) {
      // Only store if different from default
      const def = MAINTENANCE_SCHEDULE.find(d => d.service === service);
      if (def && val !== def.interval) {
        customSchedule[service] = val;
      }
    }
  });

  // Collect custom service rows
  const customServices = [];
  $('custom-schedule-rows').querySelectorAll('.schedule-custom-row').forEach(row => {
    const nameInput = row.querySelector('.custom-service-name');
    const intervalInput = row.querySelector('.custom-service-interval');
    const name = nameInput ? nameInput.value.trim() : '';
    const interval = intervalInput ? parseInt(intervalInput.value) : 0;
    if (name && interval >= 100) {
      customServices.push({ name, interval });
    }
  });

  try {
    const updateData = { customSchedule };
    if (customServices.length > 0) {
      updateData.customServices = customServices;
    } else {
      updateData.customServices = firebase.firestore.FieldValue.delete();
    }
    await db.collection('vehicles').doc(selectedVehicle.id).update(updateData);
    selectedVehicle.customSchedule = customSchedule;
    selectedVehicle.customServices = customServices.length > 0 ? customServices : null;
    const cached = vehiclesCache.find(v => v.id === selectedVehicle.id);
    if (cached) {
      cached.customSchedule = customSchedule;
      cached.customServices = customServices.length > 0 ? customServices : null;
    }
    toast('Maintenance schedule saved!', 'success');
    $('schedule-editor').style.display = 'none';
    updateRecommendedServices(selectedVehicle.id);
  } catch (err) {
    console.error('Save schedule error:', err);
    toast('Failed to save schedule.', 'error');
  }
});

$('btn-reset-schedule').addEventListener('click', async () => {
  if (!selectedVehicle) return;
  try {
    await db.collection('vehicles').doc(selectedVehicle.id).update({
      customSchedule: firebase.firestore.FieldValue.delete()
    });
    selectedVehicle.customSchedule = null;
    const cached = vehiclesCache.find(v => v.id === selectedVehicle.id);
    if (cached) cached.customSchedule = null;
    toast('Schedule reset to defaults.', 'success');
    // Refresh the editor view
    $('btn-edit-schedule').click();
  } catch (err) {
    console.error('Reset schedule error:', err);
    toast('Failed to reset schedule.', 'error');
  }
});

// Show/hide maintenance form
$('btn-add-maintenance').addEventListener('click', () => {
  const wrap = $('maintenance-form-wrap');
  // Always show the form (use Cancel button to close)
  wrap.style.display = 'block';
  $('m-date').value = todayDateString();
  $('m-mileage').value = selectedVehicle && selectedVehicle.mileage ? selectedVehicle.mileage : '';
  $('m-interval').value = '';
  $('m-mile-interval').value = '';
  $('m-next-due-display').textContent = '—';
  $('m-next-due-mileage-display').textContent = '—';
  $('m-custom-row').style.display = 'none';
  $('m-custom-type').value = '';
  $('m-type').value = '';
  // Scroll into view so form is visible even when recommended services section is shown above it
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

$('btn-cancel-maintenance').addEventListener('click', () => {
  $('maintenance-form-wrap').style.display = 'none';
  $('maintenance-form').reset();
  $('m-next-due-display').textContent = '—';
  $('m-next-due-mileage-display').textContent = '—';
  $('m-custom-row').style.display = 'none';
});

// Save maintenance record
$('maintenance-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!selectedVehicle) return;

  const rawType = $('m-type').value;
  const customTypeName = $('m-custom-type').value.trim();
  const serviceType = rawType === 'Custom' ? (customTypeName || 'Custom Service') : rawType;
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

  if (!rawType || !date) {
    toast('Please select a service type and date.', 'warning');
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

    toast('Maintenance record saved!', 'success');
    $('maintenance-form-wrap').style.display = 'none';
    $('maintenance-form').reset();
    $('m-next-due-display').textContent = '—';
    $('m-next-due-mileage-display').textContent = '—';
    $('m-custom-row').style.display = 'none';
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
      html += `
        <div class="data-list-item">
          <div class="item-info">
            <div class="item-title">${escapeHtml(d.serviceType)}${intervalBadge}</div>
            <div class="item-subtitle">${escapeHtml(d.date)}${meta ? ' · ' + meta : ''}${nextDueStr}${nextDueMiStr}${d.notes ? ' — ' + escapeHtml(d.notes) : ''}</div>
          </div>
          ${canDelete ? `<div class="item-actions"><button class="btn btn-sm btn-danger" onclick="deleteMaintenanceRecord('${doc.id}')">Delete</button></div>` : ''}
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

// Current active tab in the task panel: 'all' | 'urgent' | 'scheduled' | 'monitoring'
let currentTaskTab = 'all';
// Cached items for re-filtering without refetch
let cachedTaskItems = [];
// Mailbox
let mailUnsubscribe = null;
// Time clock
let elapsedInterval = null;
let timeclockData = null;
const OWNER_EMAIL = 'mattaiscale@gmail.com';

window.switchTaskTab = function(tab) {
  currentTaskTab = tab;
  document.querySelectorAll('.task-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
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
    if (badgeEl) {
      badgeEl.textContent = items.length;
      badgeEl.classList.toggle('count-zero', items.length === 0);
      const hasUrgent = items.some(i => i.urgent);
      badgeEl.classList.toggle('has-urgent', hasUrgent);
    }
    if (tasksBtn) tasksBtn.style.display = '';

    // Sync vehicle-page task button badge
    const badgeVehicle = $('task-alert-count-vehicle');
    const tasksBtnVehicle = $('btn-tasks-vehicle');
    if (badgeVehicle) {
      badgeVehicle.textContent = items.length;
      badgeVehicle.classList.toggle('count-zero', items.length === 0);
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

  // Filter by current tab
  let items = allItems;
  if (currentTaskTab === 'urgent') {
    items = allItems.filter(i => i.urgent);
  } else if (currentTaskTab === 'scheduled') {
    items = allItems.filter(i => !i.urgent && i.taskStatus !== 'monitoring' && i.dueDate);
  } else if (currentTaskTab === 'monitoring') {
    items = allItems.filter(i => i.taskStatus === 'monitoring');
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
    const creatorLabel = item.createdByName ? ' · 👤 ' + escapeHtml(item.createdByName) : '';
    const dueLabelStr = item.dueDate ? ` · 📅 ${item.dueDate}` : '';

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
    return `
      <div class="followup-item-wrap" data-id="${item.id}" data-col="${item.collection}" data-due="${item.dueDate || ''}" data-vid-key="${item.vehicleId || ''}">
        <div class="swipe-action-bg"><span>📅</span>Reschedule</div>
        <div class="followup-item${extraClass}"${vidAttr}>
          <div class="followup-info">
            <div class="followup-text">${escapeHtml(item.text)}${urgentTag}</div>
            <div class="followup-meta">${metaLabel}${creatorLabel}${dueLabelStr}</div>
            ${statusBtns ? `<div class="task-status-btns">${statusBtns}</div>` : ''}
          </div>
          <div class="task-item-actions">
            ${completeBtn}
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
    await db.collection('vehicleNotes').doc(docId).update({
      done: true,
      completedBy: currentUser.uid,
      completedByName: currentUser.displayName || currentUser.email,
      completedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    toast('Task completed! ✓', 'success');
    loadDashboardFollowUps();
    if (selectedVehicle) loadVehicleNotes(selectedVehicle.id);
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
          <label class="note-followup-label">
            <input type="checkbox" id="ne-urgent" ${d.urgent ? 'checked' : ''}> 🚨 Urgent
          </label>
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
  overlay.querySelector('#btn-ne-cancel').onclick = () => overlay.remove();
  overlay.querySelector('#btn-ne-save').onclick = async () => {
    const isFollowUp = followupEl.checked;
    const urgent = isFollowUp && overlay.querySelector('#ne-urgent').checked;
    const dueDate = isFollowUp ? overlay.querySelector('#ne-due-date').value : '';
    const dueTime = isFollowUp ? overlay.querySelector('#ne-due-time').value : '';
    const updates = { isFollowUp, urgent };
    if (dueDate) { updates.dueDate = dueDate; }
    else { updates.dueDate = firebase.firestore.FieldValue.delete(); }
    if (dueTime) { updates.dueTime = dueTime; }
    else { updates.dueTime = firebase.firestore.FieldValue.delete(); }
    try {
      await db.collection(collection).doc(docId).update(updates);
      toast('Note updated!', 'success');
      overlay.remove();
      if (collection === 'vehicleNotes' && selectedVehicle) loadVehicleNotes(selectedVehicle.id);
      if (collection === 'generalNotes') loadGeneralNotes();
      loadDashboardFollowUps();
    } catch (err) {
      console.error('Note edit error:', err);
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
  const urgentItems = items.filter(i => i.urgent);

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

    html += `
      <div class="urgent-banner-item"${vidAttr}>
        <button class="followup-check" onclick="event.stopPropagation(); ${markFn}('${item.id}')" title="Mark done">&#9744;</button>
        <div class="urgent-banner-info">
          <div class="urgent-banner-text">${escapeHtml(item.text)}</div>
          <div class="urgent-banner-meta">${metaLabel} ${statusTag}</div>
        </div>
        ${reassignBtn}
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

  // Add Task form at top
  if (canAdd) {
    html += `
      <div class="cal-add-task-form">
        <h5>➕ Add Task for this date</h5>
        <textarea id="cal-add-task-text" class="note-textarea" placeholder="Enter task description..." maxlength="500" rows="2"></textarea>
        <div class="cal-add-task-controls">
          <input type="time" id="cal-add-task-time" class="cal-time-input" title="Set time (optional)">
          <label class="note-followup-label"><input type="checkbox" id="cal-add-task-urgent"> 🚨 Urgent</label>
          <button class="btn btn-sm btn-primary" onclick="calendarAddTask('${dateStr}')">Save Task</button>
        </div>
      </div>`;
  }

  // Partition tasks: timed vs all-day
  const timedTasks = tasks.filter(t => t.dueTime).sort((a, b) => a.dueTime.localeCompare(b.dueTime));
  const untimedTasks = tasks.filter(t => !t.dueTime).sort((a, b) => (b.urgent ? 1 : 0) - (a.urgent ? 1 : 0));

  // Hourly blocks 6 AM – 9 PM
  const HOUR_START = 6, HOUR_END = 21;
  const earlyTasks = timedTasks.filter(t => t.dueTime < '06:00');
  const lateTasks  = timedTasks.filter(t => t.dueTime >= '22:00');

  html += '<div class="hour-day-view">';

  // All-day section
  html += `<div class="hour-block hour-allday${untimedTasks.length ? ' hour-has-tasks' : ''}">`;
  html += '<div class="hour-label">All Day</div><div class="hour-tasks">';
  for (const item of untimedTasks) html += renderCalItem(item);
  html += '</div></div>';

  // Early tasks
  if (earlyTasks.length) {
    html += '<div class="hour-block hour-has-tasks"><div class="hour-label">Before<br>6 AM</div><div class="hour-tasks">';
    for (const item of earlyTasks) html += renderCalItem(item);
    html += '</div></div>';
  }

  // Hour slots
  for (let h = HOUR_START; h <= HOUR_END; h++) {
    const pad = String(h).padStart(2, '0');
    const nextPad = String(h + 1).padStart(2, '0');
    const label = h < 12 ? `${h}:00<br>AM` : h === 12 ? '12:00<br>PM' : `${h - 12}:00<br>PM`;
    const slotTasks = timedTasks.filter(t => t.dueTime >= `${pad}:00` && t.dueTime < `${nextPad}:00`);
    html += `<div class="hour-block${slotTasks.length ? ' hour-has-tasks' : ''}"><div class="hour-label">${label}</div><div class="hour-tasks">`;
    for (const item of slotTasks) html += renderCalItem(item);
    html += '</div></div>';
  }

  // Late tasks
  if (lateTasks.length) {
    html += '<div class="hour-block hour-has-tasks"><div class="hour-label">After<br>9 PM</div><div class="hour-tasks">';
    for (const item of lateTasks) html += renderCalItem(item);
    html += '</div></div>';
  }

  html += '</div>';

  if (tasks.length === 0 && !canAdd) {
    html += '<p class="hint">No tasks for this date.</p>';
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
  loadDashboardFollowUps();
  loadGeneralNotes();
}
function closeTaskPanel() {
  const panel = $('task-panel-overlay');
  if (panel) panel.style.display = 'none';
}
window.openTaskPanel = openTaskPanel;
window.closeTaskPanel = closeTaskPanel;

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
    <button class="task-ctx-item" id="ctx-vehicle">🚗 Go to Vehicle</button>
    <button class="task-ctx-item task-ctx-danger" id="ctx-delete">🗑️ Delete Task</button>
  `;
  document.body.appendChild(menu);

  // Position near the trigger button
  const rect = triggerBtn.getBoundingClientRect();
  const menuW = 210;
  let left = rect.left - menuW + rect.width;
  if (left < 8) left = 8;
  const top = rect.bottom + window.scrollY + 4;
  menu.style.top = top + 'px';
  menu.style.left = left + 'px';

  // Fetch doc to get current data for context
  async function getData() {
    const snap = await db.collection(col).doc(docId).get();
    return snap.exists ? snap.data() : null;
  }

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
      toast('No vehicle linked to this task.', 'info');
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
  overlay.querySelector('#btn-tfe-save').onclick = async () => {
    const newText = overlay.querySelector('#tfe-text').value.trim();
    if (!newText) { toast('Task text cannot be empty.', 'warning'); return; }
    const isFollowUp = overlay.querySelector('#tfe-followup').checked || overlay.querySelector('#tfe-urgent').checked;
    const urgent = overlay.querySelector('#tfe-urgent').checked;
    const dueDate = isFollowUp ? overlay.querySelector('#tfe-due-date').value : '';
    const dueTime = isFollowUp ? overlay.querySelector('#tfe-due-time').value : '';
    const updates = { text: newText, isFollowUp, urgent, taskStatus: urgent ? 'urgent' : 'scheduled' };
    if (dueDate) updates.dueDate = dueDate;
    else updates.dueDate = firebase.firestore.FieldValue.delete();
    if (dueTime) updates.dueTime = dueTime;
    else updates.dueTime = firebase.firestore.FieldValue.delete();
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

$('btn-save-general-note').addEventListener('click', async () => {
  const text = $('general-note-text').value.trim();
  if (!text) {
    toast('Enter a note first.', 'warning');
    return;
  }
  const isUrgent = $('general-note-urgent') ? $('general-note-urgent').checked : false;
  // Urgent notes are always treated as follow-ups
  const isFollowUp = $('general-note-followup').checked || isUrgent;
  const dueDate = isFollowUp ? ($('general-note-due-date').value || '') : '';

  try {
    const noteData = {
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
    await db.collection('generalNotes').add(noteData);
    $('general-note-text').value = '';
    $('general-note-followup').checked = false;
    if ($('general-note-urgent')) $('general-note-urgent').checked = false;
    $('general-note-due-date').value = '';
    $('general-note-due-row').style.display = 'none';
    if ($('general-note-urgent')) $('general-note-urgent').checked = false;
    toast(isFollowUp ? 'Follow-up added!' : 'Note saved!', 'success');
    loadGeneralNotes();
    if (isFollowUp || isUrgent) loadDashboardFollowUps();
  } catch (err) {
    console.error('Save general note error:', err);
    toast('Failed to save note.', 'error');
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

window.openMessage = async function(msgId) {
  try {
    await db.collection('messages').doc(msgId).update({ read: true });
    const el = $('mb-msg-' + msgId);
    if (el) el.classList.remove('mb-unread');
    updateMailBadge();
  } catch (e) { /* ignore */ }
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
  try {
    await db.collection('messages').add({
      from: currentUser.uid,
      fromName,
      to: toUid,
      toName,
      body: msgBody,
      sentAt: firebase.firestore.FieldValue.serverTimestamp(),
      read: false
    });
    body.value = '';
    sel.value = '';
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
      }, () => {
        // Fallback polling on listener error (e.g. missing composite index)
        updateMailBadge();
      });
  } catch (e) {
    updateMailBadge();
  }
}

// ================================================================
// TIME CLOCK WIDGET (Owner Only)
// ================================================================

function initTimeClock() {
  if (!currentUser || currentUser.email !== OWNER_EMAIL) return;
  const widget = $('time-clock-widget');
  if (widget) widget.style.display = '';
  loadTimeClock();
}

async function loadTimeClock() {
  if (!currentUser || currentUser.email !== OWNER_EMAIL) return;
  const today = todayDateString();
  const docId = currentUser.uid + '_' + today;
  try {
    const snap = await db.collection('timeclock').doc(docId).get();
    timeclockData = snap.exists ? snap.data() : null;
    renderTimeClock(timeclockData);
  } catch (e) {
    console.error('Load time clock error:', e);
  }
}

function renderTimeClock(data) {
  const content = $('time-clock-content');
  if (!content) return;
  const today = todayDateString();

  if (!data || !data.clockIn) {
    // Not clocked in
    const savedGoal = data && data.revenueGoal ? data.revenueGoal : '';
    content.innerHTML = `
      <div class="tc-status tc-status-out">
        <div class="tc-status-dot"></div>
        <div>
          <div class="tc-status-label">Not Clocked In</div>
          <div class="tc-date">${today}</div>
        </div>
      </div>
      <div class="tc-goal-row">
        <label class="tc-label">\ud83d\udcb0 Daily Revenue Goal</label>
        <div class="tc-input-row">
          <span class="tc-dollar">$</span>
          <input type="number" id="tc-goal-input" class="tc-input" min="0" step="100" placeholder="e.g. 2000" value="${savedGoal}">
        </div>
      </div>
      <button class="btn btn-primary tc-btn" onclick="clockIn()">\u23f1\ufe0f Clock In</button>
    `;
  } else if (data.clockIn && !data.clockOut) {
    // Currently clocked in
    const clockInTime = data.clockIn.toDate ? data.clockIn.toDate() : new Date(data.clockIn);
    const clockInStr = clockInTime.toLocaleTimeString('en-US', { timeZone: APP_TIMEZONE, hour: '2-digit', minute: '2-digit' });
    const goalStr = data.revenueGoal ? '$' + Number(data.revenueGoal).toLocaleString() : 'No goal set';
    content.innerHTML = `
      <div class="tc-status tc-status-in">
        <div class="tc-status-dot tc-dot-green"></div>
        <div>
          <div class="tc-status-label">Clocked In</div>
          <div class="tc-clock-time">Since ${clockInStr}</div>
        </div>
        <div class="tc-elapsed-badge" id="tc-elapsed">00:00:00</div>
      </div>
      <div class="tc-info-row">
        <span class="tc-label">Daily Goal:</span>
        <span class="tc-value tc-goal-val">${goalStr}</span>
      </div>
      <div class="tc-goal-row">
        <label class="tc-label">\ud83d\udcb0 Revenue Achieved Today</label>
        <div class="tc-input-row">
          <span class="tc-dollar">$</span>
          <input type="number" id="tc-achieved-input" class="tc-input" min="0" step="100" placeholder="0">
        </div>
      </div>
      <button class="btn btn-danger tc-btn" onclick="clockOut()">\u23f9\ufe0f Clock Out</button>
    `;
    startElapsedTimer(clockInTime);
  } else if (data.clockIn && data.clockOut) {
    // Clocked out — show summary
    const clockInTime = data.clockIn.toDate ? data.clockIn.toDate() : new Date(data.clockIn);
    const clockOutTime = data.clockOut.toDate ? data.clockOut.toDate() : new Date(data.clockOut);
    const msWorked = clockOutTime - clockInTime;
    const hh = Math.floor(msWorked / 3600000);
    const mm = Math.floor((msWorked % 3600000) / 60000);
    const hoursLabel = `${hh}h ${mm}m`;
    const inStr = clockInTime.toLocaleTimeString('en-US', { timeZone: APP_TIMEZONE, hour: '2-digit', minute: '2-digit' });
    const outStr = clockOutTime.toLocaleTimeString('en-US', { timeZone: APP_TIMEZONE, hour: '2-digit', minute: '2-digit' });
    const goalStr = data.revenueGoal ? '$' + Number(data.revenueGoal).toLocaleString() : '—';
    const achievedStr = (data.revenueAchieved !== null && data.revenueAchieved !== undefined) ? '$' + Number(data.revenueAchieved).toLocaleString() : '—';
    const pct = (data.revenueGoal && data.revenueAchieved !== undefined && data.revenueAchieved !== null)
      ? Math.round((data.revenueAchieved / data.revenueGoal) * 100) : null;
    const pctStr = pct !== null ? ` (${pct}%)` : '';
    const pctClass = pct === null ? '' : pct >= 100 ? 'tc-great' : pct >= 75 ? 'tc-good' : 'tc-low';
    content.innerHTML = `
      <div class="tc-summary-card">
        <div class="tc-summary-title">\ud83d\udccb Daily Summary — ${today}</div>
        <div class="tc-summary-row"><span>Clock In</span><span>${inStr}</span></div>
        <div class="tc-summary-row"><span>Clock Out</span><span>${outStr}</span></div>
        <div class="tc-summary-row"><span>Time Worked</span><span><strong>${hoursLabel}</strong></span></div>
        <div class="tc-summary-row"><span>Revenue Goal</span><span>${goalStr}</span></div>
        <div class="tc-summary-row ${pctClass}"><span>Revenue Achieved</span><span><strong>${achievedStr}${pctStr}</strong></span></div>
      </div>
      <button class="btn btn-outline tc-btn" style="margin-top:12px;" onclick="resetTimeClock()">\ud83d\udd04 Start New Session</button>
    `;
  }
}

function startElapsedTimer(clockInTime) {
  if (elapsedInterval) clearInterval(elapsedInterval);
  function update() {
    const el = $('tc-elapsed');
    if (!el) { clearInterval(elapsedInterval); elapsedInterval = null; return; }
    const elapsed = Date.now() - clockInTime.getTime();
    const h = Math.floor(elapsed / 3600000);
    const m = Math.floor((elapsed % 3600000) / 60000);
    const s = Math.floor((elapsed % 60000) / 1000);
    el.textContent = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }
  update();
  elapsedInterval = setInterval(update, 1000);
}

window.clockIn = async function() {
  if (!currentUser || currentUser.email !== OWNER_EMAIL) return;
  const today = todayDateString();
  const docId = currentUser.uid + '_' + today;
  const goalInput = $('tc-goal-input');
  const goal = goalInput ? parseFloat(goalInput.value) || 0 : 0;
  try {
    await db.collection('timeclock').doc(docId).set({
      uid: currentUser.uid,
      email: currentUser.email,
      date: today,
      clockIn: firebase.firestore.FieldValue.serverTimestamp(),
      revenueGoal: goal,
      clockOut: null,
      revenueAchieved: null
    });
    toast('Clocked in! ⏱️', 'success');
    await loadTimeClock();
  } catch (e) {
    console.error('Clock in error:', e);
    toast('Failed to clock in.', 'error');
  }
};

window.clockOut = async function() {
  if (!currentUser || currentUser.email !== OWNER_EMAIL) return;
  const today = todayDateString();
  const docId = currentUser.uid + '_' + today;
  const achievedInput = $('tc-achieved-input');
  const achieved = achievedInput ? parseFloat(achievedInput.value) || 0 : 0;
  try {
    await db.collection('timeclock').doc(docId).update({
      clockOut: firebase.firestore.FieldValue.serverTimestamp(),
      revenueAchieved: achieved
    });
    if (elapsedInterval) { clearInterval(elapsedInterval); elapsedInterval = null; }
    toast('Clocked out! ✅', 'success');
    await loadTimeClock();
  } catch (e) {
    console.error('Clock out error:', e);
    toast('Failed to clock out.', 'error');
  }
};

window.resetTimeClock = async function() {
  if (!currentUser || currentUser.email !== OWNER_EMAIL) return;
  const ok = await confirm('Reset Time Clock', 'Clear today\'s session and start fresh?');
  if (!ok) return;
  const today = todayDateString();
  const docId = currentUser.uid + '_' + today;
  try {
    await db.collection('timeclock').doc(docId).delete();
    timeclockData = null;
    renderTimeClock(null);
    toast('Time clock reset.', 'info');
  } catch (e) {
    toast('Failed to reset.', 'error');
  }
};
