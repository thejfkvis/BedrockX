const crypto = require('node:crypto')

const MAX_AUDIENCE_LENGTH = 160

function decodeTokenMetadata(token) {
  if (typeof token !== 'string' || token.length === 0) {
    return { present: false, format: 'none', expiry: 'unknown', audience: 'unknown', xuid: null }
  }

  if (token.startsWith('XBL3.0 ')) {
    return { present: true, format: 'xbl3', expiry: 'unknown', audience: 'unknown', xuid: null }
  }

  const parts = token.split('.')
  if (parts.length < 2) {
    return { present: true, format: 'opaque', expiry: 'unknown', audience: 'unknown', xuid: null }
  }

  let payload = null
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    return { present: true, format: 'jwt', expiry: 'unknown', audience: 'unknown', xuid: null }
  }

  const expiry = formatExpiry(payload?.exp ?? payload?.expiresOn ?? payload?.validUntil)
  const audience = formatAudience(payload?.aud ?? payload?.audience)
  const xuid = findXuid(payload)

  return { present: true, format: 'jwt', expiry, audience, xuid }
}

function findXuid(value, depth = 0) {
  if (value === null || value === undefined || depth > 4) return null

  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '')
      if (['xuid', 'xid', 'userxuid'].includes(normalized)) {
        const redacted = redactXuid(child)
        if (redacted) return redacted
      }
      const nested = findXuid(child, depth + 1)
      if (nested) return nested
    }
  }

  return null
}

function redactXuid(value) {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  if (!text) return null
  if (text.length <= 4) return `...${text}`
  return `...${text.slice(-4)}`
}

function formatExpiry(value) {
  if (value === null || value === undefined || value === '') return 'unknown'

  let date
  if (typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(String(value))) {
    const number = Number(value)
    date = new Date(number > 10_000_000_000 ? number : number * 1000)
  } else {
    date = new Date(value)
  }

  return Number.isNaN(date.getTime()) ? 'unknown' : date.toISOString()
}

function formatAudience(value) {
  if (Array.isArray(value)) value = value.join(',')
  if (value === null || value === undefined || value === '') return 'unknown'
  return String(value).replace(/[\r\n]/g, '').slice(0, MAX_AUDIENCE_LENGTH)
}

function sameIdentity(values) {
  const known = values.filter(value => value !== null && value !== undefined && value !== '')
  if (known.length < 2) return 'unknown'
  return new Set(known).size === 1 ? 'yes' : 'no'
}

function identityKey(value) {
  if (value === null || value === undefined || value === '') return null
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16)
}

module.exports = { decodeTokenMetadata, redactXuid, sameIdentity, identityKey }
