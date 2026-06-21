"use strict";

// ---- Curated cities: drop a new file in data/curated/ and add it here ----
const CURATED_CITIES = ["birmingham"];

// ---- Config ----
const MAX_RADIUS_M = 2000;   // widest "Within" option — fetched once, then filtered locally

// ---- State ----
let userPos = null;          // { lat, lng }
let allParks = [];           // everything fetched within MAX_RADIUS_M (the cache)
let carParks = [];           // subset within the current radius (what we display)
let curatedCity = null;      // curated city data for the user's location, if any
let parksLoaded = false;     // true once the one-time fetch completes
let sortMode = "nearest";    // "nearest" | "cheapest"
let currentRadiusM = 1000;   // search distance in metres (the "Within" control)
let map, userMarker;
let parkLayer;

const els = {
  status: document.getElementById("status"),
  list: document.getElementById("list"),
  sortNearest: document.getElementById("sort-nearest"),
  sortCheapest: document.getElementById("sort-cheapest"),
  radiusBtns: document.querySelectorAll(".radius-btn"),
};

// ---- Helpers ----
function setStatus(msg, isError = false) {
  els.status.textContent = msg;
  els.status.classList.toggle("error", isError);
}

// Haversine distance in metres
function distanceMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function formatDistance(m) {
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

function inBounds(pos, b) {
  return (
    pos.lat >= b.minLat && pos.lat <= b.maxLat &&
    pos.lng >= b.minLng && pos.lng <= b.maxLng
  );
}

// ---- Map ----
function initMap(center) {
  map = L.map("map", { zoomControl: true }).setView([center.lat, center.lng], 14);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);
  parkLayer = L.layerGroup().addTo(map);
  const youIcon = L.divIcon({ className: "", html: '<div class="you-marker"></div>', iconSize: [18, 18] });
  userMarker = L.marker([center.lat, center.lng], { icon: youIcon, title: "You are here" }).addTo(map);
}

function refreshMapMarkers(parks) {
  if (!parkLayer) return;
  parkLayer.clearLayers();
  parks.forEach((p) => {
    const marker = L.marker([p.lat, p.lng]);
    const price = p.tariffText || (p.fee === "no" ? "Free" : "Price not listed");
    marker.bindPopup(
      `<strong>${p.name}</strong><br>${formatDistance(p.distance)} away<br>${price}` +
      (p.verified ? "<br>✓ Verified prices" : "")
    );
    parkLayer.addLayer(marker);
  });
}

// ---- Data sources ----

// Global car-park locations from OpenStreetMap Overpass API
async function fetchOsmCarParks(pos, radiusM = 2000) {
  const query = `
    [out:json][timeout:25];
    (
      node["amenity"="parking"](around:${radiusM},${pos.lat},${pos.lng});
      way["amenity"="parking"](around:${radiusM},${pos.lat},${pos.lng});
    );
    out center tags;`;
  const res = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    body: "data=" + encodeURIComponent(query),
  });
  if (!res.ok) throw new Error("Overpass request failed: " + res.status);
  const data = await res.json();

  return (data.elements || [])
    .map((el) => {
      const lat = el.lat ?? el.center?.lat;
      const lng = el.lon ?? el.center?.lon;
      if (lat == null || lng == null) return null;
      const t = el.tags || {};
      // Skip private/customer-only lots where possible
      if (t.access === "private" || t.access === "no") return null;
      return {
        id: `osm-${el.type}-${el.id}`,
        name: t.name || (t.operator ? `${t.operator} parking` : "Car park"),
        lat, lng,
        fee: t.fee,                       // "yes" | "no" | undefined
        tariffText: t.charge || null,     // OSM rarely has this
        pricePerHour: null,
        verified: false,
      };
    })
    .filter(Boolean);
}

// Curated accurate prices for known cities
async function loadCuratedForPos(pos) {
  for (const city of CURATED_CITIES) {
    try {
      const res = await fetch(`data/curated/${city}.json`, { cache: "no-cache" });
      if (!res.ok) continue;
      const cityData = await res.json();
      if (cityData.bounds && inBounds(pos, cityData.bounds)) {
        return cityData;
      }
    } catch (e) {
      console.warn("Could not load curated city", city, e);
    }
  }
  return null;
}

// Merge curated parks onto the OSM list (curated entries win / get added)
function mergeCurated(osmParks, cityData) {
  if (!cityData) return osmParks;
  const merged = osmParks.slice();
  cityData.carParks.forEach((c) => {
    // Try to match an existing OSM park within ~80m to enrich it
    let matched = null;
    for (const p of merged) {
      if (distanceMeters({ lat: c.lat, lng: c.lng }, { lat: p.lat, lng: p.lng }) < 80) {
        matched = p;
        break;
      }
    }
    const enriched = {
      id: c.id,
      name: c.name,
      lat: c.lat,
      lng: c.lng,
      tariffText: c.tariffText,
      pricePerHour: c.pricePerHour ?? null,
      dayRate: c.dayRate ?? null,
      fee: "yes",
      verified: true,
      lastChecked: cityData.lastChecked,
    };
    if (matched) Object.assign(matched, enriched);
    else merged.push(enriched);
  });
  return merged;
}

// ---- Sorting & rendering ----
function byDistance(a, b) { return a.distance - b.distance; }

function byCheapest(a, b) {
  const pa = a.pricePerHour;
  const pb = b.pricePerHour;
  if (pa == null && pb == null) return a.distance - b.distance;
  if (pa == null) return 1;   // unknown price sorts last
  if (pb == null) return -1;
  return pa - pb || a.distance - b.distance;
}

// All car parks within the chosen distance, ordered by the chosen sort mode.
function visibleParks() {
  return carParks.slice().sort(sortMode === "cheapest" ? byCheapest : byDistance);
}

function radiusLabel() {
  return `${currentRadiusM / 1000} km`;
}

function navUrl(p) {
  const origin = userPos ? `${userPos.lat},${userPos.lng}` : "";
  return `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${p.lat},${p.lng}&travelmode=driving`;
}

function priceHtml(p) {
  if (p.pricePerHour != null && p.tariffText) return `<span class="price">${p.tariffText}</span>`;
  if (p.tariffText) return `<span class="price">${p.tariffText}</span>`;
  if (p.fee === "no") return `<span class="price">Free</span>`;
  return `<span class="price unknown">Price not listed</span>`;
}

function render() {
  const parks = visibleParks();
  refreshMapMarkers(parks);
  els.list.innerHTML = "";

  if (parks.length === 0) {
    els.list.innerHTML =
      `<div class="empty">No car parks found within ${radiusLabel()}.<br>Try a wider distance above.</div>`;
    return;
  }

  const frag = document.createDocumentFragment();
  parks.forEach((p) => {
    const li = document.createElement("li");
    li.className = "card";
    li.innerHTML = `
      <div class="card-main">
        <p class="card-name">${p.name}</p>
        <div class="card-meta">
          <span class="dist">${formatDistance(p.distance)}</span>
          ${priceHtml(p)}
          ${p.verified ? '<span class="badge">✓ Verified</span>' : ""}
          ${p.spacesFree != null ? `<span class="spaces">${p.spacesFree} free</span>` : ""}
        </div>
      </div>
      <a class="nav-btn" href="${navUrl(p)}" target="_blank" rel="noopener">Navigate</a>`;
    frag.appendChild(li);
  });
  els.list.appendChild(frag);
}

// ---- Live availability (best-effort; may be blocked by CORS) ----
async function tryLiveAvailability() {
  // Placeholder for curated-city live feeds. Wrapped so any failure is silent.
  try {
    // Birmingham/other feeds would be fetched here and merged by id.
    // Left as a graceful no-op: cards stay complete without it.
  } catch (e) {
    console.info("Live availability unavailable, continuing without it.");
  }
}

// ---- Boot ----
async function start(pos) {
  userPos = pos;
  initMap(pos);
  await fetchAllParks();
  applyRadius();
}

// One-time fetch at the widest distance. Everything closer is just a
// local filter of this result, so changing the distance is instant.
async function fetchAllParks() {
  setStatus("Finding car parks near you…");

  let osm = [];
  try {
    osm = await fetchOsmCarParks(userPos, MAX_RADIUS_M);
  } catch (e) {
    console.warn(e);
    setStatus("Couldn't load nearby parking right now. Showing verified prices if available.", true);
  }

  curatedCity = await loadCuratedForPos(userPos);
  allParks = mergeCurated(osm, curatedCity);
  allParks.forEach((p) => (p.distance = distanceMeters(userPos, p)));
  allParks = allParks.filter((p) => p.distance <= MAX_RADIUS_M);

  await tryLiveAvailability();
  parksLoaded = true;
}

// Filter the cached parks to the chosen distance and render. No network.
function applyRadius() {
  carParks = allParks.filter((p) => p.distance <= currentRadiusM);

  if (carParks.length > 0) {
    const verifiedNote = curatedCity ? ` · verified prices for ${curatedCity.city}` : "";
    const plural = carParks.length === 1 ? "car park" : "car parks";
    setStatus(`${carParks.length} ${plural} within ${radiusLabel()}${verifiedNote}`);
  } else {
    setStatus(`No car parks found within ${radiusLabel()}. Try a wider distance.`, true);
  }
  render();
}

function geoError(err) {
  console.warn(err);
  setStatus("Location unavailable. Showing Birmingham city centre as an example.", true);
  // Fallback so the app is still useful/demoable without location permission.
  start({ lat: 52.4779, lng: -1.8995 });
}

function initLocation() {
  if (!("geolocation" in navigator)) {
    geoError(new Error("no geolocation"));
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (p) => start({ lat: p.coords.latitude, lng: p.coords.longitude }),
    geoError,
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
  );
}

// Sort toggle wiring
els.sortNearest.addEventListener("click", () => {
  sortMode = "nearest";
  els.sortNearest.classList.add("active");
  els.sortNearest.setAttribute("aria-pressed", "true");
  els.sortCheapest.classList.remove("active");
  els.sortCheapest.setAttribute("aria-pressed", "false");
  render();
});
els.sortCheapest.addEventListener("click", () => {
  sortMode = "cheapest";
  els.sortCheapest.classList.add("active");
  els.sortCheapest.setAttribute("aria-pressed", "true");
  els.sortNearest.classList.remove("active");
  els.sortNearest.setAttribute("aria-pressed", "false");
  render();
});

// Distance (radius) toggle — re-fetches car parks for the new distance
els.radiusBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    currentRadiusM = Number(btn.dataset.m);
    els.radiusBtns.forEach((b) => {
      const active = b === btn;
      b.classList.toggle("active", active);
      b.setAttribute("aria-pressed", active ? "true" : "false");
    });
    if (parksLoaded) applyRadius(); // instant local filter, no network call
  });
});

// Service worker (auto-updating, network-first)
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").then((reg) => {
      reg.addEventListener("updatefound", () => {
        const sw = reg.installing;
        sw && sw.addEventListener("statechange", () => {
          if (sw.state === "installed" && navigator.serviceWorker.controller) {
            window.location.reload(); // auto-pick up new version
          }
        });
      });
    }).catch((e) => console.info("SW registration skipped", e));
  });
}

initLocation();
