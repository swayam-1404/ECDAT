const crypto = require('crypto')

export function oldChecksum(value) {
  return crypto.createHash('md5').update(value).digest('hex')
}

