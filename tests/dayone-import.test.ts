import { describe, it, expect } from "vitest"
import {
  mapWeatherCode,
  toUUID,
  buildLocationName,
} from "../src/lib/dayone-import"

describe("mapWeatherCode", () => {
  it("returns 'sunny' for 'clear'", () => {
    expect(mapWeatherCode("clear")).toBe("sunny")
  })

  it("returns 'sunny' for 'mostly-clear'", () => {
    expect(mapWeatherCode("mostly-clear")).toBe("sunny")
  })

  it("returns 'partly-cloudy' for 'partly-cloudy'", () => {
    expect(mapWeatherCode("partly-cloudy")).toBe("partly-cloudy")
  })

  it("returns 'rainy' for 'rain'", () => {
    expect(mapWeatherCode("rain")).toBe("rainy")
  })

  it("returns 'stormy' for 'thunderstorms'", () => {
    expect(mapWeatherCode("thunderstorms")).toBe("stormy")
  })

  it("returns 'snowy' for 'snow'", () => {
    expect(mapWeatherCode("snow")).toBe("snowy")
  })

  it("returns 'foggy' for 'foggy'", () => {
    expect(mapWeatherCode("foggy")).toBe("foggy")
  })

  it("returns 'cloudy' for unknown code", () => {
    expect(mapWeatherCode("unknown-code")).toBe("cloudy")
  })

  it("returns 'cloudy' for undefined", () => {
    expect(mapWeatherCode(undefined)).toBe("cloudy")
  })

  it("is case-insensitive", () => {
    expect(mapWeatherCode("CLEAR")).toBe("sunny")
    expect(mapWeatherCode("Rain")).toBe("rainy")
  })
})

describe("toUUID", () => {
  it("converts a 32-char hex to standard UUID format", () => {
    expect(toUUID("0123456789abcdef0123456789abcdef")).toBe(
      "01234567-89ab-cdef-0123-456789abcdef"
    )
  })

  it("normalises uppercase hex", () => {
    expect(toUUID("AABBCCDDEEFF00112233445566778899")).toBe(
      "aabbccdd-eeff-0011-2233-445566778899"
    )
  })

  it("strips existing hyphens before formatting", () => {
    expect(toUUID("01234567-89AB-CDEF-0123-456789ABCDEF")).toBe(
      "01234567-89ab-cdef-0123-456789abcdef"
    )
  })
})

describe("buildLocationName", () => {
  it("returns null when loc is undefined", () => {
    expect(buildLocationName(undefined)).toBeNull()
  })

  it("joins all three fields when present", () => {
    expect(
      buildLocationName({ placeName: "Central Park", localityName: "New York", country: "USA" })
    ).toBe("Central Park, New York, USA")
  })

  it("omits missing fields", () => {
    expect(buildLocationName({ country: "Germany" })).toBe("Germany")
  })

  it("returns null when no relevant fields are present", () => {
    expect(buildLocationName({})).toBeNull()
  })
})
