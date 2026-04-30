/**
 * Derive an IANA timezone from a WhatsApp e164 phone number using a hand-rolled
 * country-code → IANA map. No external dependency — phone numbers in our DB are
 * already canonical e164, and we don't need libphonenumber-js's parsing layer.
 *
 * Multi-tz countries (US/CA/RU/AU/BR) default to the most-populous zone. Users
 * in other zones can override via SetUserTimezone. Returns `null` for country
 * codes we don't recognize; callers fall through to UTC.
 */

const COUNTRY_CODE_TO_IANA: Array<[string, string]> = [
  ["1", "America/New_York"],
  ["7", "Europe/Moscow"],
  ["20", "Africa/Cairo"],
  ["27", "Africa/Johannesburg"],
  ["30", "Europe/Athens"],
  ["31", "Europe/Amsterdam"],
  ["32", "Europe/Brussels"],
  ["33", "Europe/Paris"],
  ["34", "Europe/Madrid"],
  ["36", "Europe/Budapest"],
  ["39", "Europe/Rome"],
  ["40", "Europe/Bucharest"],
  ["41", "Europe/Zurich"],
  ["44", "Europe/London"],
  ["45", "Europe/Copenhagen"],
  ["46", "Europe/Stockholm"],
  ["47", "Europe/Oslo"],
  ["48", "Europe/Warsaw"],
  ["49", "Europe/Berlin"],
  ["52", "America/Mexico_City"],
  ["54", "America/Argentina/Buenos_Aires"],
  ["55", "America/Sao_Paulo"],
  ["56", "America/Santiago"],
  ["57", "America/Bogota"],
  ["58", "America/Caracas"],
  ["60", "Asia/Kuala_Lumpur"],
  ["61", "Australia/Sydney"],
  ["62", "Asia/Jakarta"],
  ["63", "Asia/Manila"],
  ["64", "Pacific/Auckland"],
  ["65", "Asia/Singapore"],
  ["66", "Asia/Bangkok"],
  ["81", "Asia/Tokyo"],
  ["82", "Asia/Seoul"],
  ["84", "Asia/Ho_Chi_Minh"],
  ["86", "Asia/Shanghai"],
  ["90", "Europe/Istanbul"],
  ["91", "Asia/Kolkata"],
  ["92", "Asia/Karachi"],
  ["93", "Asia/Kabul"],
  ["94", "Asia/Colombo"],
  ["95", "Asia/Yangon"],
  ["98", "Asia/Tehran"],
  ["212", "Africa/Casablanca"],
  ["213", "Africa/Algiers"],
  ["216", "Africa/Tunis"],
  ["218", "Africa/Tripoli"],
  ["220", "Africa/Banjul"],
  ["234", "Africa/Lagos"],
  ["249", "Africa/Khartoum"],
  ["254", "Africa/Nairobi"],
  ["255", "Africa/Dar_es_Salaam"],
  ["256", "Africa/Kampala"],
  ["260", "Africa/Lusaka"],
  ["263", "Africa/Harare"],
  ["351", "Europe/Lisbon"],
  ["352", "Europe/Luxembourg"],
  ["353", "Europe/Dublin"],
  ["354", "Atlantic/Reykjavik"],
  ["358", "Europe/Helsinki"],
  ["359", "Europe/Sofia"],
  ["370", "Europe/Vilnius"],
  ["371", "Europe/Riga"],
  ["372", "Europe/Tallinn"],
  ["380", "Europe/Kiev"],
  ["420", "Europe/Prague"],
  ["421", "Europe/Bratislava"],
  ["852", "Asia/Hong_Kong"],
  ["853", "Asia/Macau"],
  ["855", "Asia/Phnom_Penh"],
  ["856", "Asia/Vientiane"],
  ["880", "Asia/Dhaka"],
  ["886", "Asia/Taipei"],
  ["960", "Indian/Maldives"],
  ["961", "Asia/Beirut"],
  ["962", "Asia/Amman"],
  ["963", "Asia/Damascus"],
  ["964", "Asia/Baghdad"],
  ["965", "Asia/Kuwait"],
  ["966", "Asia/Riyadh"],
  ["967", "Asia/Aden"],
  ["968", "Asia/Muscat"],
  ["971", "Asia/Dubai"],
  ["972", "Asia/Jerusalem"],
  ["973", "Asia/Bahrain"],
  ["974", "Asia/Qatar"],
  ["977", "Asia/Kathmandu"],
  ["992", "Asia/Dushanbe"],
  ["994", "Asia/Baku"],
  ["995", "Asia/Tbilisi"],
  ["998", "Asia/Tashkent"],
];

const SORTED_PREFIXES: Array<[string, string]> = COUNTRY_CODE_TO_IANA.slice().sort((a, b) => b[0].length - a[0].length);

export function phoneToTimezone(phone: string): string | null {
  const digits = phone.replace(/\D+/g, "");
  if (!digits) return null;

  for (const [prefix, tz] of SORTED_PREFIXES) {
    if (digits.startsWith(prefix)) return tz;
  }
  return null;
}
