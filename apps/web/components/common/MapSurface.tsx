"use client";

import { useEffect, useRef, useState } from "react";
import {
  AttributionControl,
  GeoJSONSource,
  Map as MapLibreMap,
  MapLayerMouseEvent,
  NavigationControl,
  Popup,
  setWorkerUrl,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { RefreshCw } from "lucide-react";
import { mapConfig } from "@/lib/config/map";
import { cn } from "@/lib/utils/cn";
import type { ExperienceFeatureCollection } from "@/lib/geo/geojson";
import type { MapAnnotationCollection } from "@/types/map";

const SOURCE_ID = "experiences";
const CLUSTER_LAYER = "experience-clusters";
const CLUSTER_COUNT_LAYER = "experience-cluster-count";
const POINT_LAYER = "experience-points";
const ORIGIN_SOURCE_ID = "map-origin";
const ORIGIN_LAYER = "map-origin-point";
const ROUTE_SOURCE_ID = "map-route";
const ROUTE_LAYER = "map-route-line";
const ROUTE_ALTERNATIVE_SOURCE_ID = "map-route-alternatives";
const ROUTE_ALTERNATIVE_LAYER = "map-route-alternative-lines";
const ANNOTATION_SOURCE_ID = "map-annotations";
const ANNOTATION_CLUSTER_LAYER = "map-annotation-clusters";
const ANNOTATION_CLUSTER_COUNT_LAYER = "map-annotation-cluster-count";
const ANNOTATION_POINT_LAYER = "map-annotation-points";
const ANNOTATION_LABEL_LAYER = "map-annotation-labels";

const EMPTY_COLLECTION: ExperienceFeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

const EMPTY_ANNOTATIONS: MapAnnotationCollection = {
  type: "FeatureCollection",
  features: [],
};
const EMPTY_ROUTE_GEOMETRIES: GeoJSON.LineString[] = [];

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

function getThemeColor(name: string, fallback: string) {
  return (
    getComputedStyle(document.documentElement)
      .getPropertyValue(name)
      .trim() || fallback
  );
}

// MapLibre requires concrete color values for its layers, so read them
// from the app's CSS tokens when the map is initialized.
function getMapPalette() {
  return {
    primary: getThemeColor("--color-primary", "#19181b"),
    accent: getThemeColor("--color-accent", "#28785e"),
    highlight: getThemeColor("--color-highlight", "#9b5d17"),
    surface: getThemeColor("--color-surface", "#fffdf8"),
    ink: getThemeColor("--color-ink", "#1d1b20"),
    inkMuted: getThemeColor("--color-ink-muted", "#615e62"),
    inkSubtle: getThemeColor("--color-ink-subtle", "#878187"),
  };
}

// MapLibre GL v6 loads its render worker via import.meta.url-relative
// resolution, which Turbopack's dev server doesn't serve as a valid
// module route. Point it at the static copy in public/maplibre/.
setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");

export interface MapSurfaceProps {
  /** Selection state is encoded in `features` through `properties.selected`. */
  features?: ExperienceFeatureCollection;
  onSelectFeature?: (id: string) => void;
  origin?: { lat: number; lng: number } | null;
  routeGeometry?: GeoJSON.LineString | null;
  /** Additional generic route geometries; MapSurface has no itinerary knowledge. */
  routeGeometries?: GeoJSON.LineString[];
  /** Actual OSRM alternate-route geometries, never closure-verified. */
  routeAlternativeGeometries?: GeoJSON.LineString[];
  /** Optional clustered generic points, such as itinerary stops or nearby POIs. */
  annotations?: MapAnnotationCollection;
  onSelectAnnotation?: (id: string) => void;
  fitBounds?: [[number, number], [number, number]] | null;
  fitBoundsRequestId?: number;
  focusCoordinate?: { lat: number; lng: number } | null;
  focusRequestId?: number;
  onSearchThisArea?: (bounds: {
    minLat: number;
    maxLat: number;
    minLng: number;
    maxLng: number;
  }) => void;
  center?: { lat: number; lng: number };
  zoom?: number;
  className?: string;
  label?: string;
}

export function MapSurface({
  features = EMPTY_COLLECTION,
  onSelectFeature,
  origin = null,
  routeGeometry = null,
  routeGeometries = EMPTY_ROUTE_GEOMETRIES,
  routeAlternativeGeometries = EMPTY_ROUTE_GEOMETRIES,
  annotations = EMPTY_ANNOTATIONS,
  onSelectAnnotation,
  fitBounds = null,
  fitBoundsRequestId = 0,
  focusCoordinate = null,
  focusRequestId = 0,
  onSearchThisArea,
  center,
  zoom,
  className,
  label = "Experience map",
}: MapSurfaceProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const popupRef = useRef<Popup | null>(null);
  const [mapError, setMapError] = useState(false);
  const [showSearchArea, setShowSearchArea] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const onSelectFeatureRef = useRef(onSelectFeature);
  const onSelectAnnotationRef = useRef(onSelectAnnotation);

  useEffect(() => {
    onSelectFeatureRef.current = onSelectFeature;
    onSelectAnnotationRef.current = onSelectAnnotation;
  }, [onSelectFeature, onSelectAnnotation]);

  // Initialize the map once.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const palette = getMapPalette();

    let map: MapLibreMap;

    try {
      map = new MapLibreMap({
        container: containerRef.current,
        style: mapConfig.styleUrl,
        center: [
          center?.lng ?? mapConfig.defaultCenter.lng,
          center?.lat ?? mapConfig.defaultCenter.lat,
        ],
        zoom: zoom ?? mapConfig.defaultZoom,
        maxZoom: mapConfig.maxZoom,
        minZoom: mapConfig.minZoom,
        attributionControl: false,
      });
    } catch {
      queueMicrotask(() => setMapError(true));
      return;
    }

    mapRef.current = map;

    map.addControl(new NavigationControl({ showCompass: false }), "top-right");
    map.addControl(
      new AttributionControl({
        customAttribution: mapConfig.attributionHtml,
        compact: true,
      }),
      "bottom-right",
    );

    map.on("error", () => setMapError(true));

    map.on("load", () => {
      map.addSource(SOURCE_ID, {
        type: "geojson",
        data: EMPTY_COLLECTION,
        cluster: true,
        clusterMaxZoom: 14,
        clusterRadius: 45,
      });

      map.addLayer({
        id: CLUSTER_LAYER,
        type: "circle",
        source: SOURCE_ID,
        filter: ["has", "point_count"],
        paint: {
          "circle-color": palette.primary,
          "circle-radius": ["step", ["get", "point_count"], 16, 10, 20, 25, 26],
          "circle-stroke-width": 2,
          "circle-stroke-color": palette.surface,
        },
      });

      map.addLayer({
        id: CLUSTER_COUNT_LAYER,
        type: "symbol",
        source: SOURCE_ID,
        filter: ["has", "point_count"],
        layout: {
          "text-field": ["get", "point_count_abbreviated"],
          "text-size": 12,
          "text-font": ["Noto Sans Bold"],
        },
        paint: { "text-color": palette.surface },
      });

      map.addLayer({
        id: POINT_LAYER,
        type: "circle",
        source: SOURCE_ID,
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-radius": ["case", ["get", "selected"], 9, 6],
          "circle-color": [
            "case",
            ["get", "selected"],
            palette.accent,
            palette.primary,
          ],
          "circle-stroke-width": 2,
          "circle-stroke-color": palette.surface,
        },
      });

      map.addSource(ORIGIN_SOURCE_ID, {
        type: "geojson",
        data: EMPTY_COLLECTION,
      });
      map.addLayer({
        id: ORIGIN_LAYER,
        type: "circle",
        source: ORIGIN_SOURCE_ID,
        paint: {
          "circle-radius": 8,
          "circle-color": palette.highlight,
          "circle-stroke-width": 3,
          "circle-stroke-color": palette.surface,
        },
      });

      map.addSource(ROUTE_SOURCE_ID, {
        type: "geojson",
        data: EMPTY_COLLECTION,
      });
      map.addLayer({
        id: ROUTE_LAYER,
        type: "line",
        source: ROUTE_SOURCE_ID,
        layout: {
          "line-join": "round",
          "line-cap": "round",
        },
        paint: {
          "line-color": palette.accent,
          "line-width": 4,
          "line-opacity": 0.85,
        },
      });

      map.addSource(ROUTE_ALTERNATIVE_SOURCE_ID, {
        type: "geojson",
        data: EMPTY_COLLECTION,
      });
      map.addLayer({
        id: ROUTE_ALTERNATIVE_LAYER,
        type: "line",
        source: ROUTE_ALTERNATIVE_SOURCE_ID,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": palette.highlight,
          "line-width": 4,
          "line-opacity": 0.9,
          "line-dasharray": [2, 1.5],
        },
      });

      map.addSource(ANNOTATION_SOURCE_ID, {
        type: "geojson",
        data: EMPTY_ANNOTATIONS,
        cluster: true,
        clusterMaxZoom: 14,
        clusterRadius: 40,
      });
      map.addLayer({
        id: ANNOTATION_CLUSTER_LAYER,
        type: "circle",
        source: ANNOTATION_SOURCE_ID,
        filter: ["has", "point_count"],
        paint: {
          "circle-color": palette.primary,
          "circle-radius": ["step", ["get", "point_count"], 15, 10, 19, 25, 24],
          "circle-stroke-width": 2,
          "circle-stroke-color": palette.surface,
        },
      });
      map.addLayer({
        id: ANNOTATION_CLUSTER_COUNT_LAYER,
        type: "symbol",
        source: ANNOTATION_SOURCE_ID,
        filter: ["has", "point_count"],
        layout: {
          "text-field": ["get", "point_count_abbreviated"],
          "text-size": 12,
          "text-font": ["Noto Sans Bold"],
        },
        paint: { "text-color": palette.surface },
      });
      map.addLayer({
        id: ANNOTATION_POINT_LAYER,
        type: "circle",
        source: ANNOTATION_SOURCE_ID,
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-radius": ["case", ["==", ["get", "tone"], "selected"], 13, ["==", ["get", "kind"], "social"], 11, 10],
          "circle-color": [
            "case",
            ["get", "affected"], palette.highlight,
            ["==", ["get", "tone"], "selected"], palette.accent,
            ["get", "scenarioAffected"], palette.primary,
            ["all", ["==", ["get", "kind"], "social"], ["==", ["get", "severity"], "high"]], palette.highlight,
            ["all", ["==", ["get", "kind"], "social"], ["==", ["get", "severity"], "moderate"]], palette.accent,
            palette.primary,
          ],
          "circle-stroke-width": ["case", ["get", "locked"], 3, ["get", "scenarioAffected"], 3, 2],
          "circle-stroke-color": ["case", ["get", "locked"], palette.highlight, ["==", ["get", "tone"], "selected"], palette.accent, ["get", "scenarioAffected"], palette.highlight, palette.surface],
        },
      });
      map.addLayer({
        id: ANNOTATION_LABEL_LAYER,
        type: "symbol",
        source: ANNOTATION_SOURCE_ID,
        filter: ["all", ["!", ["has", "point_count"]], ["!=", ["get", "label"], ""]],
        layout: {
          "text-field": ["get", "label"],
          "text-size": 10,
          "text-font": ["Noto Sans Bold"],
          "text-allow-overlap": true,
          "text-ignore-placement": true,
        },
        paint: { "text-color": palette.surface },
      });

      map.on("click", CLUSTER_LAYER, (event: MapLayerMouseEvent) => {
        const clusterFeatures = map.queryRenderedFeatures(event.point, {
          layers: [CLUSTER_LAYER],
        });
        const clusterId = clusterFeatures[0]?.properties?.cluster_id;
        const source = map.getSource(SOURCE_ID) as GeoJSONSource;

        if (clusterId == null) return;

        source
          .getClusterExpansionZoom(clusterId)
          .then((targetZoom: number) => {
            const geometry = clusterFeatures[0].geometry;
            if (geometry.type !== "Point") return;

            map[prefersReducedMotion ? "jumpTo" : "easeTo"]({
              center: geometry.coordinates as [number, number],
              zoom: targetZoom,
            });
          });
      });

      map.on("click", POINT_LAYER, (event: MapLayerMouseEvent) => {
        const feature = event.features?.[0];
        if (!feature || feature.geometry.type !== "Point") return;

        const props = feature.properties as {
          id: string;
          title: string;
          categoryLabel: string;
          price: number;
          isSynthetic: boolean;
        };

        onSelectFeatureRef.current?.(props.id);

        popupRef.current?.remove();
        const coordinates = feature.geometry.coordinates.slice() as [
          number,
          number,
        ];

        popupRef.current = new Popup({ closeButton: true, offset: 12 })
          .setLngLat(coordinates)
          .setHTML(
            `<div style="font-family:inherit;min-width:160px;color:${palette.ink};">
              <p style="margin:0 0 2px;font-size:12px;color:${palette.inkSubtle};">${props.categoryLabel}</p>
              <p style="margin:0 0 4px;font-weight:600;font-size:13px;">${props.title}</p>
              <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
                <span style="font-size:12px;color:${palette.inkMuted};">${props.isSynthetic ? "LocaLens demo" : "Open data"}</span>
                <span style="font-weight:600;font-size:13px;">${props.price ? `₹${props.price}` : "Free"}</span>
              </div>
              <a href="/discover/${props.id}" style="display:block;margin-top:8px;font-size:12px;font-weight:600;color:${palette.accent};">View experience →</a>
            </div>`,
          )
          .addTo(map);
      });

      map.on("click", ANNOTATION_CLUSTER_LAYER, (event: MapLayerMouseEvent) => {
        const clusterFeatures = map.queryRenderedFeatures(event.point, {
          layers: [ANNOTATION_CLUSTER_LAYER],
        });
        const clusterId = clusterFeatures[0]?.properties?.cluster_id;
        const source = map.getSource(ANNOTATION_SOURCE_ID) as GeoJSONSource;
        if (clusterId == null) return;

        source.getClusterExpansionZoom(clusterId).then((targetZoom: number) => {
          const geometry = clusterFeatures[0]?.geometry;
          if (!geometry || geometry.type !== "Point") return;
          map[prefersReducedMotion ? "jumpTo" : "easeTo"]({
            center: geometry.coordinates as [number, number],
            zoom: targetZoom,
          });
        });
      });

      map.on("click", ANNOTATION_POINT_LAYER, (event: MapLayerMouseEvent) => {
        const feature = event.features?.[0];
        if (!feature || feature.geometry.type !== "Point") return;
        const props = feature.properties as {
          id: string;
          label: string;
          title: string;
          description: string;
          kind?: string;
          signalCount?: number;
          confidence?: number;
          confidenceLabel?: string;
          trend?: string;
          severity?: string;
        };
        if (!props.id) return;

        onSelectAnnotationRef.current?.(props.id);
        popupRef.current?.remove();
        const [lng, lat] = feature.geometry.coordinates;
        popupRef.current = new Popup({ closeButton: true, offset: 12 })
          .setLngLat([lng, lat])
          .setHTML(
            `<div style="font-family:inherit;min-width:160px;color:${palette.ink};">
              ${props.kind === "social" ? `<p style="margin:0 0 2px;font-size:11px;font-weight:600;color:${palette.highlight};">Public social signal · area-level</p>` : ""}
              ${props.label ? `<p style="margin:0 0 2px;font-size:12px;color:${palette.inkSubtle};">${escapeHtml(props.label)}</p>` : ""}
              <p style="margin:0 0 4px;font-weight:600;font-size:13px;">${escapeHtml(props.title)}</p>
              ${props.description ? `<p style="margin:0;font-size:12px;color:${palette.inkMuted};">${escapeHtml(props.description)}</p>` : ""}
              ${props.kind === "social" ? `<p style="margin:5px 0 0;font-size:11px;color:${palette.inkMuted};">${escapeHtml(props.severity ?? "unknown")} severity · ${escapeHtml(props.confidenceLabel ?? "low")} heuristic confidence</p>` : ""}
            </div>`,
          )
          .addTo(map);
      });

      map.on(
        "mouseenter",
        POINT_LAYER,
        () => (map.getCanvas().style.cursor = "pointer"),
      );
      map.on("mouseleave", POINT_LAYER, () => (map.getCanvas().style.cursor = ""));
      map.on(
        "mouseenter",
        CLUSTER_LAYER,
        () => (map.getCanvas().style.cursor = "pointer"),
      );
      map.on("mouseleave", CLUSTER_LAYER, () => (map.getCanvas().style.cursor = ""));
      map.on("mouseenter", ANNOTATION_POINT_LAYER, () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", ANNOTATION_POINT_LAYER, () => (map.getCanvas().style.cursor = ""));
      map.on("mouseenter", ANNOTATION_CLUSTER_LAYER, () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", ANNOTATION_CLUSTER_LAYER, () => (map.getCanvas().style.cursor = ""));

      setLoaded(true);
    });

    if (onSearchThisArea) {
      map.on("dragend", () => setShowSearchArea(true));
      map.on("zoomend", () => setShowSearchArea(true));
    }

    return () => {
      popupRef.current?.remove();
      map.remove();
      mapRef.current = null;
    };

    // Initialize once; update map data through the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the experience source in sync with fresh results.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;

    const source = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
    source?.setData(features);
  }, [features, loaded]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    const source = map.getSource(ANNOTATION_SOURCE_ID) as GeoJSONSource | undefined;
    source?.setData(annotations);
  }, [annotations, loaded]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;

    const source = map.getSource(ORIGIN_SOURCE_ID) as GeoJSONSource | undefined;
    if (!source) return;

    source.setData(
      origin
        ? {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                geometry: {
                  type: "Point",
                  coordinates: [origin.lng, origin.lat],
                },
                properties: {},
              },
            ],
          }
        : EMPTY_COLLECTION,
    );
  }, [origin, loaded]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;

    const source = map.getSource(ROUTE_SOURCE_ID) as GeoJSONSource | undefined;
    if (!source) return;

    const geometries = [...(routeGeometry ? [routeGeometry] : []), ...routeGeometries];
    source.setData({
      type: "FeatureCollection",
      features: geometries.map((geometry) => ({
        type: "Feature",
        geometry,
        properties: {},
      })),
    });
  }, [routeGeometry, routeGeometries, loaded]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    const source = map.getSource(ROUTE_ALTERNATIVE_SOURCE_ID) as GeoJSONSource | undefined;
    source?.setData({
      type: "FeatureCollection",
      features: routeAlternativeGeometries.map((geometry) => ({
        type: "Feature",
        geometry,
        properties: {},
      })),
    });
  }, [routeAlternativeGeometries, loaded]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded || !center) return;

    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    map[prefersReducedMotion ? "jumpTo" : "easeTo"]({
      center: [center.lng, center.lat],
      zoom,
    });

    // Only re-center when the caller explicitly changes center/zoom.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center?.lat, center?.lng, loaded]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded || !fitBounds || fitBoundsRequestId === 0) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    map.fitBounds(fitBounds, {
      padding: { top: 64, right: 56, bottom: 64, left: 56 },
      maxZoom: 14,
      duration: reducedMotion ? 0 : 450,
    });
  }, [fitBounds, fitBoundsRequestId, loaded]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded || !focusCoordinate || focusRequestId === 0) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    map[reducedMotion ? "jumpTo" : "easeTo"]({
      center: [focusCoordinate.lng, focusCoordinate.lat],
      zoom: 14,
      duration: reducedMotion ? 0 : 450,
    });
  }, [focusCoordinate, focusRequestId, loaded]);

  function handleSearchThisArea() {
    const map = mapRef.current;
    if (!map || !onSearchThisArea) return;

    const bounds = map.getBounds();
    onSearchThisArea({
      minLat: bounds.getSouth(),
      maxLat: bounds.getNorth(),
      minLng: bounds.getWest(),
      maxLng: bounds.getEast(),
    });
    setShowSearchArea(false);
  }

  if (mapError) {
    return (
      <div
        role="status"
        className={cn(
          "flex min-h-64 w-full flex-col items-center justify-center gap-2 rounded-2xl border border-line bg-pastel-sky/25 px-4 text-sm text-ink-muted",
          className,
        )}
      >
        <p>Map temporarily unavailable.</p>
        <p className="text-xs text-ink-subtle">
          The experience list below still works.
        </p>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "relative min-h-64 w-full overflow-hidden rounded-2xl border border-line bg-surface-raised shadow-soft",
        className,
      )}
    >
      <div ref={containerRef} role="img" aria-label={label} className="h-full w-full" />

      {showSearchArea ? (
        <div className="absolute left-1/2 top-3 -translate-x-1/2">
          <button
            type="button"
            onClick={handleSearchThisArea}
            className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-raised px-4 py-2 text-xs font-semibold text-ink shadow-soft transition-colors hover:bg-pastel-lemon"
          >
            <RefreshCw className="size-3.5" aria-hidden="true" />
            Search this area
          </button>
        </div>
      ) : null}
    </div>
  );
}
