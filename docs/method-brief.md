# Focos method brief

One page to learn before the pitch. Every number here comes from the pipeline's own output (`pipeline/data/calibration.json` and `validation.json`).

## The idea in four sentences

MODIS has counted fires since the early 2000s and is ending. VIIRS replaces it, but its pixels are sharper (375 m against 1 km) and it detects much smaller fires, so over Argentina it reports about five times as many hotspots. We work out how many MODIS detections each VIIRS detection is worth, using the years when both satellites flew, and we test that on years the method never saw. The result is one fire record from 2003 to now that can be read as a single MODIS-equivalent series, with a known error.

## The steps

1. **Pick a matched pair.** Aqua MODIS and S-NPP VIIRS both cross in the early afternoon, so they look at the same fires at the same time of day. Terra crosses in the morning and is left out; adding satellites over time would fake an upward trend.
2. **Clean both the same way.** Keep presumed vegetation fires (`type` 0), drop low-confidence detections, drop exact duplicates, and date everything by local solar time.
3. **Count in one unit.** A fire cell-pass is one 0.01° cell (about 1 km), on one local date, by day or by night. Five VIIRS pixels in one cell-pass count once. This removes part of the resolution difference before any statistics; the ratios in step 4 handle the rest.
4. **Calibrate.** For each 5° block, season and day/night, the ratio k = Aqua cell-passes ÷ VIIRS cell-passes. Where a block has little data, k is pulled toward the national ratio. By day k is about 0.31 to 0.40; at night about 0.06 to 0.14, because VIIRS sees far more night fire than MODIS does.
5. **Weight every hotspot.** A VIIRS pixel gets k divided by the pixels in its cell-pass. An Aqua pixel gets 1 divided by the pixels in its cell-pass. Every number in the app is a sum of weights.
6. **Hand over when a satellite ends.** Aqua carries the record to January 2012 and S-NPP from February 2012. S-NPP stopped delivering data on 2 November 2026, so NOAA-20, its twin, carries the record from November 2026 with ratios fitted the same way. NOAA-20 also carries the 62 days, from January 2019 to August 2026, on which S-NPP delivered no data.

## How we know it works

- **The choice was made without looking at the answer.** Three methods were scored by leaving out one year at a time inside 2012–2019. Errors: one national ratio 20.8%, block ratios 17.2%, strength-aware 17.7%. The rule, fixed in advance, takes the simplest method within 10% of the best. That is the block-ratio method.
- **The test years were held back.** On 2020 and 2021, for a province in a month with at least 20 hotspots, the typical error is 17%. Stitching the raw counts together is off by 432%. Nationally the record ran 2.7% under Aqua in 2020 and 5.0% over in 2021.
- **The second handover was tested too.** NOAA-20, fitted on 2018–2019, has a national bias of −1.9% against Aqua on the same test years (monthly error 7.1%) and −2.2% against S-NPP over 2022–2025 (3.9%).
- **One finding.** Raw counts say 2020 had 5.5 times the fire of 2003 (400,944 against 72,997). Harmonized, the two years are level within the error (70,369 and 70,344).
- **It was checked a second time.** A separate review, by a fresh AI session (Claude) that had not written the code, recomputed every headline number and found no leak from the test years. It also found a kind of outage the first rule missed, which was fixed; the results are the recomputed ones.

## Ten questions a judge may ask

1. **Why not just use VIIRS?** It starts in 2012. Without 2003–2011 nobody knows what a normal year looks like.
2. **Why turn VIIRS into MODIS, and not the other way?** Small fires that MODIS never recorded cannot be recreated. Which VIIRS fires MODIS would have seen can be estimated and tested.
3. **Why Aqua and not Terra?** Aqua and S-NPP pass at the same time of day. Fire has a strong daily cycle, so a morning satellite sees a different set of fires.
4. **What is a fire cell-pass?** One 1 km cell, one day, day or night, one sensor. It stops one large fire from being counted many times by the sharper sensor.
5. **How big is the error?** About 8% for the whole country in a month, 17% for a province and 23% for a 1° square, when the month has at least 20 hotspots. With less fire it grows: 43% for 5 to 19 hotspots, and counts below 5 are only indicative. Extreme months are understated: about 9% low when a month is 5 to 10 times its usual level and 11% low at 10 times or more, and 41% low in the worst case we found (Corrientes, February 2022: 1,970 against Aqua's own 3,361). The month is still flagged as the highest February since 2003. Nine provinces also run persistently high or low by more than 15% (Neuquén is the worst at +68%, most likely from fixed heat sources labelled as fire); the app flags them.
6. **Could you have tuned it on the test years?** No. The model file was frozen before the test years were opened, and the code refuses to fit on them before the freeze.
7. **What about days a satellite was down?** A day counts as an outage when the sensor reports nothing, or nothing by day, while another satellite saw enough fire that at least 10 detections were expected. Those days are left out of calibration and testing. In the record itself, NOAA-20 fills the days S-NPP lost (62 days from 2019 to 2026), so no month is marked incomplete today. This was added after the test and does not change its results.
8. **Aqua's orbit has drifted. Does that matter?** Yes. From 2023 the ratio of Aqua to our record rises (1.06, 1.16, 1.09 in 2023–2025). A later overpass would do that. In 2026, a year with little fire, it is 0.92 up to S-NPP's last day, because the record reads high in quiet months. S-NPP outages in 2024 and a change of MODIS collection in 2023 may add to it; we do not claim to have proven the cause.
9. **What can't it do?** It does not see fire under cloud, it does not measure burned area, and it does not forecast.
10. **Does it work outside Argentina?** The pipeline takes any FIRMS country file. Each country needs its own calibration, fitted with one command, and its own held-out test before its numbers can be trusted.
