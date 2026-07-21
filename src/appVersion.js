import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const versionFile = join(__dirname, '..', 'data', 'app-version.json')

/**
 * Latest app build published for users.
 * Prefer server/data/app-version.json (easy to bump when you push an APK).
 * Env vars override the file when set.
 */
export function getAppVersionInfo() {
  let fromFile = {}
  try {
    if (existsSync(versionFile)) {
      fromFile = JSON.parse(readFileSync(versionFile, 'utf8')) || {}
    }
  } catch {
    fromFile = {}
  }

  const latestVersionCode = Number(
    process.env.APP_LATEST_VERSION_CODE ?? fromFile.latestVersionCode ?? 3,
  )
  const minVersionCode = Number(
    process.env.APP_MIN_VERSION_CODE ?? fromFile.minVersionCode ?? 1,
  )
  const latestVersionName = String(
    process.env.APP_LATEST_VERSION_NAME ?? fromFile.latestVersionName ?? '1.2',
  )
  const updateUrl = String(
    process.env.APP_UPDATE_URL ??
      fromFile.updateUrl ??
      'https://onebookserver.onesaasbackend.com',
  ).trim()
  const message = String(
    process.env.APP_UPDATE_MESSAGE ??
      fromFile.message ??
      'A new version of OneBook is available. Please update for the latest features and fixes.',
  ).trim()
  const forceUpdate =
    process.env.APP_FORCE_UPDATE === '1' ||
    process.env.APP_FORCE_UPDATE === 'true' ||
    Boolean(fromFile.forceUpdate)

  return {
    latestVersionCode: Number.isFinite(latestVersionCode) ? latestVersionCode : 3,
    latestVersionName,
    minVersionCode: Number.isFinite(minVersionCode) ? minVersionCode : 1,
    updateUrl,
    message,
    forceUpdate,
  }
}
