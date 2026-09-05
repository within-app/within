/**
 * Unit tests for lib/geolocation core logic (GPS coordinates for entries).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  isGeolocationAvailable,
  isWebGeolocationAvailable,
  mapGeoError,
  formatCoord,
  GeoError,
} from '@/lib/geolocation';

describe('isGeolocationAvailable', () => {
  it('mirrors the browser availability check', async () => {
    expect(await isGeolocationAvailable()).toBe(isWebGeolocationAvailable());
  });
});

describe('isWebGeolocationAvailable', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns false without window/navigator (SSR)', () => {
    expect(isWebGeolocationAvailable()).toBe(false);
  });

  it('returns false in an insecure context (http)', () => {
    vi.stubGlobal('navigator', { geolocation: {} });
    vi.stubGlobal('window', { isSecureContext: false });
    expect(isWebGeolocationAvailable()).toBe(false);
  });

  it('returns true with geolocation API in a secure context', () => {
    vi.stubGlobal('navigator', { geolocation: {} });
    vi.stubGlobal('window', { isSecureContext: true });
    expect(isWebGeolocationAvailable()).toBe(true);
  });
});

describe('mapGeoError', () => {
  it('maps GeoError to its kind', () => {
    expect(mapGeoError(new GeoError('denied'))).toBe('denied');
    expect(mapGeoError(new GeoError('timeout'))).toBe('timeout');
  });

  it('maps GeolocationPositionError codes (1=denied, 3=timeout, 2=unavailable)', () => {
    expect(mapGeoError({ code: 1, message: '' })).toBe('denied');
    expect(mapGeoError({ code: 3, message: '' })).toBe('timeout');
    expect(mapGeoError({ code: 2, message: '' })).toBe('unavailable');
  });

  it('maps error messages by substring', () => {
    expect(mapGeoError(new Error('User denied location permission'))).toBe('denied');
    expect(mapGeoError(new Error('Location request timed out'))).toBe('timeout');
    expect(mapGeoError(new Error('Location services are not enabled'))).toBe('unavailable');
  });

  it('falls back to unavailable for unknown values', () => {
    expect(mapGeoError('string error')).toBe('unavailable');
    expect(mapGeoError(null)).toBe('unavailable');
  });
});

describe('formatCoord', () => {
  it('rounds to 5 decimal places (~1 m)', () => {
    expect(formatCoord(53.5510846)).toBe('53.55108');
    expect(formatCoord(-9.9936818)).toBe('-9.99368');
    expect(formatCoord(0)).toBe('0.00000');
  });
});
