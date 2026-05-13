import { get, set } from "idb-keyval";

const PREFIX = "chordroom/";

export async function loadJSON<T>(key: string, fallback: T): Promise<T> {
  try {
    const v = await get(PREFIX + key);
    return v == null ? fallback : (v as T);
  } catch {
    return fallback;
  }
}

export async function saveJSON<T>(key: string, value: T) {
  try {
    await set(PREFIX + key, value);
  } catch {}
}

export function loadLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function saveLocal<T>(key: string, value: T) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {}
}
