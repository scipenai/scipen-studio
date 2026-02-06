/**
 * @file SecureStorageService - OS-backed secure storage for secrets
 * @description Encrypts sensitive values with Electron safeStorage and persists via electron-store
 * @depends safeStorage, electron-store
 * @security P0: prevents plaintext secrets at rest using OS keychain APIs
 */

import { safeStorage } from 'electron';
import Store from 'electron-store';
import { createLogger } from './LoggerService';

const logger = createLogger('SecureStorageService');

// Prefix used to distinguish safeStorage-encrypted values (supports migration reads).
const ENCRYPTED_PREFIX = 'enc:';

// Singleton store for encrypted payloads (lazy init avoids keychain access at startup).
let secureStore: Store | null = null;

function getSecureStore(): Store {
  if (!secureStore) {
    secureStore = new Store({
      name: 'secure-config',
      encryptionKey: undefined, // Avoid double encryption; safeStorage owns key management.
    });
    logger.info('SecureStorageService initialized');
  }
  return secureStore;
}

export function isSecureStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/** @sideeffect Writes to electron-store; falls back to plaintext if safeStorage unavailable */
export function secureSet(key: string, value: string): boolean {
  try {
    const store = getSecureStore();

    if (isSecureStorageAvailable()) {
      const encrypted = safeStorage.encryptString(value);
      const base64 = encrypted.toString('base64');
      store.set(key, ENCRYPTED_PREFIX + base64);
      logger.debug(`Securely stored: ${key} (encrypted, ${value.length} chars)`);
    } else {
      logger.warn(`safeStorage not available, storing ${key} without encryption`);
      store.set(key, value);
    }

    return true;
  } catch (error) {
    logger.error(`Failed to securely store ${key}`, error);
    return false;
  }
}

/** @sideeffect Logs warning when legacy plaintext value is detected */
export function secureGet(key: string): string | null {
  try {
    const store = getSecureStore();
    const stored = store.get(key) as string | undefined;

    if (!stored) {
      return null;
    }

    if (stored.startsWith(ENCRYPTED_PREFIX)) {
      const base64 = stored.slice(ENCRYPTED_PREFIX.length);
      const encrypted = Buffer.from(base64, 'base64');
      return safeStorage.decryptString(encrypted);
    } else {
      logger.warn(`Found unencrypted value for ${key}, will re-encrypt on next save`);
      return stored;
    }
  } catch (error) {
    logger.error(`Failed to securely read ${key}`, error);
    return null;
  }
}

export function secureDelete(key: string): void {
  try {
    const store = getSecureStore();
    store.delete(key);
    logger.debug(`Securely deleted: ${key}`);
  } catch (error) {
    logger.error(`Failed to delete ${key}`, error);
  }
}

export function secureHas(key: string): boolean {
  try {
    const store = getSecureStore();
    return store.has(key);
  } catch {
    return false;
  }
}

// ====== Predefined Secure Storage Keys ======

export const SecureStorageKeys = {
  OverleafCookies: 'overleaf.cookies',
  OverleafCsrfToken: 'overleaf.csrfToken',
} as const;

export type SecureStorageKey = (typeof SecureStorageKeys)[keyof typeof SecureStorageKeys];

// ====== Convenience Methods ======

export function getOverleafCookies(): string | null {
  return secureGet(SecureStorageKeys.OverleafCookies);
}

export function setOverleafCookies(cookies: string): boolean {
  return secureSet(SecureStorageKeys.OverleafCookies, cookies);
}

export function deleteOverleafCookies(): void {
  secureDelete(SecureStorageKeys.OverleafCookies);
}
