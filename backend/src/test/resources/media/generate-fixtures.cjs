// Generates the image fixtures for ImageProcessorTest.
//
// Why a Node script rather than generating in the Java test: the JDK and TwelveMonkeys have no WebP writer, and
// cannot write EXIF/GPS either. sharp (already in frontend/node_modules) can do both. The script runs ONCE; the
// output is committed, so `mvn test` does not need Node.
//
// Run from the repo root (needs `npm ci` in frontend/ first):
//   node backend/src/test/resources/media/generate-fixtures.cjs
//
// Each image has a distinct colored patch in its "top-left corner" so the test proves the rotation DIRECTION, not
// just the width/height swap: a wrong rotation still resizes correctly but puts the colored patch in a different
// corner.
const path = require('node:path');
const sharp = require('../../../../../frontend/node_modules/sharp');

const out = (name) => path.join(__dirname, name);
const RED = { r: 255, g: 0, b: 0 };
const BLUE = { r: 0, g: 0, b: 255 };

// A 30×20 image with a blue background and a 15×10 red top-left quadrant.
function redTopLeft() {
  return sharp({ create: { width: 30, height: 20, channels: 3, background: BLUE } }).composite([
    {
      input: { create: { width: 15, height: 10, channels: 3, background: RED } },
      left: 0,
      top: 0,
    },
  ]);
}

(async () => {
  // Downsized phone photo: stored landscape, EXIF says "rotate 90° clockwise when displayed" (6), with synthetic GPS
  // (0/0, no real place) and a synthetic capture date, so the tests can prove both are stripped / read. 4:4:4 so the corner color is not blurred by the fixture's own chroma subsampling. Orientation must
  // go through withMetadata: libvips overwrites the Orientation tag in withExif with the image's own orientation
  // field (default 1), so `IFD0: { Orientation: '6' }` gets lost.
  await redTopLeft()
    .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
    .withMetadata({ orientation: 6 })
    .withExifMerge({
      IFD0: { Make: 'FixtureCam' },
      IFD2: { DateTimeOriginal: '2020:01:01 12:00:00' },
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '0/1 0/1 0/1',
        GPSLongitudeRef: 'E',
        GPSLongitude: '0/1 0/1 0/1',
      },
    })
    .toFile(out('orient6.jpg'));

  // WebP with EXIF Orientation=8 (rotate 90° counter-clockwise when displayed).
  await redTopLeft()
    .webp({ quality: 95 })
    .withMetadata({ orientation: 8 })
    .toFile(out('orient8.webp'));

  // 16×16 WebP half transparent (alpha 0.5 at every pixel): the output must be PNG.
  await sharp({
    create: { width: 16, height: 16, channels: 4, background: { r: 10, g: 120, b: 200, alpha: 0.5 } },
  })
    .webp({ quality: 90 })
    .toFile(out('alpha.webp'));

  // 24×24 CMYK JPEG (green in RGB): the JDK's JPEG reader rejects this kind, TwelveMonkeys can read it.
  await sharp({ create: { width: 24, height: 24, channels: 3, background: { r: 30, g: 160, b: 90 } } })
    .toColourspace('cmyk')
    .jpeg({ quality: 95 })
    .toFile(out('cmyk.jpg'));

  // Opaque 40×30 PNG: a screenshot/diagram, the output stays PNG.
  await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 0, g: 128, b: 128 } } })
    .composite([
      {
        input: { create: { width: 10, height: 10, channels: 3, background: { r: 255, g: 200, b: 0 } } },
        left: 5,
        top: 5,
      },
    ])
    .removeAlpha()
    .png()
    .toFile(out('opaque.png'));

  // PNG carrying a Display P3 profile (like an iPhone/Mac screenshot): pure sRGB red is converted by sharp to the P3
  // value (~234,51,35) and tagged with iCCP. The JDK's PNG reader ignores iCCP, so the pipeline must convert back to
  // sRGB itself.
  await sharp({ create: { width: 40, height: 30, channels: 3, background: RED } })
    .withIccProfile('p3')
    .png()
    .toFile(out('p3.png'));

  // Same color, half transparent: the color-conversion path splits off the alpha channel and merges it back.
  await sharp({ create: { width: 40, height: 30, channels: 4, background: { ...RED, alpha: 0.5 } } })
    .withIccProfile('p3')
    .png()
    .toFile(out('p3-alpha.png'));

  for (const name of ['orient6.jpg', 'orient8.webp', 'alpha.webp', 'cmyk.jpg', 'opaque.png', 'p3.png', 'p3-alpha.png']) {
    const m = await sharp(out(name)).metadata();
    console.log(
      name,
      `${m.format} ${m.width}x${m.height} space=${m.space} channels=${m.channels} alpha=${m.hasAlpha}`,
      `orientation=${m.orientation ?? '-'} exif=${m.exif ? m.exif.length : 0}B icc=${m.icc ? m.icc.length : 0}B`,
    );
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
