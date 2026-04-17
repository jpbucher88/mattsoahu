// =============================================================
// FIRESTORE SECURITY RULES
// Copy and paste these into your Firebase Console:
//   Firestore Database > Rules
// =============================================================
//
// rules_version = '2';
// service cloud.firestore {
//   match /databases/{database}/documents {
//
//     // Helper: check if user is authenticated
//     function isAuth() {
//       return request.auth != null;
//     }
//
//     // Helper: get user role from users collection
//     function getUserRole() {
//       return get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role;
//     }
//
//     // Helper: check if admin
//     function isAdmin() {
//       return isAuth() && getUserRole() == 'admin';
//     }
//
//     // Helper: check if registered user (admin or user)
//     function isRegistered() {
//       return isAuth() && exists(/databases/$(database)/documents/users/$(request.auth.uid));
//     }
//
//     // Users collection - only admins can read/write
//     match /users/{userId} {
//       allow read: if isAuth() && (request.auth.uid == userId || isAdmin());
//       allow create, update, delete: if isAdmin();
//     }
//
//     // Vehicles collection - registered users can read, admins can write
//     match /vehicles/{vehicleId} {
//       allow read: if isRegistered();
//       allow create, update, delete: if isAdmin();
//     }
//
//     // Photos collection - registered users can create & read, admins can delete
//     match /photos/{photoId} {
//       allow read: if isRegistered();
//       allow create: if isRegistered();
//       allow update: if isAdmin();
//       allow delete: if isAdmin();
//     }
//   }
// }

// =============================================================
// FIREBASE STORAGE SECURITY RULES
// Copy and paste these into your Firebase Console:
//   Storage > Rules
// =============================================================
//
// rules_version = '2';
// service firebase.storage {
//   match /b/{bucket}/o {
//     match /vehicles/{allPaths=**} {
//       // Any registered user can upload photos
//       allow read: if request.auth != null;
//       allow write: if request.auth != null
//         && request.resource.size < 10 * 1024 * 1024   // Max 10MB per file
//         && request.resource.contentType.matches('image/.*');
//       allow delete: if request.auth != null;
//     }
//   }
// }

// =============================================================
// REQUIRED FIRESTORE INDEXES
// Create these composite indexes in Firebase Console:
//   Firestore Database > Indexes > Add Index
// =============================================================
//
// Collection: photos
//   Fields:  vehicleId (Ascending), date (Ascending), timestamp (Descending)
//   Query scope: Collection
//
// Collection: photos
//   Fields:  vehicleId (Ascending), timestamp (Descending)
//   Query scope: Collection
