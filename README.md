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
