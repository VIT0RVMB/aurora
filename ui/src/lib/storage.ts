// localStorage may throw (private mode, disabled storage); the app must work without it.
export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`aurora:${key}`);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(`aurora:${key}`, JSON.stringify(value));
  } catch {
    // Preferences are a convenience; losing them is fine.
  }
}
