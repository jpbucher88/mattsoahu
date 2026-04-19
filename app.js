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
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function formatTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function sanitizePlate(plate) {
  // Normalize plate to alphanumeric + hyphens for use as folder names
  return plate.replace(/[^a-zA-Z0-9-]/g, '_').toUpperCase();
}

// Compress image before upload
// 2560px wide at 92% quality = ~500KB-1.2MB per photo (high detail for damage docs)
function compressImage(file, maxWidth = 2560, quality = 0.92) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
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
          resolve(new File([blob], file.name || 'photo.jpg', { type: 'image/jpeg', lastModified: Date.now() }));
        }, 'image/jpeg', quality);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// Compress a blob directly (used by the in-browser camera)
function compressBlob(blob, maxWidth = 2560, quality = 0.92) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
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
      canvas.toBlob((result) => resolve(result), 'image/jpeg', quality);
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
    } catch (err) {
      console.error('Auth state error:', err);
      toast('Error loading profile', 'error');
    } finally {
      hideLoading();
    }
  } else {
    currentUser = null;
    currentUserRole = null;
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
          const lastMi = lastServices[item.service] || 0;
          if (lastMi + item.interval - v.mileage <= 0) v.overdueCount++;
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
  let html = '';
  vehiclesCache.forEach(v => {
    // Photo status
    let photoStatus, photoCls;
    if (v.lastPhotoAge === Infinity || v.lastPhotoAge == null) {
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
    html += `<div class="fleet-card${needsPhotos ? ' fleet-card-alert' : ''}" data-vid="${v.id}">
      ${needsPhotos ? '<span class="fleet-card-badge">⚠️</span>' : ''}
      <div class="fleet-card-title">${escapeHtml(v.plate)}</div>
      <div class="fleet-card-subtitle">${escapeHtml(v.make)} ${escapeHtml(v.model)}</div>
      <div class="fleet-card-status ${photoCls}">${photoStatus}</div>
      <div class="fleet-card-status ${maintCls}">${maintStatus}</div>
    </div>`;
  });
  container.innerHTML = html;

  // Click a card to navigate to vehicle detail page
  container.querySelectorAll('.fleet-card').forEach(card => {
    card.addEventListener('click', () => {
      openVehiclePage(card.dataset.vid);
    });
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
      hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true
    });
    lastPhotoEl.style.display = 'block';
  } else if (selectedVehicle.lastPhotoAge === Infinity) {
    lastPhotoEl.textContent = '📷 No photos taken yet';
    lastPhotoEl.style.display = 'block';
  } else {
    lastPhotoEl.style.display = 'none';
  }

  // Show stale photo alert
  const MS_24H = 24 * 60 * 60 * 1000;
  const staleAlert = $('stale-alert');
  if (selectedVehicle.lastPhotoAge != null && selectedVehicle.lastPhotoAge > MS_24H) {
    if (selectedVehicle.lastPhotoAge === Infinity) {
      staleAlert.textContent = '\u26A0\uFE0F No photos have been taken for this vehicle.';
    } else {
      const hoursAgo = Math.floor(selectedVehicle.lastPhotoAge / (1000 * 60 * 60));
      const daysAgo = Math.floor(hoursAgo / 24);
      const ageText = daysAgo > 0 ? `${daysAgo}d ${hoursAgo % 24}h ago` : `${hoursAgo}h ago`;
      staleAlert.textContent = `\u26A0\uFE0F Last photo was ${ageText} \u2014 photos may be outdated.`;
    }
    staleAlert.style.display = 'block';
  } else {
    staleAlert.style.display = 'none';
  }

  // Role-gate upload and maintenance
  const canUpload = (currentUserRole === 'admin' || currentUserRole === 'manager');
  $('upload-section').style.display = canUpload ? 'block' : 'none';
  $('recent-photos-section').style.display = 'block';
  $('maintenance-section').style.display = 'block';

  const canMaintain = (currentUserRole === 'admin' || currentUserRole === 'manager');
  $('btn-add-maintenance').style.display = canMaintain ? '' : 'none';
  $('mileage-edit-row').style.display = canMaintain ? '' : 'none';

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
}

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
  const ocrBlobs = [];
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
      ocrBlobs.push(compressed);
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

  // Auto-scan uploaded photos for odometer reading
  if (ocrBlobs.length > 0 && selectedVehicle) {
    autoScanForMileage(ocrBlobs);
  }
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
let cameraShotCount = 0;
let cameraUploadQueue = [];
let cameraUploading = false;
let cameraUploadedCount = 0;
let cameraTotalQueued = 0;
let cameraUploadedUrls = [];
let cameraOcrBlobs = [];

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
  cameraOcrBlobs = [];
  $('camera-thumbs').innerHTML = '';
  $('camera-count').textContent = '0 photos';
  $('camera-upload-bar').style.display = 'none';
  $('camera-overlay').style.display = 'flex';

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
  // Fall back step by step if the device doesn't support it
  let stream = null;
  const attempts = [
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

  // Force zoom to 1x (minimum) on supported devices
  const [track] = cameraStream.getVideoTracks();
  if (track && track.getCapabilities) {
    try {
      const caps = track.getCapabilities();
      const advanced = [];
      if (caps.zoom) {
        advanced.push({ zoom: caps.zoom.min });
      }
      // Some Android devices expose torch — ignore, just set zoom
      if (advanced.length) {
        await track.applyConstraints({ advanced });
      }
    } catch (e) { /* zoom not supported — ok */ }
  }

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
      cameraOcrBlobs.push(blob);
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

    // Auto-scan camera photos for odometer reading
    if (cameraOcrBlobs.length > 0) {
      autoScanForMileage(cameraOcrBlobs);
    }
  }
});

// ================================================================
// PHOTO DATE NAVIGATION
// ================================================================

function formatDisplayDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const opts = { weekday: 'short', month: 'short', day: 'numeric' };
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
  selectedDate = dt.toISOString().slice(0, 10);
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
    const newRef = nd.toISOString().slice(0, 10);
    loadPhotoDates(selectedVehicle.id, newRef);
  });
  if (nextBtn) nextBtn.addEventListener('click', () => {
    const nd = new Date(y, m, 1);
    const newRef = nd.toISOString().slice(0, 10);
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
    item.innerHTML = `
      ${keepBadge}
      <img src="${escapeHtml(data.url)}" alt="Vehicle photo" loading="lazy">
      <div class="photo-time">${data.timestamp ? formatTime(data.timestamp.toDate()) : ''}</div>
    `;
    item.querySelector('img').addEventListener('click', () => openLightbox(data.url, `${data.plate} — ${data.date}`));
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
        const resp = await fetch(photo.url);
        if (!resp.ok) throw new Error('fetch ' + resp.status);
        const buf = await resp.arrayBuffer();
        count++;
        const ts = photo.timestamp
          ? photo.timestamp.toDate().toISOString().replace(/[:.]/g, '-')
          : String(count).padStart(3, '0');
        const fileName = `${label}_${today}_${ts}.jpg`;
        files.push({ name: fileName, buf });
        showLoading(`Downloaded ${count} of ${photos.length}...`);
      } catch (dlErr) {
        console.error('Download error for photo:', photo.url, dlErr);
      }
    }

    if (files.length === 0) {
      toast('Could not download any photos.', 'error');
      hideLoading();
      return;
    }

    // Mobile: use Web Share API to save to camera roll / share
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    if (isMobile && navigator.canShare) {
      const shareFiles = files.map(f => new File([f.buf], f.name, { type: 'image/jpeg' }));
      if (navigator.canShare({ files: shareFiles })) {
        hideLoading();
        try {
          await navigator.share({ files: shareFiles, title: `${label} photos` });
          toast(`${files.length} photos shared!`, 'success');
        } catch (shareErr) {
          if (shareErr.name !== 'AbortError') {
            toast('Share cancelled or failed.', 'warning');
          }
        }
        return;
      }
    }

    // Desktop: bundle into ZIP
    showLoading('Creating ZIP file...');
    const zip = new JSZip();
    for (const f of files) {
      zip.file(f.name, new Uint8Array(f.buf));
    }
    const zipBlob = await zip.generateAsync({ type: 'blob', mimeType: 'application/zip' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(zipBlob);
    a.download = `${label}_${today}_${files.length}-photos.zip`;
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

// Save a single photo — share sheet on mobile, direct download on desktop
async function saveOnePhoto(url, name) {
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('fetch ' + resp.status);
    const blob = await resp.blob();
    const fileName = name.replace(/\s+/g, '_') + '.jpg';

    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    if (isMobile && navigator.canShare) {
      const file = new File([blob], fileName, { type: 'image/jpeg' });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file] });
        return;
      }
    }

    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error('Save photo error:', err);
    toast('Could not save photo.', 'error');
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
    await db.collection('vehicles').add({
      plate, make, model, year, color,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      createdBy: currentUser.uid,
    });
    toast(`Vehicle ${plate} added!`, 'success');
    $('add-vehicle-form').reset();
    await loadVehicles();
    loadAdminVehicles();
  } catch (err) {
    console.error('Add vehicle error:', err);
    toast('Failed to add vehicle.', 'error');
  } finally {
    hideLoading();
  }
});

function loadAdminVehicles() {
  const list = $('vehicles-list');
  $('vehicle-count').textContent = vehiclesCache.length;

  // Populate hero image vehicle dropdown
  populateVehicleSelect($('hero-vehicle-select'));

  if (!vehiclesCache.length) {
    list.innerHTML = '<div class="empty-state"><div class="empty-icon">🚗</div><p>No vehicles added yet</p></div>';
    return;
  }

  list.innerHTML = vehiclesCache.map(v => `
    <div class="data-list-item">
      <div class="item-info">
        <div class="item-title">${escapeHtml(v.plate)}</div>
        <div class="item-subtitle">${escapeHtml(v.make)} ${escapeHtml(v.model)}${v.year ? ` (${v.year})` : ''}${v.color ? ` - ${escapeHtml(v.color)}` : ''}</div>
      </div>
      <div class="item-actions">
        <button class="btn btn-sm btn-danger" onclick="deleteVehicle('${v.id}', '${escapeHtml(v.plate)}')">Delete</button>
      </div>
    </div>
  `).join('');
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
// ADMIN: DEFAULT VEHICLE IMAGE
// ================================================================

$('hero-image-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  const previewWrap = $('hero-preview-wrap');
  const previewImg = $('hero-preview-img');
  const uploadBtn = $('btn-upload-hero');

  if (file) {
    previewImg.src = URL.createObjectURL(file);
    previewWrap.style.display = 'block';
    uploadBtn.disabled = !$('hero-vehicle-select').value;
  } else {
    previewWrap.style.display = 'none';
    uploadBtn.disabled = true;
  }
});

$('hero-vehicle-select').addEventListener('change', () => {
  const hasFile = $('hero-image-input').files.length > 0;
  $('btn-upload-hero').disabled = !($('hero-vehicle-select').value && hasFile);
});

$('btn-upload-hero').addEventListener('click', async () => {
  if (currentUserRole !== 'admin') return;
  const vehicleId = $('hero-vehicle-select').value;
  const file = $('hero-image-input').files[0];
  if (!vehicleId || !file) return;

  const vehicle = vehiclesCache.find(v => v.id === vehicleId);
  if (!vehicle) return;

  showLoading('Uploading default photo…');
  try {
    const st = getStorage();
    if (!st) throw new Error('Storage not available');

    // Resize image before upload
    const resized = await compressImage(file, 2560, 0.92);

    const storagePath = `vehicles/${vehicleId}/default-image.jpg`;
    const ref = st.ref(storagePath);
    await ref.put(resized, { contentType: 'image/jpeg' });
    const downloadURL = await ref.getDownloadURL();

    // Save URL to vehicle document
    await db.collection('vehicles').doc(vehicleId).update({
      defaultImageUrl: downloadURL,
      defaultImagePath: storagePath
    });

    // Update cache
    vehicle.defaultImageUrl = downloadURL;
    const cached = vehiclesCache.find(v => v.id === vehicleId);
    if (cached) cached.defaultImageUrl = downloadURL;

    toast(`Default photo set for ${vehicle.plate}!`, 'success');
    $('hero-image-input').value = '';
    $('hero-preview-wrap').style.display = 'none';
    $('btn-upload-hero').disabled = true;
  } catch (err) {
    console.error('Upload hero image error:', err);
    toast('Failed to upload default photo.', 'error');
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

  if (!mileage) {
    container.style.display = 'none';
    return;
  }

  // Get last service mileage for each type
  const lastServices = {};
  try {
    const snap = await db.collection('maintenance')
      .where('vehicleId', '==', vehicleId)
      .orderBy('mileage', 'desc')
      .get();
    snap.forEach(doc => {
      const d = doc.data();
      if (d.serviceType && !lastServices[d.serviceType]) {
        lastServices[d.serviceType] = d.mileage || 0;
      }
    });
  } catch (e) {
    console.warn('Could not load maintenance for recommendations:', e);
  }

  const due = [];
  const upcoming = [];

  MAINTENANCE_SCHEDULE.forEach(item => {
    const lastMi = lastServices[item.service] || 0;
    const nextDue = lastMi + item.interval;
    const milesUntil = nextDue - mileage;

    if (milesUntil <= 0) {
      due.push({ ...item, milesUntil, nextDue, overdue: true });
    } else if (milesUntil <= item.interval * 0.2) {
      upcoming.push({ ...item, milesUntil, nextDue, overdue: false });
    }
  });

  if (due.length === 0 && upcoming.length === 0) {
    container.style.display = 'block';
    list.innerHTML = '<p class="hint" style="margin:0;">✅ All services up to date!</p>';
    return;
  }

  container.style.display = 'block';
  let html = '';
  due.sort((a, b) => a.milesUntil - b.milesUntil);
  upcoming.sort((a, b) => a.milesUntil - b.milesUntil);

  due.forEach(s => {
    const overMiles = Math.abs(s.milesUntil).toLocaleString();
    html += `<div class="rec-item rec-overdue">${s.icon} <strong>${escapeHtml(s.service)}</strong> — <span class="text-danger">Overdue by ${overMiles} mi</span> <span class="hint">(every ${s.interval.toLocaleString()} mi)</span></div>`;
  });
  upcoming.forEach(s => {
    const untilMiles = s.milesUntil.toLocaleString();
    html += `<div class="rec-item rec-upcoming">${s.icon} <strong>${escapeHtml(s.service)}</strong> — Due in ${untilMiles} mi <span class="hint">(every ${s.interval.toLocaleString()} mi)</span></div>`;
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
  } catch (err) {
    console.error('Save mileage error:', err);
    toast('Failed to save mileage.', 'error');
  }
});

// ================================================================
// AUTO MILEAGE OCR — scans uploaded photos for odometer reading
// ================================================================

// Score a candidate number to determine how likely it is to be an odometer reading
function scoreOdometerCandidate(value, rawText, fullText, currentMileage) {
  let score = 0;
  const raw = rawText.trim();
  const digitCount = raw.replace(/[^0-9]/g, '').length;

  // --- HARD REJECT ---
  // Time-like patterns: 12:34, 3:45
  if (/^\d{1,2}:\d{2}$/.test(raw)) return -1000;
  // Radio frequencies: like 88.1, 101.5
  if (value >= 80 && value <= 110 && /\d+\.\d/.test(raw)) return -1000;

  // --- SOFT PENALTIES (can still win with enough boost) ---
  // Speedometer markings: small round numbers (20–300 in multiples of 20)
  if (value <= 300 && value % 20 === 0) score -= 100;
  // RPM zone: 1000-8000 in round thousands
  if (value >= 1000 && value <= 8000 && value % 1000 === 0) score -= 60;
  // Very small numbers
  if (value < 1000) score -= 80;

  // --- BOOST likely odometer numbers ---
  // 5-6 digit numbers are classic odometer readings
  if (digitCount >= 6) score += 80;
  else if (digitCount === 5) score += 60;
  else if (digitCount === 4) score += 20;

  // Numbers with commas in right places (e.g. 114,023)
  if (/^\d{1,3},\d{3}$/.test(raw) || /^\d{1,3},\d{3},\d{3}$/.test(raw)) score += 50;

  // Nearby odometer keywords
  const fullLower = fullText.toLowerCase();
  if (/odo|mileage|total\s*mi|miles?\b/.test(fullLower)) score += 40;
  if (/\bkm\b|kilometers|kilometres/.test(fullLower)) score += 30;

  // Penalize if near speed-related words
  if (/mph|km\/h|kmh|speed|rpm|tach/i.test(fullLower)) score -= 30;

  // If we have a current mileage, prefer numbers in the ballpark
  if (currentMileage && currentMileage > 0) {
    const pctDiff = Math.abs(value - currentMileage) / currentMileage;
    if (pctDiff < 0.05) score += 100;
    else if (pctDiff < 0.10) score += 70;
    else if (pctDiff < 0.20) score += 40;
    else if (pctDiff < 0.50) score += 10;
  }

  // Prefer values in the typical car odometer range (5k–300k)
  if (value >= 5000 && value <= 300000) score += 30;
  if (value >= 10000 && value <= 200000) score += 20;

  return score;
}

// Preprocess image for OCR with multiple strategies
function preprocessForOCR(blob, strategy) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);

      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;

      if (strategy === 'grayscale') {
        // Simple grayscale with mild contrast boost
        for (let i = 0; i < data.length; i += 4) {
          let gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          gray = ((gray - 128) * 1.5) + 128;
          gray = Math.max(0, Math.min(255, gray));
          data[i] = data[i + 1] = data[i + 2] = gray;
        }
      } else if (strategy === 'invert') {
        // Inverted grayscale — helps with light text on dark backgrounds
        for (let i = 0; i < data.length; i += 4) {
          let gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          data[i] = data[i + 1] = data[i + 2] = 255 - gray;
        }
      } else if (strategy === 'threshold') {
        // High-contrast B&W with moderate threshold
        for (let i = 0; i < data.length; i += 4) {
          let gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          data[i] = data[i + 1] = data[i + 2] = gray > 100 ? 255 : 0;
        }
      }

      ctx.putImageData(imageData, 0, 0);
      canvas.toBlob((processedBlob) => {
        URL.revokeObjectURL(img.src);
        resolve(processedBlob);
      }, 'image/png');
    };
    img.src = URL.createObjectURL(blob);
  });
}

// Persistent OCR worker — created once, reused across scans
let ocrWorker = null;

async function getOCRWorker() {
  if (!ocrWorker) {
    ocrWorker = await Tesseract.createWorker('eng');
    await ocrWorker.setParameters({
      tessedit_char_whitelist: '0123456789,. ',
    });
  }
  return ocrWorker;
}

async function autoScanForMileage(blobs) {
  if (!blobs.length || !selectedVehicle) return;
  const statusEl = $('ocr-status');
  statusEl.style.display = 'block';
  statusEl.style.color = '';
  statusEl.textContent = '🔍 Scanning photos for odometer…';

  const currentMileage = selectedVehicle.mileage || 0;
  let bestReading = null;
  let bestScore = -Infinity;

  let worker;
  try {
    worker = await getOCRWorker();
  } catch (err) {
    console.error('[OCR] Failed to create worker:', err);
    statusEl.textContent = '❌ OCR engine failed to load.';
    statusEl.style.color = '#dc2626';
    setTimeout(() => { statusEl.style.display = 'none'; statusEl.style.color = ''; }, 8000);
    return;
  }

  const strategies = ['original', 'grayscale', 'invert', 'threshold'];

  for (let i = 0; i < blobs.length; i++) {
    for (const strategy of strategies) {
      statusEl.textContent = `🔍 Scanning photo ${i + 1}/${blobs.length} (${strategy})…`;
      try {
        let scanBlob;
        if (strategy === 'original') {
          scanBlob = blobs[i];
        } else {
          scanBlob = await preprocessForOCR(blobs[i], strategy);
        }

        const objUrl = URL.createObjectURL(scanBlob);
        const { data: { text } } = await worker.recognize(objUrl);
        URL.revokeObjectURL(objUrl);
        console.log(`[OCR] Photo ${i + 1} [${strategy}] text:`, text);

        // Extract all number-like sequences
        const matches = text.match(/\d[\d,.\s]{1,}/g);
        if (!matches) continue;

        for (const raw of matches) {
          const digits = raw.replace(/[^0-9]/g, '');
          if (digits.length < 3 || digits.length > 7) continue;
          const cleaned = parseInt(digits, 10);
          if (isNaN(cleaned) || cleaned < 100 || cleaned > 999999) continue;

          const score = scoreOdometerCandidate(cleaned, raw, text, currentMileage);
          console.log(`[OCR] [${strategy}] Candidate:`, raw.trim(), '→', cleaned, 'score:', score);
          if (score > bestScore) {
            bestScore = score;
            bestReading = cleaned;
          }
        }
      } catch (err) {
        console.warn(`[OCR] ${strategy} failed for photo ${i + 1}:`, err);
      }
    }
  }

  console.log('[OCR] Best reading:', bestReading, 'score:', bestScore);

  if (bestReading && bestScore >= 0) {
    $('vehicle-mileage').value = bestReading;
    statusEl.textContent = `✅ Odometer detected: ${bestReading.toLocaleString()} — verify and tap Update`;
    statusEl.style.color = '#16a34a';
  } else {
    statusEl.textContent = '📷 No odometer reading detected in photos.';
    statusEl.style.color = '#6b7280';
  }

  // Auto-hide after 12 seconds
  setTimeout(() => {
    statusEl.style.display = 'none';
    statusEl.style.color = '';
  }, 12000);
}

// Show/hide maintenance form
$('btn-add-maintenance').addEventListener('click', () => {
  const wrap = $('maintenance-form-wrap');
  wrap.style.display = wrap.style.display === 'none' ? 'block' : 'none';
  $('m-date').value = todayDateString();
  $('m-mileage').value = selectedVehicle && selectedVehicle.mileage ? selectedVehicle.mileage : '';
});

$('btn-cancel-maintenance').addEventListener('click', () => {
  $('maintenance-form-wrap').style.display = 'none';
  $('maintenance-form').reset();
});

// Save maintenance record
$('maintenance-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!selectedVehicle) return;

  const serviceType = $('m-type').value;
  const date = $('m-date').value;
  const mileage = $('m-mileage').value ? parseInt($('m-mileage').value) : null;
  const cost = $('m-cost').value ? parseFloat($('m-cost').value) : null;
  const notes = $('m-notes').value.trim();
  const location = $('m-location').value.trim();

  if (!serviceType || !date) {
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
    await db.collection('maintenance').add(record);

    // Auto-update vehicle mileage if higher
    if (mileage && (!selectedVehicle.mileage || mileage > selectedVehicle.mileage)) {
      await db.collection('vehicles').doc(selectedVehicle.id).update({ mileage });
      selectedVehicle.mileage = mileage;
      const cached = vehiclesCache.find(v => v.id === selectedVehicle.id);
      if (cached) cached.mileage = mileage;
      $('vehicle-mileage').value = mileage;
    }

    toast('Maintenance record saved!', 'success');
    $('maintenance-form-wrap').style.display = 'none';
    $('maintenance-form').reset();
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
      html += `
        <div class="data-list-item">
          <div class="item-info">
            <div class="item-title">${escapeHtml(d.serviceType)}</div>
            <div class="item-subtitle">${escapeHtml(d.date)}${meta ? ' · ' + meta : ''}${d.notes ? ' — ' + escapeHtml(d.notes) : ''}</div>
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
    await db.collection('maintenance').doc(docId).delete();
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
// INIT - Set today's date as default in admin date filter
// ================================================================
$('admin-date-filter').value = todayDateString();
