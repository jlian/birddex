const LOCATION_TIMEOUT_MS = 15_000

export function getCurrentLocation(signal: AbortSignal): Promise<{ lat: number; lon: number }> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    if (!navigator.geolocation || window.isSecureContext === false) {
      reject(new Error('Current location is unavailable here. Use HTTPS or search for a place instead.'))
      return
    }

    let settled = false
    const finish = (error?: Error, coordinates?: { lat: number; lon: number }) => {
      if (settled) return
      settled = true
      window.clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else if (coordinates) resolve(coordinates)
    }
    const onAbort = () => finish(new DOMException('Location request cancelled', 'AbortError'))
    // The browser's timeout excludes time spent waiting for permission.
    const timeout = window.setTimeout(() => finish(new Error(
      'Getting your location timed out. Try again or search for a place.',
    )), LOCATION_TIMEOUT_MS)
    signal.addEventListener('abort', onAbort, { once: true })

    navigator.geolocation.getCurrentPosition(
      position => {
        const { latitude: lat, longitude: lon } = position.coords
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
          finish(new Error('Your location is unavailable. Try again or search for a place.'))
          return
        }
        finish(undefined, { lat, lon })
      },
      error => {
        const message = error.code === 1
          ? 'Location access was denied. Allow location in your browser settings or search for a place.'
          : error.code === 3
            ? 'Getting your location timed out. Try again or search for a place.'
            : 'Your location is unavailable. Check location services or search for a place.'
        finish(new Error(message))
      },
      { enableHighAccuracy: false, maximumAge: 0, timeout: LOCATION_TIMEOUT_MS },
    )
  })
}
