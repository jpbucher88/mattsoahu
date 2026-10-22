# Fleet Photo Manager - Setup Guide

A mobile-first web app for car rental companies to photograph and document vehicle conditions. Built with Firebase (Auth, Firestore, Storage).

---

## Features

- **Login/Auth** — Only registered users can access the app
- **Role-based access**:
  - **Admin** — Full access: manage vehicles, manage users, view/delete photos
  - **User** — Can only select a vehicle and upload photos
- **Camera integration** — Take photos directly from your phone's camera within the app
- **Auto-upload** — Photos upload automatically to the correct vehicle/date folder in Firebase Storage
- **Photo browsing** — View today's photos per vehicle, full-screen lightbox viewer
- **Admin panel** — Add/remove vehicles, browse & bulk-delete photos, create/manage users

---

## Photo Evidence Metadata

Turo's fuel reimbursement guidance requires trip photos with date, time, and
geolocation metadata: https://help.turo.com/charging-for-missing-fuel-or-low-battery-S1d_r4xV5

The app's camera records the shutter time with a UTC timezone offset and a fresh
device-provided GPS location in JPEG EXIF when available. Camera permission is
required; GPS is optional so a location failure does not stop fleet photography.
Camera buttons on inspection and expense forms use this same camera.
Use a supported HTTPS browser such as current iOS Safari or Android Chrome.

Photo imports with missing capture time or GPS are accepted with a warning.
Upload time and file modification time are never substituted for a missing
capture time. The camera offers Skip GPS and a confirmation after a failed GPS
request; bypass applies only to that camera session. New camera captures retain
their actual shutter time even without GPS, and no location is invented.
Fleet photo records flag missing metadata for later review. Photos without GPS
may not satisfy Turo fuel reimbursement requirements; keep complete original
evidence for claims whenever possible.
Compression and queued uploads preserve the original EXIF capture fields and GPS;
JPEG downloads retain the original file bytes.

This does not guarantee Turo acceptance or verify the device clock or GPS
accuracy. Photos already stored without metadata cannot be repaired automatically.
Physical iPhone and Android testing with real downloaded files remains necessary.

Run the metadata regression checks with `node --test photo-metadata.test.cjs`.

## Inspection Planning

Bi-monthly inspections retain their existing 21 pass/fail checkpoints. Notes can
be added to passing checkpoints and to the overall inspection. Cleanliness,
battery age/date, and oil/coolant observations are recorded separately.

Choose Future / monitor, Needs attention now, or Record only for observations.
Actionable notes create linked work orders in the Maintenance Dashboard, not
Home's urgent invoice queue. The Maintenance Work Queue separates Action now,
Planned work / monitor, and Assessments, with an optional All work view.
Planned work has distinct-plate category counts, including Detailing, and retains
the existing scheduling and close-out controls. Target dates remain planning
targets: they do not automatically make a road-ready vehicle a red repair alert.
Use the existing priority editor to explicitly move a planned job to current work.

Inspection reminders show their next assessment date and a Run Assessment action,
not Schedule Repair. The Assessments Due tile counts reminders due today or
overdue. Upcoming assessments and planned work do not inflate the red repair
count or block Fleet Ready. Real failures and the existing compliance warnings
remain visible; counts in the summary tiles represent distinct plates.

Detailing jobs default to Monitor. Other noncritical jobs entered from the
Planned Work view also default to Monitor; safety-critical category suggestions
are preserved. Older reminders are classified on read without data migration.

Work orders use the existing scheduling, assignment, timeline, and close-out
controls. Re-saving an inspection updates the same work-order IDs and preserves
completed work. Selecting Record only cancels an open linked follow-up without
deleting the inspection; selecting follow-up again reopens that canceled task.
Older record-only notes are not migrated or converted automatically.

Run inspection and photo regression checks with
`node --test inspection-followups.test.cjs photo-metadata.test.cjs`.

## Compliance Moves

Compliance remains part of the red attention total. Action now shows the counted
compliance vehicles individually, with Safety, Registration, or Insurance reasons;
vehicles with both repairs and compliance are counted once in the red total.

Managers and admins can select Schedule Move from Compliance or its Action now
cards. The existing Vehicle Moves form preselects the vehicle and includes
compliance context. Compliance rows and the move preview display the home location,
home/trip/shop status, and available trip return estimate. Existing active
compliance moves can be reopened rather than duplicated.

An on-trip compliance vehicle requires an appointment date no earlier than its
known return date. Dates have day-level precision; staff must coordinate the
appointment time with the displayed return time. Future or still-on-trip moves
remain pending and show as Scheduled in Vehicle Moves. Completing a move does not
renew or clear compliance: the actual compliance record must still be updated.

## Prerequisites

1. A **Firebase project** (free Spark plan works for getting started)
2. A web hosting service (Firebase Hosting is recommended)

---

## Step 1: Firebase Project Setup

### 1.1 Create or open your Firebase project

Go to [Firebase Console](https://console.firebase.google.com/) and open your project.

### 1.2 Enable Authentication

1. Go to **Authentication** > **Sign-in method**
2. Enable **Email/Password** provider
3. Click **Save**

### 1.3 Create Firestore Database

1. Go to **Firestore Database** > **Create database**
2. Choose **Start in production mode**
3. Select a location closest to you
4. Once created, go to the **Rules** tab and paste the Firestore rules from `firebase-rules.js`

### 1.4 Enable Storage

1. Go to **Storage** > **Get started**
2. Choose **Start in production mode**
3. Once created, go to the **Rules** tab and paste the Storage rules from `firebase-rules.js`

### 1.5 Create Firestore Indexes

Go to **Firestore Database** > **Indexes** > **Composite** > **Create index**:

**Index 1:**
- Collection: `photos`
- Fields: `vehicleId` Ascending, `date` Ascending, `timestamp` Descending
- Query scope: Collection

**Index 2:**
- Collection: `photos`
- Fields: `vehicleId` Ascending, `timestamp` Descending
- Query scope: Collection

> **Note:** Firebase may auto-prompt you to create these indexes when you first use the app. You'll see a link in the browser console error that creates the index for you.

### 1.6 Get your Firebase Config

1. Go to **Project Settings** (gear icon) > **General**
2. Scroll to **Your apps** > click **Web** icon (`</>`)
3. Register the app (name it anything like "Fleet Photos")
4. Copy the `firebaseConfig` object

### 1.7 Update firebase-config.js

Open `firebase-config.js` and replace the placeholder values:

```javascript
const firebaseConfig = {
  apiKey: "AIzaSy...",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project-id",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abc123"
};
```

---

## Step 2: Create Your First Admin User

Since the app requires users to exist in the `users` Firestore collection, you need to bootstrap the first admin:

### Option A: Using Firebase Console (recommended)

1. Go to **Authentication** > **Users** > **Add user**
2. Enter your email and a password, click **Add user**
3. Copy the **User UID** shown
4. Go to **Firestore Database** > **+ Start collection** > name it `users`
5. **Add document** with Document ID = the User UID you copied
6. Add these fields:
   - `email` (string): your email
   - `displayName` (string): your name
   - `role` (string): `admin`
   - `createdAt` (timestamp): now

Now you can log into the app and create more users from the Admin panel.

### Option B: Using the setup script

Run this in your browser console after loading the app (with test Firestore rules temporarily allowing writes):

```javascript
// Temporarily set Firestore rules to allow all writes, then run:
firebase.auth().createUserWithEmailAndPassword('admin@yourcompany.com', 'yourpassword')
  .then(cred => {
    return firebase.firestore().collection('users').doc(cred.user.uid).set({
      email: 'admin@yourcompany.com',
      displayName: 'Admin',
      role: 'admin',
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  })
  .then(() => console.log('Admin created! Now update Firestore rules back.'));
```

**Remember to update your Firestore rules back to the secure version after.**

---

## Step 3: Deploy

### Option A: Firebase Hosting (recommended, free)

```bash
# Install Firebase CLI
npm install -g firebase-tools

# Login
firebase login

# Initialize hosting in your project folder
firebase init hosting

# When prompted:
#   - Select your Firebase project
#   - Public directory: . (current directory)
#   - Single-page app: No
#   - Overwrite index.html: No

# Deploy
firebase deploy --only hosting
```

Your app will be live at `https://your-project.firebaseapp.com`

### Option B: Any static web host

This is a static site — just upload all files to any web host (Netlify, Vercel, GitHub Pages, etc.).

> **Important:** The site must be served over HTTPS for the camera to work on mobile devices.

---

## Step 4: Add to Home Screen (PWA)

### iPhone/Safari
1. Visit the site URL in Safari
2. Tap the **Share** button (box with arrow)
3. Tap **Add to Home Screen**
4. Tap **Add**

### Android/Chrome
1. Visit the site URL in Chrome
2. Tap the **three-dot menu** (⋮)
3. Tap **Add to Home screen**
4. Tap **Add**

This makes the app feel native with a full-screen experience.

---

## Usage Workflow

### Daily photo routine (for regular Users):

1. Open the app on your phone
2. Log in (stays logged in after first time)
3. Select a vehicle from the dropdown (shows make & model)
4. Tap **"Take Photo"** to open your camera — snap the photo
5. The photo uploads automatically to that vehicle's folder for today's date
6. Repeat for all angles/areas of the vehicle
7. Move to the next vehicle

### Admin tasks:

- **Add vehicles** — Admin Panel > Vehicles tab > fill in plate/make/model
- **Create users** — Admin Panel > Users tab > fill in email/password/name/role
- **Delete photos** — Admin Panel > Photos tab > select vehicle & date > tap photos to select > Delete Selected
- **Manage roles** — Admin Panel > Users tab > toggle between Admin/User roles

---

## File Structure

```
├── index.html            # Main HTML (all pages/views)
├── style.css             # Mobile-first responsive styles
├── app.js                # Application logic (auth, upload, admin)
├── firebase-config.js    # Your Firebase credentials (edit this!)
├── firebase-rules.js     # Security rules to copy into Firebase Console
├── manifest.json         # PWA manifest for "Add to Home Screen"
├── icons/                # App icons
│   └── icon-192.svg      # App icon (replace with PNG for full PWA support)
└── README.md             # This file
```

## Firebase Data Structure

```
Firestore:
├── users/{uid}           # { email, displayName, role, createdAt, createdBy }
├── vehicles/{id}         # { plate, make, model, year, color, createdAt }
└── photos/{id}           # { vehicleId, plate, storagePath, url, date, timestamp, uploadedBy }

Storage:
└── vehicles/
    └── {LICENSE_PLATE}/
        └── {YYYY-MM-DD}/
            └── {timestamp}_{random}.jpg
```

---

## Troubleshooting

- **"Loading photos" shows error** — You probably need to create the Firestore composite indexes. Check the browser console (F12) for a link that auto-creates them.
- **Camera doesn't open** — Make sure you're on HTTPS. Camera access requires a secure context.
- **Can't log in** — Verify the user exists in both Firebase Auth AND the `users` Firestore collection.
- **Photos not uploading** — Check Storage rules are set correctly and the user is logged in.
