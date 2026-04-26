export const DEMO_CENTER = {
  lat: 23.282562,
  lng: 77.455904,
} as const;

export const DEMO_RADIUS_METERS = 400;

const EARTH_RADIUS_METERS = 6371000;

function toRad(value: number) {
  return (value * Math.PI) / 180;
}

function toDeg(value: number) {
  return (value * 180) / Math.PI;
}

export function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function isWithinDemoCampus(point: { lat: number; lng: number }, radiusMeters: number = DEMO_RADIUS_METERS) {
  return haversineMeters(point, DEMO_CENTER) <= radiusMeters;
}

export function randomPointNearDemoCampus(radiusMeters: number = DEMO_RADIUS_METERS) {
  // Uniformly distribute by area over a disc.
  const radius = radiusMeters * Math.sqrt(Math.random());
  const bearing = Math.random() * 2 * Math.PI;
  const angularDistance = radius / EARTH_RADIUS_METERS;
  const lat1 = toRad(DEMO_CENTER.lat);
  const lng1 = toRad(DEMO_CENTER.lng);

  const sinLat1 = Math.sin(lat1);
  const cosLat1 = Math.cos(lat1);
  const sinAd = Math.sin(angularDistance);
  const cosAd = Math.cos(angularDistance);

  const lat2 = Math.asin(sinLat1 * cosAd + cosLat1 * sinAd * Math.cos(bearing));
  const lng2 = lng1 + Math.atan2(
    Math.sin(bearing) * sinAd * cosLat1,
    cosAd - sinLat1 * Math.sin(lat2)
  );

  return {
    lat: Number(toDeg(lat2).toFixed(7)),
    lng: Number((((toDeg(lng2) + 540) % 360) - 180).toFixed(7)),
  };
}

export function normalizeToDemoCampus(point?: { lat?: number; lng?: number } | null) {
  const lat = Number(point?.lat);
  const lng = Number(point?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { ...DEMO_CENTER };
  const candidate = { lat, lng };
  return isWithinDemoCampus(candidate) ? candidate : { ...DEMO_CENTER };
}
