import { useCallback, useEffect, useRef, useState } from "react";
import { Schema } from "effect";

const isomorphicLocalStorage: Storage =
  typeof window !== "undefined"
    ? window.localStorage
    : (function () {
        const store = new Map<string, string>();
        return {
          clear: () => store.clear(),
          getItem: (key) => store.get(key) ?? null,
          key: (index) => Array.from(store.keys()).at(index) ?? null,
          get length() {
            return store.size;
          },
          removeItem: (key) => store.delete(key),
          setItem: (key, value) => store.set(key, value),
        };
      })();

const LOCAL_STORAGE_CHANGE_EVENT = "ocicode:local-storage-change";

interface LocalStorageChangeDetail {
  key: string;
}

function decodeValue<T>(schema: Schema.Schema<T>, value: string): T {
  return Schema.decodeUnknownSync(schema as never)(JSON.parse(value)) as T;
}

function encodeValue<T>(schema: Schema.Schema<T>, value: T): string {
  return JSON.stringify(Schema.encodeSync(schema as never)(value as never));
}

function dispatchLocalStorageChange(key: string): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(
    new CustomEvent<LocalStorageChangeDetail>(LOCAL_STORAGE_CHANGE_EVENT, {
      detail: { key },
    }),
  );
}

export function getLocalStorageItem<T>(key: string, schema: Schema.Schema<T>): T | null {
  const item = isomorphicLocalStorage.getItem(key);
  return item ? decodeValue(schema, item) : null;
}

export function setLocalStorageItem<T>(key: string, value: T, schema: Schema.Schema<T>): void {
  isomorphicLocalStorage.setItem(key, encodeValue(schema, value));
}

export function removeLocalStorageItem(key: string): void {
  isomorphicLocalStorage.removeItem(key);
}

export function useLocalStorage<T>(
  key: string,
  initialValue: T,
  schema: Schema.Schema<T>,
): [T, (value: T | ((currentValue: T) => T | null) | null) => void] {
  const [storedValue, setStoredValue] = useState<T>(() => {
    try {
      return getLocalStorageItem(key, schema) ?? initialValue;
    } catch (error) {
      console.error("[LOCALSTORAGE] Failed to read value", error);
      return initialValue;
    }
  });
  const previousKeyRef = useRef(key);

  const setValue = useCallback(
    (value: T | ((currentValue: T) => T | null) | null) => {
      try {
        setStoredValue((previousValue) => {
          const resolvedValue =
            typeof value === "function"
              ? (value as (currentValue: T) => T | null)(previousValue)
              : value;

          if (resolvedValue === null) {
            removeLocalStorageItem(key);
            queueMicrotask(() => dispatchLocalStorageChange(key));
            return initialValue;
          }

          setLocalStorageItem(key, resolvedValue, schema);
          queueMicrotask(() => dispatchLocalStorageChange(key));
          return resolvedValue;
        });
      } catch (error) {
        console.error("[LOCALSTORAGE] Failed to write value", error);
      }
    },
    [initialValue, key, schema],
  );

  useEffect(() => {
    if (previousKeyRef.current === key) {
      return;
    }
    previousKeyRef.current = key;
    try {
      setStoredValue(getLocalStorageItem(key, schema) ?? initialValue);
    } catch (error) {
      console.error("[LOCALSTORAGE] Failed to sync value", error);
      setStoredValue(initialValue);
    }
  }, [initialValue, key, schema]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const syncFromStorage = () => {
      try {
        setStoredValue(getLocalStorageItem(key, schema) ?? initialValue);
      } catch (error) {
        console.error("[LOCALSTORAGE] Failed to sync from storage", error);
        setStoredValue(initialValue);
      }
    };

    const handleStorage = (event: StorageEvent) => {
      if (event.key === key) {
        syncFromStorage();
      }
    };

    const handleLocalChange = (event: Event) => {
      if (
        !(event instanceof CustomEvent) ||
        (event as CustomEvent<LocalStorageChangeDetail>).detail.key !== key
      ) {
        return;
      }
      syncFromStorage();
    };

    window.addEventListener("storage", handleStorage);
    window.addEventListener(LOCAL_STORAGE_CHANGE_EVENT, handleLocalChange);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(LOCAL_STORAGE_CHANGE_EVENT, handleLocalChange);
    };
  }, [initialValue, key, schema]);

  return [storedValue, setValue];
}
