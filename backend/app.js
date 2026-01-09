require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json());

app.get("/api/health", (req, res) => res.json({ ok: true }));

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const RADIUS_METERS = 200;

const APP_TZ = "Asia/Singapore";

function dateStrInTZ(date = new Date(), timeZone = APP_TZ) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function yesterdayStrInTZ(timeZone = APP_TZ) {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return dateStrInTZ(d, timeZone);
}

function isYesterdayStr(lastDateStr, timeZone = APP_TZ) {
  if (!lastDateStr) return false;
  return String(lastDateStr) === yesterdayStrInTZ(timeZone);
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const toRad = (x) => (x * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function computeBadges(points) {
  const badges = [];
  if (points >= 50) badges.push("🌱 Green Starter");
  if (points >= 150) badges.push("🏆 Eco Warrior");
  if (points >= 300) badges.push("👑 Eco Legend");
  return badges;
}

function generateVoucherCode(prefix = "ECO") {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const part = (len) =>
    Array.from(
      { length: len },
      () => chars[Math.floor(Math.random() * chars.length)]
    ).join("");
  return `${prefix}-${part(4)}-${part(4)}`;
}

async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Missing Bearer token" });

    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    req.authUser = data.user;
    next();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Auth verification failed" });
  }
}

async function getOrCreateAppUser(authUser) {
  const authUserId = authUser.id;
  const email = authUser.email || null;
  const username = email ? email.split("@")[0] : "player";

  const found = await supabaseAdmin
    .from("users")
    .select("*")
    .eq("auth_user_id", authUserId)
    .limit(1)
    .maybeSingle();

  if (found.error) throw found.error;
  if (found.data) return found.data;

  const created = await supabaseAdmin
    .from("users")
    .insert([{ auth_user_id: authUserId, email, username }])
    .select("*")
    .single();

  if (created.error) throw created.error;
  return created.data;
}

app.get("/api/places", async (req, res) => {
  try {
    const search = String(req.query.search || "")
      .trim()
      .toLowerCase();
    const category = String(req.query.category || "").trim();

    let q = supabaseAdmin
      .from("places")
      .select("id,name,category,area,points,description,lat,lng");

    if (category) q = q.eq("category", category);

    if (search) {
      q = q.or(
        `name.ilike.%${search}%,description.ilike.%${search}%,area.ilike.%${search}%`
      );
    }

    const { data, error } = await q.order("name", { ascending: true });
    if (error) throw error;

    res.json(data || []);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load places" });
  }
});

app.get("/api/leaderboard", async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("users")
      .select("username,points")
      .order("points", { ascending: false })
      .order("username", { ascending: true })
      .limit(10);

    if (error) throw error;
    res.json(data || []);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load leaderboard" });
  }
});

app.get("/api/rewards", async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("rewards")
      .select("id,name,brand,cost_points,image_url")
      .order("cost_points", { ascending: true })
      .order("name", { ascending: true });

    if (error) throw error;
    res.json(data || []);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load rewards" });
  }
});

app.post("/api/redeem", requireAuth, async (req, res) => {
  try {
    const { rewardId } = req.body;
    if (!rewardId) return res.status(400).json({ error: "rewardId required" });

    const appUser = await getOrCreateAppUser(req.authUser);

    const rewardRes = await supabaseAdmin
      .from("rewards")
      .select("id,name,brand,cost_points,image_url")
      .eq("id", rewardId)
      .single();

    if (rewardRes.error) throw rewardRes.error;
    const reward = rewardRes.data;

    const cost = Number(reward.cost_points || 0);
    const currentPoints = Number(appUser.points || 0);

    if (!Number.isFinite(cost) || cost <= 0) {
      return res.status(400).json({ error: "Invalid reward cost_points" });
    }

    if (currentPoints < cost) {
      return res.status(400).json({
        error: `Not enough points. Need ${cost}, you have ${currentPoints}.`,
      });
    }

    const prefix =
      String(reward.brand || "ECO")
        .toUpperCase()
        .replace(/[^A-Z]/g, "")
        .slice(0, 4) || "ECO";

    const voucherCode = generateVoucherCode(prefix);

    const ins = await supabaseAdmin.from("redemptions").insert([
      {
        user_id: appUser.id,
        reward_id: reward.id,
        voucher_code: voucherCode,
        points_spent: cost,
      },
    ]);

    if (ins.error) throw ins.error;

    const upd = await supabaseAdmin
      .from("users")
      .update({ points: currentPoints - cost })
      .eq("id", appUser.id)
      .select("*")
      .single();

    if (upd.error) throw upd.error;

    res.json({
      ok: true,
      reward: {
        id: reward.id,
        name: reward.name,
        brand: reward.brand,
        cost_points: cost,
        image_url: reward.image_url,
      },
      voucherCode,
      pointsRemaining: upd.data.points,
      badges: computeBadges(upd.data.points),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Redeem failed" });
  }
});

app.get("/api/my-redemptions", requireAuth, async (req, res) => {
  try {
    const appUser = await getOrCreateAppUser(req.authUser);

    const { data, error } = await supabaseAdmin
      .from("redemptions")
      .select(
        "id,voucher_code,points_spent,created_at,reward_id,rewards(name,brand,image_url,cost_points)"
      )
      .eq("user_id", appUser.id)
      .order("created_at", { ascending: false })
      .limit(6);

    if (error) throw error;

    const mapped = (data || []).map((r) => ({
      id: r.id,
      voucher_code: r.voucher_code,
      points_spent: r.points_spent,
      created_at: r.created_at,
      reward: r.rewards
        ? {
            name: r.rewards.name,
            brand: r.rewards.brand,
            image_url: r.rewards.image_url,
            cost_points: r.rewards.cost_points,
          }
        : null,
    }));

    res.json(mapped);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load redemptions" });
  }
});

app.get("/api/profile", requireAuth, async (req, res) => {
  try {
    const user = await getOrCreateAppUser(req.authUser);
    res.json({
      username: user.username,
      email: user.email,
      points: user.points,
      streak: user.streak,
      badges: computeBadges(user.points),
      lastCheckinDate: user.last_checkin_date,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load profile" });
  }
});

app.post("/api/checkins", requireAuth, async (req, res) => {
  try {
    const { placeId, userLat, userLng } = req.body;
    if (!placeId) return res.status(400).json({ error: "placeId required" });
    if (userLat === undefined || userLng === undefined) {
      return res.status(400).json({ error: "userLat and userLng required" });
    }

    const appUser = await getOrCreateAppUser(req.authUser);

    const placeRes = await supabaseAdmin
      .from("places")
      .select("id,name,points,lat,lng")
      .eq("id", placeId)
      .single();

    if (placeRes.error) throw placeRes.error;
    const place = placeRes.data;

    const dist = haversineMeters(
      Number(userLat),
      Number(userLng),
      Number(place.lat),
      Number(place.lng)
    );

    if (dist > RADIUS_METERS) {
      return res.status(403).json({
        error: `Too far. You are ~${Math.round(
          dist
        )}m away (need within ${RADIUS_METERS}m).`,
      });
    }

    const todayStr = dateStrInTZ();

    if (String(appUser.last_checkin_date || "") === todayStr) {
      return res.status(409).json({ error: "Already checked in today." });
    }

    let newStreak = appUser.streak;
    if (!appUser.last_checkin_date) newStreak = 1;
    else if (isYesterdayStr(appUser.last_checkin_date))
      newStreak = (appUser.streak || 0) + 1;
    else newStreak = 1;

    const pointsGained = Number(place.points) || 0;

    const ins = await supabaseAdmin.from("checkins").insert([
      {
        user_id: appUser.id,
        place_id: place.id,
        points_gained: pointsGained,
      },
    ]);

    if (ins.error) throw ins.error;

    const upd = await supabaseAdmin
      .from("users")
      .update({
        points: (appUser.points || 0) + pointsGained,
        streak: newStreak,
        last_checkin_date: todayStr,
      })
      .eq("id", appUser.id)
      .select("*")
      .single();

    if (upd.error) throw upd.error;

    res.json({
      ok: true,
      place: place.name,
      gained: pointsGained,
      distanceMeters: Math.round(dist),
      username: upd.data.username,
      points: upd.data.points,
      streak: upd.data.streak,
      badges: computeBadges(upd.data.points),
      today: todayStr,
      tz: APP_TZ,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Check-in failed" });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`API running at http://localhost:${PORT}`));
