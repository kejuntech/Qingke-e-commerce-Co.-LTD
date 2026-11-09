'use strict';
const crypto = require('node:crypto');
const sha = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
function keyFor(collection, item, index) {
  if (collection === 'settings.json' || collection === 'settings') return '__document__';
  const key = item && (item.id || item.email || item.tokenHash || item.orderId);
  return key != null && String(key).trim() ? String(key).trim() : `row-${index}-${sha(item).slice(0,16)}`;
}
module.exports = { sha, keyFor };
