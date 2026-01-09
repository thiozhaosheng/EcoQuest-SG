// =====================
// CONFIG
// =====================
const API_BASE = "https://ecoquest-backend-uai1.onrender.com";

const SUPABASE_URL = "https://lhrcfsdazjumpgytriec.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_Ub6kpTp9iwwAgxBl3Q5efQ_fuaVqMry";

const supabaseClient = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storage: window.localStorage,
    },
  }
);

// Cross-tab sync (fixes “works only in incognito” + lock weirdness with magic link tabs)
const AUTH_CHANNEL = new BroadcastChannel("ecoquest-auth");

// =====================
// HELPERS
// =====================
function esc(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setStatus(msg) {
  const statusText = document.getElementById("statusText");
  if (statusText) statusText.textContent = msg || "";
}

function setRewardsStatus(msg) {
  const el = document.getElementById("rewardsStatusText");
  if (!el) return;
  const m = String(msg || "").trim();
  el.textContent = m || "";
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

async function safeReadBody(res) {
  const text = await res.text().catch(() => "");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
}

function formatDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

async function copyTextToClipboard(text) {
  const value = String(text || "");
  if (!value) return false;

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch (_) {}
  }

  try {
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    ta.style.top = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch (_) {
    return false;
  }
}

function clamp2Style() {
  return "display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden;-webkit-line-clamp:2;";
}
function clamp1Style() {
  return "display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden;-webkit-line-clamp:1;";
}

// =====================
// STATE
// =====================
let userLocation = null;
let pendingCheckinPlaceId = null;
let pendingRedeemRewardId = null;

// =====================
// AUTH (MAGIC LINK)
// =====================
async function handleMagicLinkRedirect() {
  try {
    const url = new URL(window.location.href);
    const code = url.searchParams.get("code");
    if (!code) return;

    setStatus("Finishing sign in...");

    const { data, error } = await supabaseClient.auth.exchangeCodeForSession(
      code
    );
    if (error) throw error;

    // remove code from URL
    url.searchParams.delete("code");
    window.history.replaceState({}, document.title, url.toString());

    // IMPORTANT: sync other tabs (prevents lock-timeout weirdness)
    AUTH_CHANNEL.postMessage({
      type: "SIGNED_IN",
      at: Date.now(),
      user: data?.session?.user?.id || null,
    });

    setStatus("Signed in.");
  } catch (err) {
    console.error("Magic link redirect error:", err);
    setStatus(`Sign in failed: ${err?.message || "Unknown error"}`);
  }
}

// =====================
// LOCATION
// =====================
function requestUserLocation(force = false) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      setStatus("Geolocation not supported in this browser.");
      resolve(false);
      return;
    }

    setStatus("Requesting your location...");

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        userLocation = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
        };

        const acc = Math.round(pos.coords.accuracy || 0);
        setStatus(`Location enabled (accuracy ~${acc}m). You can check in.`);
        resolve(true);
      },
      (err) => {
        console.warn("Geolocation error:", err);
        if (force) {
          setStatus(
            "Location is required to check in. Please allow location access in your browser."
          );
        } else {
          setStatus("Location not enabled yet.");
        }
        resolve(false);
      },
      { enableHighAccuracy: true, timeout: 30000, maximumAge: 600000 }
    );
  });
}

// =====================
// API HELPERS
// =====================
async function apiGet(path, token = null) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetchWithTimeout(`${API_BASE}${path}`, { headers }, 12000);
  const data = await safeReadBody(res);

  if (!res.ok) {
    const msg =
      data?.error ||
      data?.message ||
      data?._raw ||
      `GET ${path} failed (${res.status})`;
    throw new Error(msg);
  }
  return data;
}

async function apiPost(path, body, token = null) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetchWithTimeout(
    `${API_BASE}${path}`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
    12000
  );

  const data = await safeReadBody(res);

  if (!res.ok) {
    const msg =
      data?.error ||
      data?.message ||
      data?._raw ||
      `POST ${path} failed (${res.status})`;
    throw new Error(msg);
  }
  return data;
}

// =====================
// AUTH HELPERS
// =====================
async function getAccessToken() {
  const { data } = await supabaseClient.auth.getSession();
  return data?.session?.access_token || null;
}

async function updateAuthButton() {
  const authBtn = document.getElementById("authBtn");
  if (!authBtn) return;

  const token = await getAccessToken();
  authBtn.textContent = token ? "Sign out" : "Sign in";
}

function openAuthModal(message) {
  const authModal = document.getElementById("authModal");
  const authMsg = document.getElementById("authMsg");
  const authEmail = document.getElementById("authEmail");

  if (!authModal || !authMsg || !authEmail) {
    console.error("Auth modal elements missing in HTML.");
    return;
  }

  authMsg.textContent = message || "";
  authModal.classList.remove("hidden");
  authModal.classList.add("flex");
  authEmail.focus();
}

function closeModal() {
  const authModal = document.getElementById("authModal");
  if (!authModal) return;
  authModal.classList.add("hidden");
  authModal.classList.remove("flex");
}

async function resetToGuestState(message = "Signed out.") {
  pendingCheckinPlaceId = null;
  pendingRedeemRewardId = null;
  userLocation = null;

  closeModal();
  closeRedeemModal();
  closePlaceModal();
  renderLoggedOutProfile();

  const authBtn = document.getElementById("authBtn");
  if (authBtn) authBtn.textContent = "Sign in";

  try {
    await Promise.all([loadPlaces(), loadLeaderboard(), loadRewards()]);
  } catch (_) {}

  setStatus(message);
}

// =====================
// REWARDS MODAL
// =====================
function openRedeemModal({ title, code, costPoints, remainingPoints }) {
  const modal = document.getElementById("redeemModal");
  const nameEl = document.getElementById("redeemRewardName");
  const codeEl = document.getElementById("redeemVoucherCode");
  const metaEl = document.getElementById("redeemMeta");
  const copyBtn = document.getElementById("copyVoucherBtn");

  if (!modal) return;

  if (nameEl) nameEl.textContent = title || "Reward redeemed";
  if (codeEl) codeEl.textContent = code || "";

  if (metaEl) {
    const bits = [];
    if (Number.isFinite(costPoints)) bits.push(`Spent ${costPoints} pts`);
    if (Number.isFinite(remainingPoints))
      bits.push(`Remaining ${remainingPoints} pts`);
    metaEl.textContent = bits.join(" • ");
  }

  if (copyBtn) copyBtn.textContent = "Copy code";

  modal.classList.remove("hidden");
  modal.classList.add("flex");
}

function closeRedeemModal() {
  const modal = document.getElementById("redeemModal");
  if (!modal) return;
  modal.classList.add("hidden");
  modal.classList.remove("flex");
}

// =====================
// PLACE DETAILS MODAL
// =====================
function openPlaceModal(place) {
  const modal = document.getElementById("placeModal");
  if (!modal) {
    alert(
      `${place?.name || "Place"}\n${place?.category || ""} • ${
        place?.area || ""
      }\n+${Number(place?.points || 0)} pts\n\n${place?.description || ""}`
    );
    return;
  }

  const titleEl = document.getElementById("placeModalTitle");
  const subEl = document.getElementById("placeModalSub");
  const ptsEl = document.getElementById("placeModalPoints");
  const descEl = document.getElementById("placeModalDesc");
  const coordsEl = document.getElementById("placeModalCoords");
  const mapsLink = document.getElementById("placeModalMapsLink");
  const checkinBtn = document.getElementById("placeModalCheckinBtn");

  const name = place?.name || "Place";
  const category = place?.category || "";
  const area = place?.area || "";
  const points = Number(place?.points || 0);
  const desc = place?.description || "";
  const lat = place?.lat;
  const lng = place?.lng;

  if (titleEl) titleEl.textContent = name;
  if (subEl) subEl.textContent = [category, area].filter(Boolean).join(" • ");
  if (ptsEl) ptsEl.textContent = `+${points} pts`;
  if (descEl) descEl.textContent = desc || "—";

  const coordText =
    lat !== undefined && lng !== undefined ? `${lat}, ${lng}` : "—";
  if (coordsEl) coordsEl.textContent = coordText;

  if (mapsLink && lat !== undefined && lng !== undefined) {
    mapsLink.href = `https://www.google.com/maps?q=${encodeURIComponent(
      `${lat},${lng}`
    )}`;
    mapsLink.target = "_blank";
    mapsLink.rel = "noreferrer";
  } else if (mapsLink) {
    mapsLink.href = "#";
  }

  if (checkinBtn) {
    checkinBtn.onclick = async () => {
      closePlaceModal();
      await handleCheckin(place.id);
    };
  }

  modal.classList.remove("hidden");
  modal.classList.add("flex");
}

function closePlaceModal() {
  const modal = document.getElementById("placeModal");
  if (!modal) return;
  modal.classList.add("hidden");
  modal.classList.remove("flex");
}

// =====================
// RENDERERS
// =====================
function placeCard(place) {
  const pts = Number(place.points || 0);

  let badgeClass = "bg-slate-500/15 text-slate-300 border border-slate-400/20";
  if (pts >= 11 && pts < 20) {
    badgeClass =
      "bg-emerald-500/15 text-emerald-200 border border-emerald-400/20";
  } else if (pts >= 20) {
    badgeClass = "bg-yellow-400/20 text-yellow-300 border border-yellow-300/30";
  }

  return `
    <article class="rounded-2xl border border-white/10 bg-white/5 p-4 flex flex-col h-full">
      <div class="flex items-start justify-between gap-3">
        <div>
          <h3 class="font-semibold leading-snug">${esc(place.name)}</h3>
          <p class="mt-1 text-sm text-slate-400">${esc(place.category)} • ${esc(
    place.area
  )}</p>
        </div>
        <span class="shrink-0 rounded-full px-3 py-1 text-xs ${badgeClass}">
          +${pts} pts
        </span>
      </div>

      <p class="mt-3 text-sm text-slate-200/90">${esc(place.description)}</p>

      <div class="mt-auto pt-4 flex gap-2">
        <button
          class="checkinBtn w-full rounded-xl bg-emerald-600 px-4 py-3 text-sm font-medium text-white hover:bg-emerald-700"
          type="button"
          data-id="${esc(place.id)}"
        >
          Check-in
        </button>

        <button
          class="detailsBtn rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm hover:bg-white/10"
          type="button"
          data-place='${esc(JSON.stringify(place))}'
        >
          Details
        </button>
      </div>
    </article>
  `;
}

function renderLoggedOutProfile() {
  const profileStats = document.getElementById("profileStats");
  const badgesWrap = document.getElementById("badgesWrap");
  const progressBox = document.getElementById("progressBox");

  if (profileStats) {
    profileStats.innerHTML = `
      <p class="text-sm text-slate-400">
        You’re browsing as a guest. Sign in to check in and earn points.
      </p>

      <button
        id="profileAuthBtn"
        class="mt-3 w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm hover:bg-white/10"
        type="button"
      >
        Sign in
      </button>
    `;
  }

  if (badgesWrap) {
    badgesWrap.innerHTML = `<span class="text-xs px-3 py-2 rounded-full bg-white/5 border border-white/10">Sign in to unlock</span>`;
  }
  if (progressBox) progressBox.classList.add("hidden");
}

function renderBadges(badges) {
  const badgesWrap = document.getElementById("badgesWrap");
  if (!badgesWrap) return;

  if (!Array.isArray(badges) || badges.length === 0) {
    badgesWrap.innerHTML = `<span class="text-xs px-3 py-2 rounded-full bg-white/5 border border-white/10">None yet</span>`;
    return;
  }

  badgesWrap.innerHTML = badges
    .map(
      (b) =>
        `<span class="text-xs px-3 py-2 rounded-full bg-white/5 border border-white/10">${esc(
          b
        )}</span>`
    )
    .join("");
}

function renderProfile(profile) {
  const profileStats = document.getElementById("profileStats");
  const progressBox = document.getElementById("progressBox");
  const progressBar = document.getElementById("progressBar");
  const progressText = document.getElementById("progressText");

  if (!profileStats) return;

  profileStats.innerHTML = `
    <div class="flex items-center justify-between">
      <span class="text-slate-400">User</span>
      <span class="font-semibold">${esc(profile.username || "player")}</span>
    </div>
    <div class="flex items-center justify-between">
      <span class="text-slate-400">Email</span>
      <span class="text-xs text-slate-200">${esc(profile.email || "")}</span>
    </div>
    <div class="flex items-center justify-between">
      <span class="text-slate-400">Points</span>
      <span class="font-semibold">${Number(profile.points || 0)}</span>
    </div>
    <div class="flex items-center justify-between">
      <span class="text-slate-400">Streak</span>
      <span class="font-semibold">${Number(profile.streak || 0)} day(s)</span>
    </div>
  `;

  renderBadges(profile.badges || []);

  const current = Number(profile.points || 0);
  const TIERS = [
    { at: 50, label: "🌱 Green Starter" },
    { at: 150, label: "🏆 Eco Warrior" },
    { at: 300, label: "👑 Eco Legend" },
  ];

  const nextTier = TIERS.find((t) => current < t.at) || null;

  if (!nextTier) {
    if (progressBox) progressBox.classList.remove("hidden");
    if (progressBar) progressBar.style.width = `100%`;
    if (progressText) progressText.textContent = `Max level 👑`;
    return;
  }

  const prevAt = TIERS.filter((t) => t.at < nextTier.at).slice(-1)[0]?.at || 0;
  const span = nextTier.at - prevAt;
  const into = Math.max(0, current - prevAt);
  const pct = Math.min(100, Math.round((into / span) * 100));

  if (progressBox) progressBox.classList.remove("hidden");
  if (progressBar) progressBar.style.width = `${pct}%`;

  const remaining = Math.max(0, nextTier.at - current);
  if (progressText)
    progressText.textContent = `${remaining} to ${nextTier.label}`;
}

function renderLeaderboard(items) {
  const leaderboardList = document.getElementById("leaderboardList");
  if (!leaderboardList) return;

  if (!Array.isArray(items) || items.length === 0) {
    leaderboardList.innerHTML = `<li class="text-slate-400">No scores yet.</li>`;
    return;
  }

  leaderboardList.innerHTML = items
    .map((row, idx) => {
      const medal =
        idx === 0 ? "🥇" : idx === 1 ? "🥈" : idx === 2 ? "🥉" : "•";
      return `
        <li class="flex items-center justify-between rounded-xl border border-white/10 bg-slate-950/30 px-3 py-2">
          <span class="truncate">${medal} ${esc(row.username)}</span>
          <span class="font-semibold">${Number(row.points || 0)}</span>
        </li>
      `;
    })
    .join("");
}

// =====================
// REWARDS RENDERERS
// =====================
function rewardCard(r) {
  const cost = Number(r.cost_points || 0);
  const name = esc(r.name || "Reward");
  const brand = esc(r.brand || "");
  const img = esc(r.image_url || "");

  return `
    <article class="rounded-2xl border border-white/10 bg-white/5 p-4 flex flex-col h-full relative">
      <span
        class="absolute top-3 right-3 z-10 rounded-full px-3 py-1 text-xs font-semibold
               bg-slate-950/85 text-emerald-200 border border-emerald-300/60
               shadow-lg backdrop-blur"
      >
        ${cost} pts
      </span>

      <div class="rounded-xl overflow-hidden border border-white/10 bg-white/5">
        ${
          img
            ? `<img src="${img}" alt="${name}" class="w-full h-32 object-cover" loading="lazy" />`
            : `<div class="h-32 grid place-items-center text-slate-400 text-sm">No image</div>`
        }
      </div>

      <h3 class="mt-3 font-semibold text-sm leading-snug" style="${clamp2Style()}" title="${name}">
        ${name}
      </h3>

      <p class="mt-1 text-xs text-slate-400" style="${clamp1Style()}" title="${brand}">
        ${brand}
      </p>

      <div class="mt-auto pt-4">
        <button
          class="redeemBtn w-full rounded-xl bg-emerald-600 px-4 py-3 text-sm font-medium text-white hover:bg-emerald-700"
          type="button"
          data-id="${esc(r.id)}"
        >
          Redeem
        </button>
      </div>
    </article>
  `;
}

function comingSoonCard() {
  return `
    <article class="rounded-2xl border border-white/10 bg-white/5 p-4 flex flex-col h-full relative">
      <div class="rounded-xl overflow-hidden border border-white/10 bg-slate-950/30 h-32 grid place-items-center">
        <div class="text-center">
          <div class="text-2xl">✨</div>
          <div class="mt-1 text-sm font-semibold">More coming soon</div>
        </div>
      </div>

      <h3 class="mt-3 font-semibold text-sm leading-snug">More rewards</h3>
      <p class="mt-1 text-xs text-slate-400">Check back later!</p>

      <div class="mt-auto pt-4">
        <button
          class="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-slate-300 cursor-not-allowed opacity-70"
          type="button"
          disabled
        >
          Coming soon
        </button>
      </div>
    </article>
  `;
}

function renderRewards(items) {
  const grid = document.getElementById("rewardsGrid");
  if (!grid) return;

  if (!Array.isArray(items) || items.length === 0) {
    grid.innerHTML = `<div class="text-slate-400 text-sm">No rewards yet.</div>`;
    return;
  }

  let html = items.map(rewardCard).join("");
  if (items.length % 2 === 1) html += comingSoonCard();

  grid.innerHTML = html;
}

// =====================
// LOADERS
// =====================
async function loadPlaces() {
  const placesGrid = document.getElementById("placesGrid");
  const countText = document.getElementById("countText");
  const searchInput = document.getElementById("searchInput");
  const categorySelect = document.getElementById("categorySelect");

  const search = encodeURIComponent(searchInput?.value?.trim() || "");
  const category = encodeURIComponent(categorySelect?.value || "");

  const places = await apiGet(
    `/api/places?search=${search}&category=${category}`
  );

  if (countText) countText.textContent = places.length;
  if (placesGrid) placesGrid.innerHTML = places.map(placeCard).join("");

  document.querySelectorAll(".checkinBtn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const placeId = btn.getAttribute("data-id");
      await handleCheckin(placeId, btn);
    });
  });
}

async function loadLeaderboard() {
  const data = await apiGet("/api/leaderboard");
  renderLeaderboard(data);
}

async function loadProfileIfLoggedIn() {
  const token = await getAccessToken();
  if (!token) {
    renderLoggedOutProfile();
    return null;
  }

  const profile = await apiGet("/api/profile", token);
  renderProfile(profile);
  return profile;
}

async function loadRewards() {
  const grid = document.getElementById("rewardsGrid");
  if (!grid) return;

  try {
    const rewards = await apiGet("/api/rewards");
    renderRewards(rewards);
    setRewardsStatus("");
  } catch (e) {
    console.error(e);
    setRewardsStatus(`${e?.message || "Failed to load rewards"}`);
  }
}

async function loadMyRedemptions() {
  const list = document.getElementById("myRedemptionsList");
  if (!list) return;

  const token = await getAccessToken();
  if (!token) {
    list.innerHTML = `<li class="text-slate-400">Sign in to see your redemptions.</li>`;
    return;
  }

  try {
    const rows = await apiGet("/api/my-redemptions", token);
    if (!Array.isArray(rows) || rows.length === 0) {
      list.innerHTML = `<li class="text-slate-400">No redemptions yet.</li>`;
      return;
    }

    list.innerHTML = rows
      .map((r) => {
        const when = esc(formatDateTime(r.created_at));
        const nm = esc(r.reward?.name || "Reward");
        const br = esc(r.reward?.brand || "");
        const pts = Number(r.points_spent || 0);
        const code = esc(r.voucher_code || "");
        return `
          <li class="rounded-xl border border-white/10 bg-slate-950/30 px-3 py-2">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <div class="font-medium">${nm}</div>
                <div class="text-xs text-slate-400 break-words">
                  ${br} • ${when}
                </div>
              </div>
              <div class="text-right shrink-0">
                <div class="font-semibold">-${pts} pts</div>
                <div class="text-xs text-slate-400">${code}</div>
              </div>
            </div>
          </li>
        `;
      })
      .join("");
  } catch (e) {
    console.error(e);
    list.innerHTML = `<li class="text-slate-400">${esc(
      e?.message || "Failed to load"
    )}</li>`;
  }
}

async function refreshAll() {
  await Promise.all([
    loadPlaces(),
    loadLeaderboard(),
    loadRewards(),
    loadProfileIfLoggedIn(),
    loadMyRedemptions(),
  ]);
  await updateAuthButton();
}

// =====================
// REDEEM FLOW
// =====================
async function handleRedeem(rewardId, buttonEl = null) {
  try {
    const token = await getAccessToken();
    if (!token) {
      pendingRedeemRewardId = rewardId;
      openAuthModal("Please sign in to redeem rewards.");
      return;
    }

    if (buttonEl) buttonEl.disabled = true;

    const out = await apiPost("/api/redeem", { rewardId }, token);

    await Promise.all([loadProfileIfLoggedIn(), loadMyRedemptions()]);

    const voucherCode = out?.voucherCode || "";
    const costPoints = Number(out?.reward?.cost_points || 0);
    const remainingPoints = Number(out?.pointsRemaining);

    openRedeemModal({
      title: out?.reward?.name || "Reward redeemed",
      code: voucherCode,
      costPoints,
      remainingPoints,
    });

    setRewardsStatus("Redeemed.");
    setTimeout(() => setRewardsStatus(""), 1200);
  } catch (e) {
    console.error("redeem failed:", e);
    setRewardsStatus(`${e?.message || "Redeem failed"}`);
  } finally {
    if (buttonEl) buttonEl.disabled = false;
  }
}

// =====================
// CHECK-IN FLOW
// =====================
async function handleCheckin(placeId, buttonEl = null) {
  try {
    const token = await getAccessToken();
    if (!token) {
      pendingCheckinPlaceId = placeId;
      openAuthModal("Please sign in to check in.");
      return;
    }

    if (!userLocation) {
      const ok = await requestUserLocation(true);
      if (!ok) return;
    }

    if (buttonEl) buttonEl.disabled = true;

    setStatus(
      `Checking in... (lat ${userLocation.lat.toFixed(
        6
      )}, lng ${userLocation.lng.toFixed(6)})`
    );

    await apiPost(
      "/api/checkins",
      {
        placeId,
        userLat: userLocation.lat,
        userLng: userLocation.lng,
      },
      token
    );

    await Promise.all([loadLeaderboard(), loadProfileIfLoggedIn()]);
    setStatus("Check-in successful. Points updated.");
  } catch (e) {
    console.error("Check-in failed:", e);
    setStatus(`${e?.message || "Check-in failed"}`);
  } finally {
    if (buttonEl) buttonEl.disabled = false;
  }
}

// =====================
// INIT
// =====================
document.addEventListener("DOMContentLoaded", async () => {
  setStatus("Loading...");

  // 1) Handle magic link redirect FIRST
  await handleMagicLinkRedirect();

  // 2) Cross-tab messages (fixes multi-tab magic link flow)
  AUTH_CHANNEL.onmessage = async (msg) => {
    const data = msg?.data;
    if (!data?.type) return;

    if (data.type === "SIGNED_IN") {
      // Another tab finished signing in -> update UI here
      try {
        await updateAuthButton();
        await loadProfileIfLoggedIn();
        await loadMyRedemptions();
        setStatus("Session synced.");
      } catch (_) {}
      return;
    }

    if (data.type === "SIGNED_OUT") {
      try {
        await resetToGuestState("Signed out.");
        await updateAuthButton();
      } catch (_) {}
    }
  };

  // ---------------------
  // Modal close handlers
  // ---------------------
  const closeAuthModal = document.getElementById("closeAuthModal");
  const authModal = document.getElementById("authModal");
  if (closeAuthModal) closeAuthModal.addEventListener("click", closeModal);
  if (authModal) {
    authModal.addEventListener("click", (e) => {
      if (e.target === authModal) closeModal();
    });
  }

  const closeRedeemBtn = document.getElementById("closeRedeemModal");
  const redeemModal = document.getElementById("redeemModal");
  if (closeRedeemBtn)
    closeRedeemBtn.addEventListener("click", closeRedeemModal);
  if (redeemModal) {
    redeemModal.addEventListener("click", (e) => {
      if (e.target === redeemModal) closeRedeemModal();
    });
  }

  const closePlaceBtn = document.getElementById("closePlaceModal");
  const placeModal = document.getElementById("placeModal");
  if (closePlaceBtn) closePlaceBtn.addEventListener("click", closePlaceModal);
  if (placeModal) {
    placeModal.addEventListener("click", (e) => {
      if (e.target === placeModal) closePlaceModal();
    });
  }

  // ---------------------
  // Global click handlers
  // ---------------------
  document.addEventListener("click", (e) => {
    const btn = e.target?.closest?.(".detailsBtn");
    if (!btn) return;
    e.preventDefault();

    const raw = btn.getAttribute("data-place") || "{}";
    let place = null;
    try {
      place = JSON.parse(raw);
    } catch {
      place = null;
    }
    if (place) openPlaceModal(place);
  });

  document.addEventListener("click", async (e) => {
    const btn =
      e.target?.closest?.("#copyVoucherBtn") ||
      e.target?.closest?.("[data-copy-voucher]");
    if (!btn) return;

    e.preventDefault();

    const codeEl = document.getElementById("redeemVoucherCode");
    const code = codeEl?.textContent?.trim() || "";

    const ok = await copyTextToClipboard(code);
    if (ok) {
      btn.textContent = "Copied!";
      setTimeout(() => (btn.textContent = "Copy code"), 900);
    }
  });

  document.addEventListener("click", (e) => {
    const btn = e.target?.closest?.("#profileAuthBtn");
    if (!btn) return;
    e.preventDefault();
    openAuthModal("Sign in to check in and earn points.");
  });

  document.addEventListener("click", async (e) => {
    const btn = e.target?.closest?.(".redeemBtn");
    if (!btn) return;
    e.preventDefault();
    const rewardId = btn.getAttribute("data-id");
    if (!rewardId) return;
    await handleRedeem(rewardId, btn);
  });

  // ---------------------
  // Header buttons
  // ---------------------
  const authBtn = document.getElementById("authBtn");
  if (authBtn) {
    authBtn.addEventListener("click", async (e) => {
      e.preventDefault();

      const token = await getAccessToken();
      if (!token) {
        openAuthModal("Sign in to check in and earn points.");
        return;
      }

      authBtn.disabled = true;
      setStatus("Signing out...");

      try {
        await supabaseClient.auth.signOut();
      } catch (err) {
        console.warn("Sign out issue (ignored):", err);
      }

      // broadcast to other tabs
      AUTH_CHANNEL.postMessage({ type: "SIGNED_OUT", at: Date.now() });

      await resetToGuestState("Signed out.");
      await updateAuthButton();
      authBtn.disabled = false;
    });
  }

  const sendMagicLinkBtn = document.getElementById("sendMagicLinkBtn");
  if (sendMagicLinkBtn) {
    sendMagicLinkBtn.addEventListener("click", async (e) => {
      e.preventDefault();

      const authEmail = document.getElementById("authEmail");
      const authMsg = document.getElementById("authMsg");

      try {
        const email = authEmail?.value?.trim() || "";
        if (!email) {
          if (authMsg) authMsg.textContent = "Please enter an email.";
          return;
        }

        if (authMsg) authMsg.textContent = "Sending magic link...";
        sendMagicLinkBtn.disabled = true;

        // include marker (optional but helps debug)
        const redirectTo =
          window.location.origin + window.location.pathname + "?from=magic";

        const { error } = await supabaseClient.auth.signInWithOtp({
          email,
          options: { emailRedirectTo: redirectTo },
        });

        if (error) throw error;

        if (authMsg)
          authMsg.textContent =
            "Sent. Check your email and click the link, then return here.";
      } catch (err) {
        if (authMsg)
          authMsg.textContent = `${err?.message || "Failed to send link"}`;
      } finally {
        sendMagicLinkBtn.disabled = false;
      }
    });
  }

  const useLocationBtn = document.getElementById("useLocationBtn");
  if (useLocationBtn) {
    useLocationBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      await requestUserLocation(true);
    });
  }

  const refreshBtn = document.getElementById("refreshBtn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", async () => {
      setStatus("Refreshing...");
      try {
        await refreshAll();
        setStatus("Loaded.");
      } catch (e) {
        setStatus(`${e?.message || "Failed to refresh"}`);
      }
    });
  }

  const loadPlacesBtn = document.getElementById("loadPlacesBtn");
  if (loadPlacesBtn) {
    loadPlacesBtn.addEventListener("click", async () => {
      setStatus("Loading places...");
      try {
        await loadPlaces();
        setStatus("Places loaded.");
      } catch (e) {
        setStatus(`${e?.message || "Failed to load places"}`);
      }
    });
  }

  const searchInput = document.getElementById("searchInput");
  const categorySelect = document.getElementById("categorySelect");
  if (searchInput) {
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") loadPlaces().catch(() => {});
    });
  }
  if (categorySelect) {
    categorySelect.addEventListener("change", () =>
      loadPlaces().catch(() => {})
    );
  }

  // ---------------------
  // KEY FIX: handle INITIAL_SESSION on refresh
  // ---------------------
  supabaseClient.auth.onAuthStateChange(async (event, session) => {
    if (event === "INITIAL_SESSION") {
      // Always load public data
      try {
        await Promise.all([loadPlaces(), loadLeaderboard(), loadRewards()]);
      } catch (_) {}

      await updateAuthButton();

      if (session) {
        closeModal();
        await loadProfileIfLoggedIn();
        await loadMyRedemptions();
        await requestUserLocation(false);
      } else {
        renderLoggedOutProfile();
      }

      setStatus("Loaded.");
      return;
    }

    if (event === "SIGNED_IN") {
      closeModal();
      await updateAuthButton();
      setStatus("Signed in. Loading profile...");

      try {
        await Promise.all([loadPlaces(), loadLeaderboard(), loadRewards()]);
      } catch (_) {}

      await loadProfileIfLoggedIn();
      await loadMyRedemptions();
      await requestUserLocation(false);

      // broadcast to other tabs (helps when SIGNED_IN happens without code param)
      AUTH_CHANNEL.postMessage({ type: "SIGNED_IN", at: Date.now() });

      // Continue pending actions
      if (pendingCheckinPlaceId) {
        const pid = pendingCheckinPlaceId;
        pendingCheckinPlaceId = null;
        setStatus("Continuing your check-in...");
        await handleCheckin(pid);
      }

      if (pendingRedeemRewardId) {
        const rid = pendingRedeemRewardId;
        pendingRedeemRewardId = null;
        await handleRedeem(rid);
      }

      setStatus("Loaded.");
      return;
    }

    if (event === "SIGNED_OUT") {
      // broadcast to other tabs
      AUTH_CHANNEL.postMessage({ type: "SIGNED_OUT", at: Date.now() });

      await resetToGuestState("Signed out.");
      await updateAuthButton();
      return;
    }
  });

  // Small UX: ask location quietly on load
  requestUserLocation(false).catch(() => {});
});
