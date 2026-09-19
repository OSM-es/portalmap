/**
 * 3D feature info (click on node/way/relation results in 3D mode)
 * ---------------------------------------------------------------
 * In 3D mode the OpenLayers singleclick handler in index.js cannot hit-test
 * vector features (the 2D canvas doesn't draw them). ol-cesium tags every
 * Cesium primitive / billboard / label it creates with `olFeature` and
 * `olLayer` references, so Cesium picking recovers the original OL feature
 * and we can show the SAME info dialog as in 2D (tags, id, user, changeset,
 * opening hours...) by reusing config.forFeatureAtPixel().
 *
 * Loaded after src/index.js (see index.html) so window.map/config exist.
 */
(function () {
	'use strict';

	if (typeof Cesium === 'undefined' || typeof ol === 'undefined') {
		console.warn('click3d: Cesium/OL not loaded, 3D feature info disabled.');
		return;
	}

	// Debounce guard against duplicated click events (OL singleclick + Cesium)
	var lastClickTime = 0;

	function is3DEnabled() {
		return !!(window.ol3d && typeof window.ol3d.getEnabled === 'function' && window.ol3d.getEnabled());
	}

	/**
	 * Map a click to the unique OL features under the cursor.
	 * Uses drillPick to see through stacked primitives; dedupes by identity.
	 */
	function pickOlFeatures(scene, x, y) {
		var picked = [];
		try {
			var objects = scene.drillPick({ x: x, y: y }, 20) || [];
			objects.forEach(function (o) {
				var feature = null;
				if (o && o.id && o.id.olFeature) {
					// Entity path (billboards/labels via DataSourceDisplay)
					feature = o.id.olFeature;
				} else if (o && o.primitive && o.primitive.olFeature) {
					// Primitive path (ground polylines/primitives)
					feature = o.primitive.olFeature;
				} else if (o && o.olFeature) {
					feature = o.olFeature;
				}
				if (feature && picked.indexOf(feature) === -1) {
					picked.push(feature);
				}
			});
		} catch (e) {
			console.warn('click3d: picking failed:', e);
		}
		return picked;
	}

	/**
	 * Anchor point (lon, lat) for the pin: geometry center for ways/areas.
	 */
	function getFeatureLonLat(feature) {
		try {
			var geometry = feature.getGeometry();
			if (!geometry) return null;
			var coords;
			if (geometry.getType() === 'Point') {
				coords = geometry.getCoordinates();
			} else {
				coords = ol.extent.getCenter(geometry.getExtent());
			}
			var ll = ol.proj.toLonLat(coords);
			if (!ll || !isFinite(ll[0]) || !isFinite(ll[1])) return null;
			return { lon: ll[0], lat: ll[1] };
		} catch (e) {
			return null;
		}
	}

	/**
	 * Build the feature info block reusing the app's own 2D formatter, so the
	 * dialog content is identical to the 2D popup (tags, id, meta, hours...).
	 */
	function buildFeatureInfo(feature) {
		var info = $('<div>');
		if (typeof config !== 'undefined' && typeof config.forFeatureAtPixel === 'function') {
			try {
				info.append(config.forFeatureAtPixel.call(window.map, null, feature));
			} catch (e) {
				console.error('click3d: error building feature info:', e);
				info.append($('<div>').html('Error processing feature: ' + (feature.getId() || '?')));
			}
		} else {
			info.append($('<div>').html('No information available for this object'));
		}
		return info;
	}

	/**
	 * Show the info dialog plus a pin overlay anchored to the terrain surface.
	 */
	function showFeatureDialog(feature) {
		var featureLL = getFeatureLonLat(feature) || { lon: 0, lat: 0 };
		var title = ol.coordinate.format([featureLL.lat, featureLL.lon], '[{y}, {x}]', 5);
		var pinOverlay = null;

		// Terrain height (async): place the pin 1 m above ground
		var positionPromise;
		try {
			var scene = window.ol3d.getCesiumScene();
			var carto = Cesium.Cartographic.fromDegrees(featureLL.lon, featureLL.lat);
			positionPromise = Cesium.sampleTerrainMostDetailed(scene.terrainProvider, [carto])
				.then(function (positions) {
					var h = (positions && positions[0] && isFinite(positions[0].height)) ? positions[0].height : 0;
					return Cesium.Cartesian3.fromDegrees(featureLL.lon, featureLL.lat, Math.max(h, 0) + 1);
				})
				.catch(function () {
					return Cesium.Cartesian3.fromDegrees(featureLL.lon, featureLL.lat, 1);
				});
		} catch (e) {
			positionPromise = Promise.resolve(Cesium.Cartesian3.fromDegrees(featureLL.lon, featureLL.lat, 1));
		}

		positionPromise.then(function (cartesian) {
			try {
				pinOverlay = new ol.Overlay({
					element: $('<div>').addClass('osmcat-map-pin').attr('title', title).html('<i class="fa fa-map-pin"></i>')[0],
					positioning: 'bottom-center',
					stopEvent: false,
					position: ol.proj.fromLonLat([featureLL.lon, featureLL.lat])
				});
				window.map.addOverlay(pinOverlay);
			} catch (pinError) {
				console.warn('click3d: could not add pin overlay:', pinError);
				pinOverlay = null;
			}

			// The dialog mirrors the 2D popup (same content builder).
			var $dialog = $('<div>').html(buildFeatureInfo(feature)).dialog({
				title: title,
				dialogClass: 'portal-3d-info-dialog',
				close: function () {
					$(this).dialog('destroy');
					if (pinOverlay && window.map) {
						try { window.map.removeOverlay(pinOverlay); } catch (e) {}
					}
				}
			});
			try { $dialog.dialog('moveToTop'); } catch (e) {}
		});
	}

	/**
	 * Main handler for clicks in 3D mode.
	 */
	function handle3DClick(detail) {
		if (!is3DEnabled()) return;

		// Debounce: ignore duplicate events within 250 ms
		var now = Date.now();
		if (now - lastClickTime < 250) return;
		lastClickTime = now;

		var scene = window.ol3d.getCesiumScene();
		if (!scene || !scene.canvas) return;

		// Convert click coordinates to Cesium canvas space
		var x, y;
		var orig = detail && detail.originalEvent;
		if (orig && isFinite(orig.clientX) && isFinite(orig.clientY)) {
			var rect = scene.canvas.getBoundingClientRect();
			x = Math.round(orig.clientX - rect.left);
			y = Math.round(orig.clientY - rect.top);
		} else if (detail && detail.pixel) {
			// Fallback: OL pixel ≈ canvas pixel (the Cesium canvas fills the map div)
			x = Math.round(detail.pixel[0]);
			y = Math.round(detail.pixel[1]);
		} else {
			return;
		}

		var features = pickOlFeatures(scene, x, y);
		if (features.length === 0) {
			console.log('click3d: no feature picked at', x, y);
			return;
		}

		// Show the first (topmost) feature; extras are logged for debugging
		if (features.length > 1) {
			console.log('click3d: multiple features picked, showing first:', features.length);
		}
		showFeatureDialog(features[0]);
	}

	// The OL singleclick handler in index.js dispatches this in 3D mode
	// (OL vector layers aren't hit-testable there), so we don't need a
	// separate Cesium click listener.
	window.addEventListener('portal3DMapClick', function (e) {
		try {
			handle3DClick(e.detail || {});
		} catch (err) {
			console.error('click3d: error handling 3D click:', err);
		}
	});

	// Pointer cursor when hovering features in 3D
	window.addEventListener('portal3DPointerMove', function (e) {
		try {
			if (!is3DEnabled()) return;
			var scene = window.ol3d.getCesiumScene();
			var detail = e.detail || {};
			var x, y;
			var orig = detail.originalEvent;
			if (orig && isFinite(orig.clientX) && isFinite(orig.clientY)) {
				var rect = scene.canvas.getBoundingClientRect();
				x = Math.round(orig.clientX - rect.left);
				y = Math.round(orig.clientY - rect.top);
			} else if (detail.pixel) {
				x = Math.round(detail.pixel[0]);
				y = Math.round(detail.pixel[1]);
			} else {
				return;
			}
			var hits = pickOlFeatures(scene, x, y);
			$('#map').css('cursor', hits.length > 0 ? 'pointer' : 'grab');
		} catch (err) {
			// non-fatal
		}
	});

	console.log('click3d: 3D feature info ready');
})();
