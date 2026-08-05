function translateUUID(uuid = '') {
  if (!uuid) return;

  const bytes = String(uuid).replace(/-/g, '').match(/.{2}/g)?.reverse();
  if (!bytes) return;

  const hex = [...bytes.slice(8), ...bytes.slice(0, 8)].join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20)
  ].join('-');
}

module.exports = { translateUUID };
