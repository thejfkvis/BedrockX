const crypto = require('crypto')

async function checkStatus (res) {
  if (res.ok) { // res.status >= 200 && res.status < 300
    return JSON.parse(await res.text())
  } else {
    const resp = await res.text()
    throw Error(`${res.status} ${res.statusText} ${resp}`)
  }
}

function createHash (input) {
  return crypto.createHash('sha1').update(input ?? '', 'binary').digest('hex').substr(0, 6)
}

module.exports = { checkStatus, createHash }
