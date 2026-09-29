// Replace these empty values with the public Web app configuration from
// Firebase Console > Project settings > Your apps. Do not add service-account
// credentials, admin SDK keys, or any other private secrets to this project.
export const firebaseConfig = {
  apiKey: "AIzaSyDAtON1nsRaYPnCjsPudaRbsYGthkSBEpA",
  authDomain: "movieflix-bafa5.firebaseapp.com",
  projectId: "movieflix-bafa5",
  storageBucket: "movieflix-bafa5.firebasestorage.app",
  messagingSenderId: "669840911385",
  appId: "1:669840911385:web:461adcd933d0b7b4e34e88"
};

export const isFirebaseConfigured = [
    firebaseConfig.apiKey,
    firebaseConfig.authDomain,
    firebaseConfig.projectId,
    firebaseConfig.appId
].every(value => typeof value === "string" && value.trim() !== "");
