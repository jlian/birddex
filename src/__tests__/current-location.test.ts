import { afterEach, describe, expect, it, vi } from 'vitest'
import { getCurrentLocation } from '@/lib/current-location'

describe('getCurrentLocation', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('reports unsupported and insecure contexts without requesting location', async () => {
    vi.stubGlobal('navigator', {})
    await expect(getCurrentLocation(new AbortController().signal)).rejects.toThrow(/unavailable here/)
    const getCurrentPosition = vi.fn()
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition } })
    vi.stubGlobal('isSecureContext', false)
    await expect(getCurrentLocation(new AbortController().signal)).rejects.toThrow(/HTTPS/)
    expect(getCurrentPosition).not.toHaveBeenCalled()
  })

  it('accepts a valid approximate location without requesting high accuracy', async () => {
    const getCurrentPosition = vi.fn(success => success({
      coords: { latitude: 0, longitude: 180, accuracy: 5000 },
    }))
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition } })
    await expect(getCurrentLocation(new AbortController().signal)).resolves.toEqual({ lat: 0, lon: 180 })
    expect(getCurrentPosition).toHaveBeenCalledWith(expect.any(Function), expect.any(Function), {
      enableHighAccuracy: false, maximumAge: 0, timeout: 15_000,
    })
  })

  it('bounds the wait even if the browser never answers the permission request', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition: vi.fn() } })
    const result = getCurrentLocation(new AbortController().signal)
    const assertion = expect(result).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(15_000)
    await assertion
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels promptly and cleans up the deadline', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition: vi.fn() } })
    const controller = new AbortController()
    const result = getCurrentLocation(controller.signal)
    controller.abort()
    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not request permission when already cancelled', async () => {
    const getCurrentPosition = vi.fn()
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition } })
    const controller = new AbortController()
    controller.abort()
    await expect(getCurrentLocation(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(getCurrentPosition).not.toHaveBeenCalled()
  })

  it.each([[NaN, 0], [91, 0], [0, Infinity], [0, -181]])('rejects invalid coordinates %s, %s', async (lat, lon) => {
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition: (success: PositionCallback) => {
      const coords = { latitude: lat, longitude: lon, accuracy: 0, altitude: null, altitudeAccuracy: null, heading: null, speed: null, toJSON: () => ({}) }
      success({ coords, timestamp: Date.now(), toJSON: () => ({}) })
    } } })
    await expect(getCurrentLocation(new AbortController().signal)).rejects.toThrow(/unavailable/)
  })
})
