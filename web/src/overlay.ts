// An optional map layer from Argentina's space agency (plan task P1, its "map
// layer" branch): CONAE's SAOCOM L-band radar mosaics of 2022, one per
// province, from CONAE's open WMS. It is land context only. It never feeds a
// number, and nothing is requested from CONAE until the reader turns it on.

export const SAOCOM_WMS_URL = 'https://geoportal.conae.gov.ar/geoserver/saocom_mosaicos/wms';

/** The provinces as the WMS names their mosaics: `saocom_mosaicos:{name}_2022`. */
export const SAOCOM_PROVINCES = [
  'BuenosAires',
  'Catamarca',
  'Chaco',
  'Chubut',
  'CiudadAutonomaDeBuenosAires',
  'Cordoba',
  'Corrientes',
  'EntreRios',
  'Formosa',
  'Jujuy',
  'LaPampa',
  'LaRioja',
  'Mendoza',
  'Misiones',
  'Neuquen',
  'RioNegro',
  'Salta',
  'SanJuan',
  'SanLuis',
  'SantaCruz',
  'SantaFe',
  'SantiagoDelEstero',
  'Tucuman',
  'TierraDelFuego_TierraDelFuego',
] as const;

/** All 24 mosaics as one comma-separated `layers` value, so one request draws the country. */
export function saocomLayers(): string {
  return SAOCOM_PROVINCES.map((name) => `saocom_mosaicos:${name}_2022`).join(',');
}

/**
 * The options for `L.tileLayer.wms`: transparent PNG tiles, see-through enough
 * that province outlines and hotspot dots stay readable.
 */
export function saocomWmsOptions(attribution: string): {
  layers: string;
  format: string;
  transparent: boolean;
  opacity: number;
  attribution: string;
} {
  return { layers: saocomLayers(), format: 'image/png', transparent: true, opacity: 0.7, attribution };
}
