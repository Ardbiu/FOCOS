import { describe, expect, it } from 'vitest';
import { SAOCOM_PROVINCES, SAOCOM_WMS_URL, saocomLayers, saocomWmsOptions } from '../src/overlay';

describe('the CONAE SAOCOM overlay', () => {
  it('asks CONAE\'s open WMS', () => {
    expect(SAOCOM_WMS_URL).toBe('https://geoportal.conae.gov.ar/geoserver/saocom_mosaicos/wms');
  });

  it('names one 2022 mosaic per province, 24 in all', () => {
    expect(SAOCOM_PROVINCES).toHaveLength(24);
    expect(new Set(SAOCOM_PROVINCES).size).toBe(24);
    expect(SAOCOM_PROVINCES).toEqual([
      'BuenosAires', 'Catamarca', 'Chaco', 'Chubut', 'CiudadAutonomaDeBuenosAires', 'Cordoba', 'Corrientes', 'EntreRios',
      'Formosa', 'Jujuy', 'LaPampa', 'LaRioja', 'Mendoza', 'Misiones', 'Neuquen', 'RioNegro', 'Salta', 'SanJuan', 'SanLuis',
      'SantaCruz', 'SantaFe', 'SantiagoDelEstero', 'Tucuman', 'TierraDelFuego_TierraDelFuego',
    ]);
    const layers = saocomLayers().split(',');
    expect(layers).toHaveLength(24);
    expect(layers[0]).toBe('saocom_mosaicos:BuenosAires_2022');
    expect(layers[23]).toBe('saocom_mosaicos:TierraDelFuego_TierraDelFuego_2022');
    for (const layer of layers) expect(layer).toMatch(/^saocom_mosaicos:[A-Za-z_]+_2022$/);
  });

  it('requests all of them as one transparent PNG layer, see-through enough to keep outlines and dots readable', () => {
    expect(saocomWmsOptions('SAOCOM mosaic: CONAE')).toEqual({
      layers: saocomLayers(),
      format: 'image/png',
      transparent: true,
      opacity: 0.7,
      attribution: 'SAOCOM mosaic: CONAE',
    });
  });
});
