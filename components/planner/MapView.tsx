"use client";
import { useEffect } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { MapContainer, Marker, Polyline, TileLayer, Tooltip, useMap } from "react-leaflet";
import type { Itinerary } from "@/lib/types";
import { stopColor } from "@/lib/colors";

const icon = (n: number, active: boolean) => {
  const size = active ? 38 : 30;
  const color = stopColor(n - 1);
  return L.divIcon({
    className: "",
    html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};color:#fff;font:700 ${active ? 15 : 13}px system-ui;display:flex;align-items:center;justify-content:center;border:3px solid #fff;box-shadow:0 0 0 ${active ? 3 : 0}px ${color}99,0 2px 8px rgba(0,0,0,.4)">${n}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
};

const startIcon = L.divIcon({
  className: "",
  html: `<div style="padding:3px 8px;border-radius:999px;background:#0f172a;color:#fff;font:600 11px system-ui;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.35);white-space:nowrap">Start</div>`,
  iconSize: [48, 22],
  iconAnchor: [58, 11], // label sits to the left of the point so it never covers a stop marker
});

function Fit({ it, selected }: { it: Itinerary; selected: number | null }) {
  const map = useMap();
  useEffect(() => {
    if (selected !== null && it.stops[selected]) {
      map.flyTo([it.stops[selected].lat, it.stops[selected].lon], Math.max(map.getZoom(), 15), { duration: 0.6 });
    } else if (it.stops.length) {
      map.fitBounds(L.latLngBounds([...(it.start ? [[it.start.lat, it.start.lon] as [number, number]] : []), ...it.stops.map((s) => [s.lat, s.lon] as [number, number])]), { padding: [40, 40], maxZoom: 15 });
    }
  }, [it, selected, map]);
  return null;
}

export default function MapView({ it, selected, onSelect }: { it: Itinerary; selected: number | null; onSelect: (i: number) => void }) {
  const pts = [...(it.start ? [[it.start.lat, it.start.lon] as [number, number]] : []), ...it.stops.map((s) => [s.lat, s.lon] as [number, number])];
  return (
    <MapContainer center={[it.center.lat, it.center.lon]} zoom={13} scrollWheelZoom={false} className="h-72 w-full rounded-xl sm:h-80" style={{ zIndex: 0 }}>
      <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
      <Polyline positions={pts} pathOptions={{ color: "#4f46e5", weight: 3, dashArray: "6 6" }} />
      {it.start && (
        <Marker position={[it.start.lat, it.start.lon]} icon={startIcon} zIndexOffset={-500}>
          <Tooltip direction="top" offset={[0, -10]}>Start: {it.start.name}</Tooltip>
        </Marker>
      )}
      {it.stops.map((s, i) => (
        <Marker key={s.placeId + i + (selected === i ? "-sel" : "")} position={[s.lat, s.lon]} icon={icon(i + 1, selected === i)} zIndexOffset={selected === i ? 1000 : 0} eventHandlers={{ click: () => onSelect(i) }}>
          <Tooltip direction="top" offset={[0, -14]}>{s.name}</Tooltip>
        </Marker>
      ))}
      <Fit it={it} selected={selected} />
    </MapContainer>
  );
}
