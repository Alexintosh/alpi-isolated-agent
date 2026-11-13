'use strict';

// Fixed, verified archive identities. Selection never substitutes another image.
const DESKTOP_IMAGES = Object.freeze([
  Object.freeze({
    id: 'local-arm64', name: 'Local ARM64 · Chromium',
    architecture: 'arm64', browser: 'Chromium',
    provenance: 'Local adapted wrapvm-dsh:desktop image; Docker image ID sha256:84fe5bbb156936b79eb4d95e022944245ac62f65bc151d4e2134ebc442892315. Build provenance is not independently attested; this is not an unmodified upstream release.',
    sha256: 'f4143564dbe143660989d7f919ec99a1be92258d95d73d99020b855a742dd566',
    bytes: 6780605952, environmentId: 'wrapvm-arm64-v1',
  }),
  Object.freeze({
    id: 'stock-amd64', name: 'Official AMD64 · Google Chrome · Rosetta',
    architecture: 'x64', browser: 'Google Chrome',
    provenance: 'Official AMD64 WrapVM image, manifest sha256:30491fa51a779ffe3c0cc85fe6cb80319b86c64b1e0e7122e4fc8fe4fff175ea; runs through Rosetta.',
    sha256: 'e87b3757c0e05b97ca35291e1963e47b20d46c0a741886e39e0d4738b3a678df',
    bytes: 1394883072, environmentId: 'wrapvm-v1',
  }),
]);

function desktopImage(id) {
  const found = DESKTOP_IMAGES.find(item => item.id === id);
  if (!found) throw new Error('Unknown desktop image.');
  return found;
}

module.exports = { DESKTOP_IMAGES, desktopImage };
