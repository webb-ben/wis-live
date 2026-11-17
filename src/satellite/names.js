// What made a satellite report and what it holds, from BUFR code tables.
// Code tables 0 01 007 (satellite) and 0 02 019 (instrument), common entries only;
// anything else shows its code.

export const SATELLITE_NAMES = { 3: 'Metop-B', 4: 'Metop-A', 5: 'Metop-C', 55: 'Meteosat-8', 56: 'Meteosat-9', 57: 'Meteosat-10',
    70: 'Meteosat-11', 173: 'Himawari-8', 174: 'Himawari-9', 209: 'NOAA-18', 223: 'NOAA-19', 224: 'Suomi NPP',
    225: 'NOAA-20', 226: 'NOAA-21', 524: 'FY-3E', 270: 'GOES-16', 271: 'GOES-17', 272: 'GOES-18',
    750: 'COSMIC-2 E1', 751: 'COSMIC-2 E2', 752: 'COSMIC-2 E3', 753: 'COSMIC-2 E4', 754: 'COSMIC-2 E5', 755: 'COSMIC-2 E6' };
export const INSTRUMENT_NAMES = { 203: 'MHS', 221: 'IASI', 570: 'AMSU-A', 591: 'AVHRR/3', 616: 'VIIRS', 620: 'CrIS', 621: 'ATMS' };
// Code table 0 02 023: which channel cloud-motion winds were tracked in
export const AMV_METHODS = { 1: 'Infrared', 2: 'Visible', 3: 'Water vapour (cloud)', 4: 'Several channels', 5: 'Water vapour (clear air)',
    6: 'Ozone', 7: 'Water vapour' };
// Code table 0 08 072
export const PIXEL_TYPES = { 0: 'Mixed', 1: 'Clear', 2: 'Cloudy', 3: 'Probably clear', 4: 'Probably cloudy', 5: 'Ash' };
