const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const piexif = require('./piexif.js');

const context = { window: {}, piexif, Blob, btoa, atob, Date, Uint8Array, Number, Math, Error, navigator: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'photo-metadata.js'), 'utf8'), context);
const metadata = context.window.PhotoMetadata;
const jpeg = new Blob([Uint8Array.from([255, 216, 255, 218, 0, 2, 255, 217])], { type: 'image/jpeg' });
const capturedAt = new Date('2026-10-21T20:30:15Z');
const location = { timestamp: capturedAt.getTime(), coords: { latitude: 21.3, longitude: -157.8 } };

function fixture(exif) {
  const binary = piexif.insert(piexif.dump(exif), 'data:image/jpeg;base64,/9j/2gAC/9k=');
  return new Blob([Buffer.from(binary.slice(binary.indexOf(',') + 1), 'base64')], { type: 'image/jpeg' });
}

test('live capture embeds shutter time, UTC offsets, GPS coordinates, and GPS time', async () => {
  const exif = await metadata.requireMetadata(await metadata.stampCapture(jpeg, capturedAt, location));
  assert.equal(exif.Exif[piexif.ExifIFD.DateTimeOriginal], '2026:10:21 20:30:15');
  assert.equal(exif.Exif[0x9011], '+00:00');
  assert.equal(exif.GPS[piexif.GPSIFD.GPSLatitudeRef], 'N');
  assert.equal(exif.GPS[piexif.GPSIFD.GPSLongitudeRef], 'W');
  assert.equal(exif.GPS[piexif.GPSIFD.GPSDateStamp], '2026:10:21');
  assert.ok(Math.abs(piexif.GPSHelper.dmsRationalToDeg(exif.GPS[4], 'W') + 157.8) < 0.000001);
});

test('compression preserves original camera time, timezone, and GPS while correcting dimensions', async () => {
  const exif = await metadata.read(await metadata.stampCapture(jpeg, capturedAt, location));
  exif.Exif[piexif.ExifIFD.DateTimeOriginal] = '2025:09:03 10:12:34';
  exif.Exif[0x9011] = '-10:00';
  exif['0th'][piexif.ImageIFD.Make] = 'Camera manufacturer';
  exif['0th'][piexif.ImageIFD.Orientation] = 6;
  const compressed = await metadata.restore(jpeg, fixture(exif), 1920, 1440);
  const restored = await metadata.requireMetadata(compressed);
  assert.equal(restored.Exif[piexif.ExifIFD.DateTimeOriginal], '2025:09:03 10:12:34');
  assert.equal(restored.Exif[0x9011], '-10:00');
  assert.equal(restored['0th'][piexif.ImageIFD.Make], 'Camera manufacturer');
  assert.deepEqual(restored.GPS, exif.GPS);
  assert.equal(restored['0th'][piexif.ImageIFD.Orientation], 1);
  assert.equal(restored.Exif[piexif.ExifIFD.PixelXDimension], 1920);
  assert.equal(restored.Exif[piexif.ExifIFD.PixelYDimension], 1440);
});

test('missing metadata is rejected rather than replaced with modified or upload time', async () => {
  jpeg.lastModified = capturedAt.getTime();
  await assert.rejects(metadata.requireMetadata(jpeg), /capture date\/time and GPS location/);
  await assert.rejects(metadata.restore(jpeg, jpeg), /capture date\/time and GPS location/);
  await assert.rejects(metadata.requireMetadata(new Blob(['not an image'])), /capture date\/time and GPS location/);
});

test('invalid original date and missing GPS each prevent acceptance', async () => {
  const exif = await metadata.read(await metadata.stampCapture(jpeg, capturedAt, location));
  exif.Exif[piexif.ExifIFD.DateTimeOriginal] = '2026:02:30 20:30:15';
  await assert.rejects(metadata.requireMetadata(fixture(exif)), /capture date\/time/);
  exif.Exif[piexif.ExifIFD.DateTimeOriginal] = '2026:10:21 20:30:15';
  exif.GPS = {};
  await assert.rejects(metadata.requireMetadata(fixture(exif)), /GPS location/);
});

test('stale, missing, or invalid locations cannot be stamped onto a new capture', async () => {
  await assert.rejects(metadata.stampCapture(jpeg, capturedAt, null), /fresh GPS/);
  await assert.rejects(metadata.stampCapture(jpeg, capturedAt, { ...location, timestamp: location.timestamp - 61000 }), /fresh GPS/);
  await assert.rejects(metadata.stampCapture(jpeg, capturedAt, { ...location, coords: { latitude: 91, longitude: 0 } }), /fresh GPS/);
});

test('unavailable or denied device location returns a permission error', async () => {
  await assert.rejects(metadata.position(), /Location is unavailable/);
  context.navigator.geolocation = { getCurrentPosition(resolve, reject) { reject({ code: 1 }); } };
  await assert.rejects(metadata.position(), /Enable location permission/);
});