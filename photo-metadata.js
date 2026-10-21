(function () {
  piexif.TAGS.Exif[0x9010] = { name: 'OffsetTime', type: 'Ascii' };
  piexif.TAGS.Exif[0x9011] = { name: 'OffsetTimeOriginal', type: 'Ascii' };
  piexif.TAGS.Exif[0x9012] = { name: 'OffsetTimeDigitized', type: 'Ascii' };

  async function dataUrl(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 32768) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    }
    return 'data:image/jpeg;base64,' + btoa(binary);
  }

  function toBlob(url) {
    const binary = atob(url.slice(url.indexOf(',') + 1));
    return new Blob([Uint8Array.from(binary, character => character.charCodeAt(0))], { type: 'image/jpeg' });
  }

  async function read(blob) {
    try {
      return piexif.load(await dataUrl(blob));
    } catch (error) {
      return { '0th': {}, Exif: {}, GPS: {}, '1st': {}, thumbnail: null };
    }
  }

  function coordinate(values) {
    if (!Array.isArray(values) || values.length !== 3) return NaN;
    const parts = values.map(value => Array.isArray(value) && value[1] > 0 ? value[0] / value[1] : NaN);
    if (parts.some(value => !Number.isFinite(value) || value < 0) || parts[1] >= 60 || parts[2] >= 60) return NaN;
    return parts[0] + parts[1] / 60 + parts[2] / 3600;
  }

  function missing(exif) {
    const result = [];
    const date = exif.Exif[piexif.ExifIFD.DateTimeOriginal] || '';
    const match = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(date);
    const parsed = match ? new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`) : null;
    if (!parsed || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== date.replace(/^(\d{4}):(\d{2}):(\d{2}) /, '$1-$2-$3T')) result.push('original capture date/time');
    const gps = exif.GPS;
    const latitude = coordinate(gps[piexif.GPSIFD.GPSLatitude]);
    const longitude = coordinate(gps[piexif.GPSIFD.GPSLongitude]);
    if (!Number.isFinite(latitude) || latitude > 90 || !Number.isFinite(longitude) || longitude > 180 ||
        !['N', 'S'].includes(gps[piexif.GPSIFD.GPSLatitudeRef]) ||
        !['E', 'W'].includes(gps[piexif.GPSIFD.GPSLongitudeRef])) result.push('GPS location');
    return result;
  }

  async function requireMetadata(blob) {
    const exif = await read(blob);
    const absent = missing(exif);
    if (absent.length) throw new Error('Photo missing ' + absent.join(' and ') + '. Use Camera with location enabled, or upload the original JPEG with camera location metadata.');
    return exif;
  }

  async function restore(compressed, original, width, height) {
    const exif = await requireMetadata(original);
    exif['0th'][piexif.ImageIFD.Orientation] = 1;
    if (Number.isFinite(width) && Number.isFinite(height)) {
      exif['0th'][piexif.ImageIFD.ImageWidth] = width;
      exif['0th'][piexif.ImageIFD.ImageLength] = height;
      exif.Exif[piexif.ExifIFD.PixelXDimension] = width;
      exif.Exif[piexif.ExifIFD.PixelYDimension] = height;
    }
    exif['1st'] = {};
    exif.thumbnail = null;
    return toBlob(piexif.insert(piexif.dump(exif), await dataUrl(compressed)));
  }

  function position() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) { reject(new Error('Location is unavailable. Use a browser with camera and location access.')); return; }
      navigator.geolocation.getCurrentPosition(resolve, () => reject(new Error('Location is required for photo evidence. Enable location permission and try again.')), {
        enableHighAccuracy: true, maximumAge: 10000, timeout: 15000,
      });
    });
  }

  async function stampCapture(blob, capturedAt, location) {
    const coords = location && location.coords;
    if (!coords || !Number.isFinite(coords.latitude) || !Number.isFinite(coords.longitude) ||
        Math.abs(coords.latitude) > 90 || Math.abs(coords.longitude) > 180 ||
        !Number.isFinite(location.timestamp) || Math.abs(capturedAt.getTime() - location.timestamp) > 60000) {
      throw new Error('A fresh GPS location is required before taking this photo.');
    }
    const date = capturedAt.toISOString().slice(0, 19).replace(/-/g, ':').replace('T', ' ');
    const exif = { '0th': {}, Exif: {}, GPS: {}, '1st': {}, thumbnail: null };
    exif['0th'][piexif.ImageIFD.DateTime] = date;
    exif['0th'][piexif.ImageIFD.Orientation] = 1;
    exif.Exif[piexif.ExifIFD.DateTimeOriginal] = date;
    exif.Exif[piexif.ExifIFD.DateTimeDigitized] = date;
    exif.Exif[0x9010] = '+00:00';
    exif.Exif[0x9011] = '+00:00';
    exif.Exif[0x9012] = '+00:00';
    const rational = value => [[Math.round(Math.abs(value) * 10000000), 10000000], [0, 1], [0, 1]];
    exif.GPS[piexif.GPSIFD.GPSVersionID] = [2, 3, 0, 0];
    exif.GPS[piexif.GPSIFD.GPSLatitudeRef] = coords.latitude < 0 ? 'S' : 'N';
    exif.GPS[piexif.GPSIFD.GPSLatitude] = rational(coords.latitude);
    exif.GPS[piexif.GPSIFD.GPSLongitudeRef] = coords.longitude < 0 ? 'W' : 'E';
    exif.GPS[piexif.GPSIFD.GPSLongitude] = rational(coords.longitude);
    exif.GPS[piexif.GPSIFD.GPSDateStamp] = date.slice(0, 10);
    exif.GPS[piexif.GPSIFD.GPSTimeStamp] = [[capturedAt.getUTCHours(), 1], [capturedAt.getUTCMinutes(), 1], [capturedAt.getUTCSeconds(), 1]];
    return toBlob(piexif.insert(piexif.dump(exif), await dataUrl(blob)));
  }

  window.PhotoMetadata = { read, missing, requireMetadata, restore, position, stampCapture };
}());