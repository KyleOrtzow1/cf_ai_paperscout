/**
 * Safe storage utility functions with graceful degradation
 *
 * Provides localStorage-like API that automatically falls back through:
 * 1. localStorage (persistent across sessions)
 * 2. sessionStorage (persists for current session)
 * 3. In-memory storage (current page load only)
 *
 * This ensures the app works in all browser contexts:
 * - Private/incognito browsing
 * - Sandboxed iframes
 * - Browsers with storage disabled
 * - Storage quota exceeded
 */

export type StorageType = "persistent" | "session" | "memory";

export interface StorageResult<T> {
  value: T;
  type: StorageType;
}

// In-memory fallback storage
const memoryStorage = new Map<string, string>();

/**
 * Safely retrieve a value from storage with automatic fallback
 *
 * @param key - Storage key to retrieve
 * @param defaultValue - Value to return if key not found in any storage
 * @returns StorageResult with the value and storage type used
 *
 * @example
 * const { value, type } = safeGetItem('user-id', '');
 * if (type === 'memory') {
 *   console.warn('Storage not available, using ephemeral ID');
 * }
 */
export function safeGetItem<T = string>(
  key: string,
  defaultValue: T
): StorageResult<T> {
  // Try localStorage first
  try {
    const value = localStorage.getItem(key);
    if (value !== null) {
      return { value: value as T, type: "persistent" };
    }
  } catch (error) {
    console.warn(`localStorage.getItem failed for key "${key}":`, error);
  }

  // Try sessionStorage second
  try {
    const value = sessionStorage.getItem(key);
    if (value !== null) {
      return { value: value as T, type: "session" };
    }
  } catch (error) {
    console.warn(`sessionStorage.getItem failed for key "${key}":`, error);
  }

  // Fall back to in-memory storage
  const memValue = memoryStorage.get(key);
  if (memValue !== undefined) {
    return { value: memValue as T, type: "memory" };
  }

  // Return default value with memory type
  return { value: defaultValue, type: "memory" };
}

/**
 * Safely store a value with automatic fallback
 *
 * @param key - Storage key to set
 * @param value - Value to store (will be stringified if needed)
 * @returns StorageType indicating which storage was used
 *
 * @example
 * const storageType = safeSetItem('theme', 'dark');
 * if (storageType === 'memory') {
 *   showWarning('Settings will not persist after closing this page');
 * }
 */
export function safeSetItem(key: string, value: string): StorageType {
  // Try localStorage first
  try {
    localStorage.setItem(key, value);
    return "persistent";
  } catch (error) {
    console.warn(`localStorage.setItem failed for key "${key}":`, error);
  }

  // Try sessionStorage second
  try {
    sessionStorage.setItem(key, value);
    return "session";
  } catch (error) {
    console.warn(`sessionStorage.setItem failed for key "${key}":`, error);
  }

  // Fall back to in-memory storage
  memoryStorage.set(key, value);
  return "memory";
}

/**
 * Safely remove a value from all storage locations
 *
 * @param key - Storage key to remove
 */
export function safeRemoveItem(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch (_error) {
    // Silent fail - storage might not be available
  }

  try {
    sessionStorage.removeItem(key);
  } catch (_error) {
    // Silent fail - storage might not be available
  }

  memoryStorage.delete(key);
}

/**
 * Check if persistent storage is available
 *
 * @returns true if localStorage is accessible
 */
export function isPersistentStorageAvailable(): boolean {
  try {
    const testKey = "__storage_test__";
    localStorage.setItem(testKey, "test");
    localStorage.removeItem(testKey);
    return true;
  } catch {
    return false;
  }
}
