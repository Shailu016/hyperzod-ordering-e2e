// Recovery is specific to the storefront's verified Google-search -> Mapbox path.
// Fingerprints retain correlation without putting provider tokens or coordinates in reports.
const crypto = require('node:crypto');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function queryHash(query) {
  return typeof query === 'string' && query.trim() ? digest(query.trim().toLowerCase().replace(/\s+/g, ' ')) : null;
}
function coordinateHash(coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length !== 2 || !coordinates.every(Number.isFinite) ||
      Math.abs(coordinates[0]) > 180 || Math.abs(coordinates[1]) > 90) return null;
  return digest(coordinates.map(value => value.toFixed(6)).join(','));
}
function backendQuery(url, method) {
  try {
    const parsed = new URL(url);
    return method === 'GET' && parsed.origin === 'https://api.hyperzod.app' && parsed.pathname === '/store/v1/places/search'
      ? queryHash(parsed.searchParams.get('q')) : null;
  } catch { return null; }
}
function mapboxQuery(url, method = 'GET') {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/geocoding\/v5\/mapbox\.places\/([^/]+)\.json$/);
    if (method !== 'GET' || parsed.origin !== 'https://api.mapbox.com' || !match) return null;
    const query = decodeURIComponent(match[1]);
    if (/^-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/.test(query)) return null; // Reverse geocoding is a separate dependency.
    return queryHash(query);
  } catch { return null; }
}
function featureHashes(body) {
  if (body?.type !== 'FeatureCollection' || !Array.isArray(body.features)) return [];
  return [...new Set(body.features.slice(0, 20).filter(feature => feature?.type === 'Feature' &&
    feature.geometry?.type === 'Point' && typeof feature.place_name === 'string' && feature.place_name.trim())
    .map(feature => coordinateHash(feature.center || feature.geometry.coordinates)).filter(Boolean))];
}
function recoveredGeocoding(event, recoveries = []) {
  if (event.kind !== 'application' || event.status !== 200 || event.method !== 'GET' ||
      !/^APPLICATION GET https:\/\/api\.hyperzod\.app\/store\/v1\/places\/search "Gmap api key not set for tenant-\d+"$/.test(event.message) ||
      !/^[a-f0-9]{64}$/.test(event.geocodingQueryHash || '')) return false;
  try {
    if (new URL(event.url).origin !== 'https://api.hyperzod.app' || new URL(event.url).pathname !== '/store/v1/places/search') return false;
  } catch { return false; }
  return recoveries.some(proof => proof.queryHash === event.geocodingQueryHash &&
    /^[a-f0-9]{64}$/.test(proof.coordinateHash || '') &&
    proof.responseSequence > event.sequence && proof.confirmedSequence > proof.responseSequence);
}
module.exports = { queryHash, coordinateHash, backendQuery, mapboxQuery, featureHashes, recoveredGeocoding };
