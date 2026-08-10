const isCI = !!process.env.CI

export const testServerPort = Number(process.env.PLAYWRIGHT_PORT || (isCI ? 5000 : 5012))
export const testBaseURL = `http://localhost:${testServerPort}`
