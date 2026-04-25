"use client";

import { useEffect, useRef, useState } from "react";

type Coordinates = {
  lat: number;
  lng: number;
};

type HazardPin = {
  id: string;
  type: string;
  location: Coordinates;
};

type RouteMapProps = {
  origin: Coordinates | null;
  destination: Coordinates | null;
  hazards?: HazardPin[];
  className?: string;
  indoorNote?: string;
};

declare global {
  interface Window {
    google?: any;
  }
}

let scriptPromise: Promise<void> | null = null;

function loadGoogleMaps(apiKey: string): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.google?.maps) return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}`;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Google Maps JavaScript API."));
    document.head.appendChild(script);
  });

  return scriptPromise;
}

function FallbackMap({ origin, destination, indoorNote }: { origin: Coordinates | null; destination: Coordinates | null; indoorNote?: string }) {
  return (
    <div className="fallback-map">
      <div className="map-icon" aria-hidden="true">MAP</div>
      <div className="map-label">Route Map</div>
      {origin && destination && (
        <div className="map-note">
          Route: ({origin.lat.toFixed(4)}, {origin.lng.toFixed(4)}) to ({destination.lat.toFixed(4)}, {destination.lng.toFixed(4)})
        </div>
      )}
      {indoorNote && <div className="map-note">{indoorNote}</div>}
      <div className="map-note" style={{ opacity: 0.6, fontSize: "11px" }}>
        Configure NEXT_PUBLIC_GOOGLE_MAPS_API_KEY for live routing.
      </div>
    </div>
  );
}

export function RouteMap({ origin, destination, hazards, className, indoorNote }: RouteMapProps) {
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? "";
  const mapRef = useRef<HTMLDivElement | null>(null);
  const markersRef = useRef<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [useFallback, setUseFallback] = useState(false);

  useEffect(() => {
    if (!apiKey) {
      setUseFallback(true);
      return;
    }

    (window as any).gm_authFailure = () => {
      setUseFallback(true);
      setError("Google Maps API key is invalid or restricted.");
    };

    let mounted = true;
    let currentMap: any = null;

    async function renderRoute() {
      if (!mapRef.current || !origin || !destination) return;

      try {
        await loadGoogleMaps(apiKey);
        if (!mounted || !mapRef.current || !window.google?.maps) return;

        const googleMaps = window.google.maps;
        const map = new googleMaps.Map(mapRef.current, {
          center: destination,
          zoom: 16,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
          styles: [
            { elementType: "geometry", stylers: [{ color: "#172033" }] },
            { elementType: "labels.text.fill", stylers: [{ color: "#a8b3c7" }] },
            { elementType: "labels.text.stroke", stylers: [{ color: "#101827" }] },
            { featureType: "road", elementType: "geometry", stylers: [{ color: "#273653" }] },
            { featureType: "water", elementType: "geometry", stylers: [{ color: "#0e1626" }] },
          ],
        });
        const directionsService = new googleMaps.DirectionsService();
        const directionsRenderer = new googleMaps.DirectionsRenderer({
          map,
          suppressMarkers: false,
          polylineOptions: {
            strokeColor: "#38bdf8",
            strokeWeight: 5,
            strokeOpacity: 0.9,
          },
        });

        directionsService.route(
          {
            origin,
            destination,
            travelMode: googleMaps.TravelMode.WALKING,
          },
          (result: any, status: string) => {
            if (status === googleMaps.DirectionsStatus.OK && result) {
              directionsRenderer.setDirections(result);
              if (mounted) setError(null);
            } else if (mounted) {
              setError(`Route unavailable (${status}).`);
            }
          }
        );

        currentMap = map;
      } catch (err) {
        if (mounted) {
          setUseFallback(true);
          setError(err instanceof Error ? err.message : "Failed to render map.");
        }
      }
    }

    renderRoute().then(() => {
      if (!currentMap || !window.google?.maps || !mounted) return;
      markersRef.current.forEach((marker) => marker.setMap(null));
      markersRef.current = [];

      (hazards || []).forEach((hazard) => {
        const color = hazard.type === "fire" ? "#ef4444" : "#38bdf8";
        const circle = new window.google.maps.Circle({
          strokeColor: color,
          strokeOpacity: 0.9,
          strokeWeight: 2,
          fillColor: color,
          fillOpacity: 0.24,
          map: currentMap,
          center: hazard.location,
          radius: 25,
        });
        markersRef.current.push(circle);
      });
    }).catch((err) => {
      console.error("Failed to render route and map", err);
    });

    return () => {
      mounted = false;
      markersRef.current.forEach((marker) => marker.setMap(null));
      markersRef.current = [];
    };
  }, [apiKey, origin, destination, hazards]);

  if (useFallback) {
    return (
      <section className={className}>
        <FallbackMap origin={origin} destination={destination} indoorNote={indoorNote} />
        {error ? <p className="error inline">{error}</p> : null}
      </section>
    );
  }

  return (
    <section className={className}>
      <div className="route-map" ref={mapRef} />
      {indoorNote ? <p className="route-note">Indoor routing note: {indoorNote}</p> : null}
      {error ? <p className="error inline">{error}</p> : null}
    </section>
  );
}
