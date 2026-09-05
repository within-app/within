import { useCallback, useEffect, useState } from 'react';
import {
  isGeolocationAvailable,
  getWebPosition,
  mapGeoError,
  type GeoPoint,
  type GeoErrorKind,
} from '@/lib/geolocation';

/**
 * One-shot device position for the entry location fields via navigator.geolocation,
 * only offered in secure contexts (HTTPS). isAvailable stays false where it cannot
 * work, hiding the UI entirely.
 */
export function useGeolocation() {
  const [isAvailable, setIsAvailable] = useState(false);
  const [isLocating, setIsLocating] = useState(false);
  const [error, setError] = useState<GeoErrorKind | null>(null);

  useEffect(() => {
    let cancelled = false;
    isGeolocationAvailable().then((available) => {
      if (!cancelled) setIsAvailable(available);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const requestPosition = useCallback(async (): Promise<GeoPoint | null> => {
    setError(null);
    setIsLocating(true);
    try {
      return await getWebPosition();
    } catch (err) {
      setError(mapGeoError(err));
      return null;
    } finally {
      setIsLocating(false);
    }
  }, []);

  return { isAvailable, isLocating, error, requestPosition };
}
