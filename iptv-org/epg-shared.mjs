// What the addon and the EPG builder both need to agree on.

export const EPG_KEY = "mhub:iptv-org:epg-v3";
export const EPG_TTL_S = 6 * 3600;

// A channel is called slightly differently everywhere, so it is matched under
// several keys: as written, without the markers the playlist adds, and reduced
// to letters and digits.
export function normalizeName(name) {
  return name
    .toLowerCase()
    .replace(/\s*\[.*?\]\s*/g, "")  // [Geo-blocked], [Not 24/7]
    .replace(/\s*\(.*?\)\s*/g, "")  // (1080p), (720p)
    .replace(/\s*(hd|sd|fhd|uhd|4k|tv|\+)\s*$/i, "")
    .trim();
}

export const toKey = (name) => normalizeName(name).replace(/[^a-z0-9]/g, "");

// XMLTV writes "20240612183000 +0200".
export function parseXmltvDate(str) {
  if (!str || str.length < 14) return 0;
  const n = (i, len) => Number(str.slice(i, i + len));
  let ms = Date.UTC(n(0, 4), n(4, 2) - 1, n(6, 2), n(8, 2), n(10, 2), n(12, 2));
  const offset = /([+-])(\d{2})(\d{2})/.exec(str.slice(14));
  if (offset) {
    const sign = offset[1] === "-" ? -1 : 1;
    ms -= sign * (Number(offset[2]) * 3600000 + Number(offset[3]) * 60000);
  }
  return ms;
}
