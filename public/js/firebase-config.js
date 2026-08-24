// ============================================================
// Pegá aquí los datos de tu proyecto de Firebase.
// Los encontrás en: Firebase Console → ⚙️ Configuración del proyecto
// → tu app web → "Config" (no "npm").
// ============================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyB4zYmzgGLXYZ2lDXKVTqhK-wEcb9vhOO4",
  authDomain: "catering-portal-39b35.firebaseapp.com",
  projectId: "catering-portal-39b35",
  storageBucket: "catering-portal-39b35.firebasestorage.app",
  messagingSenderId: "804279478043",
  appId: "1:804279478043:web:e3b98255d6d93d140055be"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
export const storage = getStorage(app);
