export const testServerPort = Number(process.env.PLAYWRIGHT_PORT || 5000)
export const testBaseURL = `http://localhost:${testServerPort}`
