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
  if (typeof window === "undefined") {
    return Promise.resolve();
  }
  if (window.google?.maps) {
    return Promise.resolve();
  }
  if (scriptPromise) {
    return scriptPromise;
  }

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

export function RouteMap({ origin, destination, hazards, className, indoorNote }: RouteMapProps) {
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? "";
  const mapRef = useRef<HTMLDivElement | null>(null);
  const markersRef = useRef<any[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    let currentMap: any = null;

    async function renderRoute() {
      if (!mapRef.current || !origin || !destination) {
        return;
      }
      if (!apiKey) {
        if (mounted) {
          setError("NEXT_PUBLIC_GOOGLE_MAPS_API_KEY is not configured.");
        }
        return;
      }

      try {
        await loadGoogleMaps(apiKey);
        if (!mounted || !mapRef.current || !window.google?.maps) {
          return;
        }

        const googleMaps = window.google.maps;
        const map = new googleMaps.Map(mapRef.current, {
          center: destination,
          zoom: 16,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
        });
        const directionsService = new googleMaps.DirectionsService();
        const directionsRenderer = new googleMaps.DirectionsRenderer({
          map,
          suppressMarkers: false,
          polylineOptions: {
            strokeColor: "#0c72d8",
            strokeWeight: 6,
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
              if (mounted) {
                setError(null);
              }
            } else if (mounted) {
              setError(`Route unavailable (${status}).`);
            }
          }
        );

        currentMap = map;
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err.message : "Failed to render map.");
        }
      }
    }

    renderRoute().then(() => {
      if (!currentMap || !window.google?.maps || !mounted) return;
      
      // Clear old markers
      markersRef.current.forEach(m => m.setMap(null));
      markersRef.current = [];

      // Add hazards
      if (hazards && hazards.length > 0) {
        hazards.forEach(hazard => {
          try {
            const color = hazard.type === 'fire' ? '#FF0000' : '#0000FF';
            const circle = new window.google.maps.Circle({
              strokeColor: color,
              strokeOpacity: 0.8,
              strokeWeight: 2,
              fillColor: color,
              fillOpacity: 0.35,
              map: currentMap,
              center: hazard.location,
              radius: 25 // 25 meters hazard radius
            });
            markersRef.current.push(circle);
          } catch (err) {
            console.error("Failed to render hazard circle for", hazard.id, err);
          }
        });
      }
    }).catch(err => {
      console.error("Failed to render route and map", err);
    });

    return () => {
      mounted = false;
      markersRef.current.forEach(m => m.setMap(null));
      markersRef.current = [];
    };
  }, [apiKey, origin, destination, hazards]);

  return (
    <section className={className}>
      <div className="route-map" ref={mapRef} />
      {indoorNote ? <p className="route-note">Indoor routing note: {indoorNote}</p> : null}
      {error ? <p className="error inline">{error}</p> : null}
    </section>
  );
}