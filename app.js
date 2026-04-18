// ================================================================
// Fleet Photo Manager - Main Application
// ================================================================

// --------------- FIREBASE INIT ---------------
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
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
// 1920px wide at 82% quality = ~300-600KB per photo (good detail for damage docs)
function compressImage(file, maxWidth = 1920, quality = 0.82) {
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
function compressBlob(blob, maxWidth = 1920, quality = 0.82) {
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

  // Check latest photo timestamp for each vehicle
  const now = Date.now();
  const checks = vehiclesCache.map(async (v) => {
    try {
      const photoSnap = await db.collection('photos')
        .where('vehicleId', '==', v.id)
        .orderBy('timestamp', 'desc')
        .limit(1)
        .get();
      if (photoSnap.empty) {
        v.lastPhotoAge = Infinity; // never photographed
      } else {
        const ts = photoSnap.docs[0].data().timestamp;
        v.lastPhotoAge = ts ? now - ts.toDate().getTime() : Infinity;
      }
    } catch (e) {
      v.lastPhotoAge = null; // unknown
    }
  });
  await Promise.all(checks);

  // Populate dashboard dropdown
  populateVehicleSelect($('vehicle-select'));
  // Populate admin dropdown
  populateVehicleSelect($('admin-vehicle-select'));
  // Update vehicle count badge
  const countEl = $('vehicle-count');
  if (countEl) countEl.textContent = vehiclesCache.length;
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

// Dashboard vehicle selection
$('vehicle-select').addEventListener('change', async function () {
  const vid = this.value;
  if (!vid) {
    $('vehicle-info').style.display = 'none';
    $('stale-alert').style.display = 'none';
    $('upload-section').style.display = 'none';
    $('recent-photos-section').style.display = 'none';
    selectedVehicle = null;
    return;
  }

  selectedVehicle = vehiclesCache.find(v => v.id === vid);
  $('vehicle-make-model').textContent = `${selectedVehicle.make} ${selectedVehicle.model}` +
    (selectedVehicle.year ? ` (${selectedVehicle.year})` : '') +
    (selectedVehicle.color ? ` - ${selectedVehicle.color}` : '');
  $('vehicle-info').style.display = 'flex';

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

  const canUpload = (currentUserRole === 'admin' || currentUserRole === 'manager');
  $('upload-section').style.display = canUpload ? 'block' : 'none';
  $('recent-photos-section').style.display = 'block';

  // Load today's photo count
  await loadTodayPhotos(vid);
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
      await uploadPhoto(compressed);

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
  await loadTodayPhotos(selectedVehicle.id);
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
      await uploadPhoto(blob);
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
    await loadTodayPhotos(selectedVehicle.id);
  }
});

// ================================================================
// TODAY'S PHOTOS
// ================================================================

async function loadTodayPhotos(vehicleId) {
  const today = todayDateString();
  const snapshot = await db.collection('photos')
    .where('vehicleId', '==', vehicleId)
    .where('date', '==', today)
    .orderBy('timestamp', 'desc')
    .get();

  const container = $('recent-photos');
  container.innerHTML = '';
  $('today-count').textContent = snapshot.size;
  $('vehicle-photo-count').textContent = `${snapshot.size} photos today`;

  if (snapshot.empty) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">📷</div><p>No photos yet today</p></div>';
    return;
  }

  snapshot.forEach(doc => {
    const data = doc.data();
    const item = document.createElement('div');
    item.className = 'photo-grid-item' + (data.protected ? ' photo-kept' : '');
    const keepBadge = data.protected ? '<div class="keep-badge">🔒</div>' : '';
    item.innerHTML = `
      ${keepBadge}
      <img src="${escapeHtml(data.url)}" alt="Vehicle photo" loading="lazy">
      <div class="photo-time">${data.timestamp ? formatTime(data.timestamp.toDate()) : ''}</div>
    `;
    item.addEventListener('click', () => openLightbox(data.url, `${data.plate} — ${data.date}`));
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
  const today = todayDateString();

  showLoading('Fetching photo list...');
  try {
    const snapshot = await db.collection('photos')
      .where('vehicleId', '==', vid)
      .where('date', '==', today)
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

    const zip = new JSZip();
    let count = 0;

    for (const photo of photos) {
      try {
        // Use XMLHttpRequest to handle cross-origin blob download
        const blob = await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.responseType = 'blob';
          xhr.onload = () => resolve(xhr.response);
          xhr.onerror = () => reject(new Error('XHR failed'));
          xhr.open('GET', photo.url);
          xhr.send();
        });
        count++;
        const ts = photo.timestamp
          ? photo.timestamp.toDate().toISOString().replace(/[:.]/g, '-')
          : String(count).padStart(3, '0');
        zip.file(`${label}_${today}_${ts}.jpg`, blob);
        showLoading(`Downloaded ${count} of ${photos.length}...`);
      } catch (dlErr) {
        console.error('Download error for photo:', dlErr);
      }
    }

    if (count === 0) {
      toast('Could not download any photos.', 'error');
      hideLoading();
      return;
    }

    showLoading('Creating ZIP file...');
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(zipBlob);
    a.download = `${label}_${today}_${count}-photos.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);

    toast(`ZIP with ${count} photos ready!`, 'success');
  } catch (err) {
    console.error('Download all error:', err);
    toast('Failed to download photos.', 'error');
  } finally {
    hideLoading();
  }
});

// ================================================================
// LIGHTBOX
// ================================================================

function openLightbox(url, info) {
  $('lightbox-img').src = url;
  $('lightbox-info').textContent = info;
  $('lightbox').style.display = 'flex';
}

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

$('btn-back-dashboard').addEventListener('click', () => {
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
  if (!st) return; // can't delete from storage without it

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const cutoffTimestamp = firebase.firestore.Timestamp.fromDate(cutoff);

  try {
    // Loop to handle more than 100 stale photos across multiple batches
    let totalDeleted = 0;
    let hasMore = true;

    while (hasMore) {
      const snapshot = await db.collection('photos')
        .where('protected', '!=', true)
        .where('timestamp', '<', cutoffTimestamp)
        .limit(100)
        .get();

      if (snapshot.empty) {
        hasMore = false;
        break;
      }

      const batch = db.batch();
      const storageDeletes = [];
      let batchCount = 0;

      snapshot.forEach(doc => {
        const data = doc.data();
        if (data.protected) return; // double-check

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

      // If we got fewer than 100, we're done
      if (snapshot.size < 100) hasMore = false;
    }

    if (totalDeleted > 0) {
      console.log(`Auto-cleanup: deleted ${totalDeleted} photos older than 30 days.`);
      toast(`Auto-cleanup: ${totalDeleted} old photo(s) removed.`, 'info');
    }
  } catch (err) {
    // Compound query may fail if index doesn't exist — fall back to simple query
    console.warn('Cleanup compound query failed, trying simple query:', err);
    try {
      await cleanupOldPhotosFallback(st, cutoffTimestamp);
    } catch (err2) {
      console.error('Auto-cleanup fallback error:', err2);
    }
  }
}

// Fallback that doesn't require a compound index
async function cleanupOldPhotosFallback(st, cutoffTimestamp) {
  const snapshot = await db.collection('photos')
    .where('timestamp', '<', cutoffTimestamp)
    .limit(200)
    .get();

  if (snapshot.empty) return;

  const batch = db.batch();
  const storageDeletes = [];
  let deletedCount = 0;

  snapshot.forEach(doc => {
    const data = doc.data();
    if (data.protected) return;

    batch.delete(doc.ref);
    if (data.storagePath) {
      storageDeletes.push(
        st.ref(data.storagePath).delete().catch(err => {
          console.warn('Cleanup storage delete failed:', data.storagePath, err);
        })
      );
    }
    deletedCount++;
  });

  if (deletedCount > 0) {
    await batch.commit();
    await Promise.all(storageDeletes);
    console.log(`Auto-cleanup (fallback): deleted ${deletedCount} photos older than 30 days.`);
    toast(`Auto-cleanup: ${deletedCount} old photo(s) removed.`, 'info');
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
// INIT - Set today's date as default in admin date filter
// ================================================================
$('admin-date-filter').value = todayDateString();
