// Lightweight offline India state/UT classifier.
//
// Deliberately NOT calling a third-party geocoding API: pump GPS fixes are
// business-sensitive, and a live reverse-geocode call per device would add
// network latency + a rate-limited external dependency to every dashboard
// load. Instead we classify by bounding box, which is instant, free, and
// keeps coordinates in-house.
//
// Trade-off: bounding boxes are rectangles, not real state borders, so a
// pump within ~20-30km of a state line can occasionally be tagged with the
// neighbouring state. Good enough for fleet-level "which state is this
// cluster of pumps in" reporting; not survey-grade.
//
// Order matters: smaller states/UTs that sit inside or against a much
// larger neighbour are listed first so they get first claim on a coordinate
// that falls inside both boxes.
const STATE_BOXES = [
  { name: "Chandigarh", minLat: 30.66, maxLat: 30.8, minLon: 76.72, maxLon: 76.86 },
  { name: "Puducherry", minLat: 11.75, maxLat: 12.05, minLon: 79.68, maxLon: 79.9 },
  { name: "Delhi", minLat: 28.4, maxLat: 28.89, minLon: 76.83, maxLon: 77.35 },
  { name: "Goa", minLat: 14.9, maxLat: 15.8, minLon: 73.68, maxLon: 74.34 },
  { name: "Sikkim", minLat: 27.0, maxLat: 28.13, minLon: 88.0, maxLon: 88.93 },
  { name: "Tripura", minLat: 22.94, maxLat: 24.53, minLon: 91.1, maxLon: 92.34 },
  { name: "Mizoram", minLat: 21.94, maxLat: 24.53, minLon: 92.16, maxLon: 93.51 },
  { name: "Manipur", minLat: 23.83, maxLat: 25.68, minLon: 92.97, maxLon: 94.78 },
  { name: "Meghalaya", minLat: 25.05, maxLat: 26.12, minLon: 89.8, maxLon: 92.8 },
  { name: "Nagaland", minLat: 25.2, maxLat: 27.05, minLon: 93.33, maxLon: 95.77 },
  { name: "Dadra and Nagar Haveli and Daman and Diu", minLat: 20.05, maxLat: 20.45, minLon: 72.7, maxLon: 73.19 },
  // Smaller/enclave-prone southern states checked before the larger Andhra
  // Pradesh / Telangana boxes that geographically wrap around them.
  { name: "Kerala", minLat: 8.18, maxLat: 12.82, minLon: 74.85, maxLon: 77.42 },
  { name: "Tamil Nadu", minLat: 8.08, maxLat: 13.6, minLon: 76.23, maxLon: 80.35 },
  { name: "Karnataka", minLat: 11.5, maxLat: 18.5, minLon: 74.0, maxLon: 78.6 },
  { name: "Haryana", minLat: 27.65, maxLat: 30.93, minLon: 74.45, maxLon: 77.65 },
  { name: "Punjab", minLat: 29.53, maxLat: 32.5, minLon: 73.87, maxLon: 76.94 },
  { name: "Himachal Pradesh", minLat: 30.22, maxLat: 33.25, minLon: 75.47, maxLon: 79.08 },
  { name: "Uttarakhand", minLat: 28.71, maxLat: 31.46, minLon: 77.57, maxLon: 81.05 },
  { name: "Bihar", minLat: 24.28, maxLat: 27.52, minLon: 83.3, maxLon: 88.3 },
  { name: "Jharkhand", minLat: 21.96, maxLat: 25.35, minLon: 83.32, maxLon: 87.92 },
  { name: "West Bengal", minLat: 21.5, maxLat: 27.22, minLon: 85.82, maxLon: 89.9 },
  { name: "Assam", minLat: 24.13, maxLat: 28.22, minLon: 89.7, maxLon: 96.02 },
  { name: "Arunachal Pradesh", minLat: 26.63, maxLat: 29.45, minLon: 91.5, maxLon: 97.42 },
  { name: "Telangana", minLat: 15.8, maxLat: 19.92, minLon: 77.25, maxLon: 81.35 },
  { name: "Andhra Pradesh", minLat: 12.5, maxLat: 19.9, minLon: 78.4, maxLon: 84.9 },
  { name: "Chhattisgarh", minLat: 17.78, maxLat: 24.12, minLon: 80.24, maxLon: 84.42 },
  { name: "Odisha", minLat: 17.78, maxLat: 22.73, minLon: 81.37, maxLon: 87.53 },
  { name: "Ladakh", minLat: 32.0, maxLat: 36.0, minLon: 75.76, maxLon: 80.3 },
  { name: "Jammu and Kashmir", minLat: 32.15, maxLat: 37.1, minLon: 72.5, maxLon: 80.3 },
  // Rajasthan checked before Madhya Pradesh / Uttar Pradesh, whose boxes
  // otherwise swallow western Rajasthan cities like Jaipur.
  { name: "Gujarat", minLat: 20.06, maxLat: 24.72, minLon: 68.05, maxLon: 74.5 },
  { name: "Rajasthan", minLat: 23.03, maxLat: 30.22, minLon: 69.3, maxLon: 78.3 },
  { name: "Uttar Pradesh", minLat: 23.8, maxLat: 30.42, minLon: 77.0, maxLon: 84.65 },
  { name: "Madhya Pradesh", minLat: 21.04, maxLat: 26.94, minLon: 74.0, maxLon: 82.85 },
  { name: "Maharashtra", minLat: 15.6, maxLat: 22.1, minLon: 72.6, maxLon: 80.9 },
  { name: "Andaman and Nicobar Islands", minLat: 6.5, maxLat: 13.7, minLon: 92.2, maxLon: 94.3 },
  { name: "Lakshadweep", minLat: 8.0, maxLat: 12.5, minLon: 71.7, maxLon: 74.0 },
];

/**
 * Classify a lat/lon pair into an Indian state/UT name.
 * Returns "Unknown" if the point doesn't fall in any known box
 * (e.g. missing GPS fix, or a pump outside India).
 *
 * Many state boxes legitimately overlap near diagonal borders (e.g.
 * Karnataka/Tamil Nadu/Andhra Pradesh around Bangalore-Chennai-Hyderabad,
 * or Rajasthan/Madhya Pradesh around Jaipur-Bhopal). When a point falls
 * inside more than one box, we pick whichever box's centroid is closest to
 * the point rather than relying on list order — this resolves the large
 * majority of border ambiguity correctly.
 */
function stateFromLatLon(lat, lon) {
  const la = Number(lat);
  const lo = Number(lon);
  if (!isFinite(la) || !isFinite(lo) || (la === 0 && lo === 0)) return "Unknown";

  const matches = STATE_BOXES.filter(
    (box) => la >= box.minLat && la <= box.maxLat && lo >= box.minLon && lo <= box.maxLon
  );
  if (!matches.length) return "Unknown";
  if (matches.length === 1) return matches[0].name;

  let best = matches[0];
  let bestDist = Infinity;
  for (const box of matches) {
    const cLat = (box.minLat + box.maxLat) / 2;
    const cLon = (box.minLon + box.maxLon) / 2;
    const d = Math.hypot(la - cLat, lo - cLon);
    if (d < bestDist) { bestDist = d; best = box; }
  }
  return best.name;
}

module.exports = { stateFromLatLon, STATE_BOXES };
