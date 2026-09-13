/**
 * Mapterhorn Terrain Provider for Cesium
 *
 * Mapterhorn (https://mapterhorn.com) serves public global terrain tiles:
 *   - XYZ layout: https://tiles.mapterhorn.com/{z}/{x}/{y}.webp
 *   - Terrarium encoding: elevation = (R * 256 + G + B / 256) - 32768
 *   - 512x512 px tiles, global coverage, max zoom level 14
 *   - CORS enabled (Access-Control-Allow-Origin: *)
 *
 * This is a custom Cesium TerrainProvider that downloads each .webp elevation
 * tile, decodes it to a heightmap with an offscreen canvas, and hands it to
 * Cesium. Combined with any imagery layer (OSM, satellite, custom
 * backgrounds), this gives real terrain elevation for ALL 3D layers.
 *
 * Global helper: setMapterhornTerrain(scene, enable)
 */
(function (global) {
    'use strict';

    if (typeof Cesium === 'undefined') {
        console.warn('Mapterhorn terrain provider: Cesium not loaded, skipping.');
        return;
    }

    var MAPTERHORN_TILE_URL = 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp';
    var MAPTERHORN_MAX_ZOOM = 14;
    var MAPTERHORN_TILE_SIZE = 512;
    var HEIGHTMAP_WIDTH = 65; // Same sample size Cesium uses for its ellipsoid heightmaps

    // --- Tile fetch cache (capped) -------------------------------------------
    var tileCache = new Map(); // "z/x/y" -> Promise<ArrayBuffer | null>
    var MAX_CACHE_SIZE = 150;

    function fetchMapterhornTile(z, x, y) {
        var key = z + '/' + x + '/' + y;
        var cached = tileCache.get(key);
        if (cached) {
            return cached;
        }
        var promise = fetch(MAPTERHORN_TILE_URL
            .replace('{z}', z)
            .replace('{x}', x)
            .replace('{y}', y))
            .then(function (response) {
                // 404 = no data for this tile (ocean holes etc.) -> flat tile
                return response.ok ? response.arrayBuffer() : null;
            })
            .catch(function (error) {
                console.warn('Mapterhorn tile fetch failed ' + key + ':', error);
                return null;
            });
        // Simple cap: evict oldest entries (Map keeps insertion order)
        if (tileCache.size >= MAX_CACHE_SIZE) {
            var firstKey = tileCache.keys().next().value;
            tileCache.delete(firstKey);
        }
        tileCache.set(key, promise);
        return promise;
    }

    // --- Terrarium decode -----------------------------------------------------
    var decodeCanvas = null;

    function getDecodeContext(size) {
        if (!decodeCanvas) {
            decodeCanvas = document.createElement('canvas');
        }
        if (decodeCanvas.width !== size || decodeCanvas.height !== size) {
            decodeCanvas.width = size;
            decodeCanvas.height = size;
        }
        return decodeCanvas.getContext('2d', { willReadFrequently: true });
    }

    function loadImage(buffer) {
        var blob = new Blob([buffer], { type: 'image/webp' });
        if (typeof createImageBitmap === 'function') {
            return createImageBitmap(blob);
        }
        return new Promise(function (resolve, reject) {
            var image = new Image();
            var blobUrl = URL.createObjectURL(blob);
            image.onload = function () {
                URL.revokeObjectURL(blobUrl);
                resolve(image);
            };
            image.onerror = function () {
                URL.revokeObjectURL(blobUrl);
                reject(new Error('Mapterhorn tile image decode failed'));
            };
            image.src = blobUrl;
        });
    }

    /**
     * Decode a terrarium-encoded elevation tile into a Float32Array heightmap.
     * Terrarium formula: height = (R * 256 + G + B / 256) - 32768
     * Samples the source tile at (width x height) evenly spaced points.
     */
    function decodeTerrarium(image, width, height) {
        var size = image.width; // square tiles (512 expected)
        var ctx = getDecodeContext(size);
        ctx.clearRect(0, 0, size, size);
        ctx.drawImage(image, 0, 0, size, size);
        var data = ctx.getImageData(0, 0, size, size).data;
        var heights = new Float32Array(width * height);
        var stride = (size - 1) / (width - 1); // 511 / 64 = 7.98... for 512->65
        var i = 0;
        for (var yy = 0; yy < height; yy++) {
            var srcY = Math.min(Math.round(yy * stride), size - 1);
            for (var xx = 0; xx < width; xx++) {
                var srcX = Math.min(Math.round(xx * stride), size - 1);
                var px = (srcY * size + srcX) * 4;
                heights[i++] = (data[px] * 256 + data[px + 1] + data[px + 2] / 256) - 32768;
            }
        }
        return heights;
    }

    function createFlatTile(width) {
        return new Cesium.HeightmapTerrainData({
            buffer: new Float32Array(width * width),
            width: width,
            height: width
        });
    }

    // --- TerrainProvider implementation ---------------------------------------
    function MapterhornTerrainProvider(options) {
        options = options || {};
        this._errorEvent = new Cesium.Event();
        this._credit = new Cesium.Credit(
            'Terrain: <a href="https://mapterhorn.com/attribution" target="_blank">© Mapterhorn</a>'
        );
        // Mapterhorn uses the standard XYZ (web mercator) tile grid
        this._tilingScheme = new Cesium.WebMercatorTilingScheme();
        this._heightmapWidth = HEIGHTMAP_WIDTH;
        this._ready = true;
        this._readyPromise = Promise.resolve(true);
        // Match EllipsoidTerrainProvider's LOD error so the globe refines smoothly
        this._levelZeroMaximumGeometricError = Cesium.TerrainProvider.getEstimatedLevelZeroGeometricErrorForAHeightmap(
            this._tilingScheme.ellipsoid,
            HEIGHTMAP_WIDTH,
            2
        );
    }

    Object.defineProperties(MapterhornTerrainProvider.prototype, {
        errorEvent: {
            get: function () {
                return this._errorEvent;
            }
        },
        credit: {
            get: function () {
                return this._credit;
            }
        },
        tilingScheme: {
            get: function () {
                return this._tilingScheme;
            }
        },
        ready: {
            get: function () {
                return this._ready;
            }
        },
        readyPromise: {
            get: function () {
                return this._readyPromise;
            }
        },
        hasWaterMask: {
            get: function () {
                return false;
            }
        },
        hasVertexNormals: {
            get: function () {
                return false;
            }
        },
        heightmapWidth: {
            get: function () {
                return this._heightmapWidth;
            }
        }
    });

    MapterhornTerrainProvider.prototype.requestTileGeometry = function (x, y, level) {
        var self = this;
        var width = self._heightmapWidth;
        if (level > MAPTERHORN_MAX_ZOOM) {
            // Safety net: should not be requested since getTileDataAvailable
            // reports false beyond the max zoom.
            return Promise.resolve(createFlatTile(width));
        }
        return fetchMapterhornTile(level, x, y)
            .then(function (buffer) {
                if (!buffer) {
                    // No data (e.g. open ocean): flat sea-level tile
                    return createFlatTile(width);
                }
                return loadImage(buffer).then(function (image) {
                    try {
                        return new Cesium.HeightmapTerrainData({
                            buffer: decodeTerrarium(image, width, width),
                            width: width,
                            height: width
                        });
                    } catch (error) {
                        console.warn('Mapterhorn tile decode failed ' + level + '/' + x + '/' + y + ':', error);
                        return createFlatTile(width);
                    }
                });
            });
    };

    MapterhornTerrainProvider.prototype.getLevelMaximumGeometricError = function (level) {
        return this._levelZeroMaximumGeometricError / (1 << level);
    };

    MapterhornTerrainProvider.prototype.getTileDataAvailable = function (x, y, level) {
        // Data is capped at zoom 14: stop refinement beyond it
        return level <= MAPTERHORN_MAX_ZOOM;
    };

    MapterhornTerrainProvider.prototype.loadTileDataAvailability = function () {
        return undefined;
    };

    // --- Export ----------------------------------------------------------------
    global.MapterhornTerrainProvider = MapterhornTerrainProvider;

    /**
     * Enable (real Mapterhorn terrain) or disable (flat ellipsoid) terrain on a
     * Cesium scene. Used by the 3D toggle in src/index.js.
     */
    global.setMapterhornTerrain = function (scene, enable) {
        if (!scene || typeof Cesium === 'undefined') {
            return;
        }
        if (enable) {
            if (!(scene.terrainProvider instanceof MapterhornTerrainProvider)) {
                scene.terrainProvider = new MapterhornTerrainProvider();
                console.log('Mapterhorn terrain enabled (elevation tiles up to zoom ' + MAPTERHORN_MAX_ZOOM + ')');
            }
        } else {
            if (scene.terrainProvider instanceof MapterhornTerrainProvider) {
                scene.terrainProvider = new Cesium.EllipsoidTerrainProvider();
                console.log('Mapterhorn terrain disabled, back to flat ellipsoid');
            }
        }
    };

})(typeof window !== 'undefined' ? window : this);
