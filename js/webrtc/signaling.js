import { initFirebase } from '../firebase/init.js';
import {
  ref, set, push, onValue, get, remove, update
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

function db() { return initFirebase().db; }

export async function createRoom(roomCode) {
  const roomRef = ref(db(), `rooms/${roomCode}`);
  await set(roomRef, { createdAt: Date.now(), status: 'waiting' });
}

export async function roomExists(roomCode) {
  const snap = await get(ref(db(), `rooms/${roomCode}`));
  return snap.exists();
}

export async function setStatus(roomCode, status) {
  await update(ref(db(), `rooms/${roomCode}`), { status });
}

export async function sendOffer(roomCode, offer) {
  await set(ref(db(), `rooms/${roomCode}/offer`), offer);
}

export async function sendAnswer(roomCode, answer) {
  await set(ref(db(), `rooms/${roomCode}/answer`), answer);
}

export function listenForOffer(roomCode, cb) {
  const offerRef = ref(db(), `rooms/${roomCode}/offer`);
  return onValue(offerRef, snap => { if (snap.exists()) cb(snap.val()); });
}

export function listenForAnswer(roomCode, cb) {
  const answerRef = ref(db(), `rooms/${roomCode}/answer`);
  return onValue(answerRef, snap => { if (snap.exists()) cb(snap.val()); });
}

export async function addIceCandidate(roomCode, role, candidateObj) {
  const path = `rooms/${roomCode}/ice/${role}`;
  await push(ref(db(), path), candidateObj);
}

export function listenIceCandidates(roomCode, roleToRead, cb) {
  const iceRef = ref(db(), `rooms/${roomCode}/ice/${roleToRead}`);
  return onValue(iceRef, snap => {
    snap.forEach(child => cb(child.val()));
  });
}

export async function closeRoom(roomCode) {
  await remove(ref(db(), `rooms/${roomCode}`));
}
