import { firebaseConfig } from './config.js';

let app;
let db;

export function initFirebase() {
  if (db) return { app, db };
  const { initializeApp, getDatabase } = window.__firebase;
  app = initializeApp(firebaseConfig);
  db = getDatabase(app);
  return { app, db };
}
