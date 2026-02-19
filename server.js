const express = require('express');
const webpush = require('web-push');
const cron = require('node-cron');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ─── VAPID KEYS ───────────────────────────────────────────────────────────────
// These are generated once. Keep them safe.
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

webpush.setVapidDetails(
  'mailto:ramadan@notifier.com',
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

// ─── STORE SUBSCRIPTIONS ──────────────────────────────────────────────────────
let subscriptions = [];
const SUBS_FILE = '/tmp/subscriptions.json';

function loadSubscriptions() {
  try {
    if (fs.existsSync(SUBS_FILE)) {
      subscriptions = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8'));
      console.log(`Loaded ${subscriptions.length} subscriptions`);
    }
  } catch (e) {
    subscriptions = [];
  }
}

function saveSubscriptions() {
  try {
    fs.writeFileSync(SUBS_FILE, JSON.stringify(subscriptions));
  } catch (e) {
    console.error('Error saving subscriptions', e);
  }
}

loadSubscriptions();

// ─── RAMADAN SCHEDULE OFFSETS (minutes relative to Maghrib) ──────────────────
const SCHEDULE = [
  { offset: -60,  title: '🚶 Time for your walk!',           body: 'Start your 20–30 min pre-Iftar fat-burn walk. Finish before Adhan.' },
  { offset: 0,    title: '🌙 Break your fast!',               body: 'Drink 250ml warm water slowly. Don\'t chug!' },
  { offset: 5,    title: '🍽️ Iftar meal time',                body: 'Start light, then your main plate. Eat normally.' },
  { offset: 40,   title: '⏸️ Digestion gap',                  body: 'No big water now. Tiny sips only if needed. Let your body digest.' },
  { offset: 60,   title: '💧 Hydration #2',                   body: 'Drink 250ml cool water. Resume hydration.' },
  { offset: 100,  title: '💧 Hydration #3',                   body: 'Drink 250ml cool water. Keep it steady.' },
  { offset: 145,  title: '💧 Hydration #4',                   body: 'Drink 250ml cool water.' },
  { offset: 155,  title: '🍬 Dessert window opens!',          body: 'Dessert is OK now! Keep it to 1 palm portion.' },
  { offset: 160,  title: '💧 Extra Hydration',                body: 'Drink 250ml cool water.' },
  { offset: 175,  title: '💧 Extra Hydration',                body: 'Drink 250ml cool water. Almost at 2L!' },
  { offset: 205,  title: '💧 Hydration #5',                   body: 'Drink 200–250ml warm water. After dessert hydration.' },
  { offset: 255,  title: '🥗 Last meal time (protein cap)',   body: 'Light meal: milk/yogurt/eggs/cheese + cucumber/tomato.' },
  { offset: 300,  title: '💧 Last big drink of the night',    body: 'Drink 300ml cool water. This is your last proper drink!' },
  { offset: 325,  title: '🚫 Fluids OFF',                     body: 'Stop drinking now. Tiny sips only if mouth is dry. Sleep well!' },
];

// ─── FETCH MAGHRIB TIME FOR A GIVEN DATE ─────────────────────────────────────
async function getMaghribTime(date) {
  // date: JS Date object
  const day = date.getDate();
  const month = date.getMonth() + 1;
  const year = date.getFullYear();

  const url = `https://api.aladhan.com/v1/timingsByCity/${day}-${month}-${year}?city=Cairo&country=Egypt&method=5`;
  const response = await axios.get(url);
  const maghribStr = response.data.data.timings.Maghrib; // e.g. "18:15" in Cairo local time
  const [hours, minutes] = maghribStr.split(':').map(Number);

  // Cairo is UTC+2. We construct the time as UTC by subtracting 2 hours.
  // This ensures the server (which runs in UTC) fires notifications at the correct Cairo time.
  const maghrib = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hours - 2, minutes, 0, 0));
  return maghrib;
}

// ─── SEND NOTIFICATION TO ALL SUBSCRIBERS ────────────────────────────────────
async function sendNotification(title, body) {
  const payload = JSON.stringify({ title, body });
  const toRemove = [];

  for (let i = 0; i < subscriptions.length; i++) {
    try {
      await webpush.sendNotification(subscriptions[i], payload);
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        toRemove.push(i);
      }
    }
  }

  // Remove expired subscriptions
  for (let i = toRemove.length - 1; i >= 0; i--) {
    subscriptions.splice(toRemove[i], 1);
  }
  if (toRemove.length > 0) saveSubscriptions();

  console.log(`Sent notification: ${title}`);
}

// ─── DAILY SCHEDULER ─────────────────────────────────────────────────────────
// Runs every minute and checks if any notification is due
let todaySchedule = [];
let lastScheduleDate = null;

async function buildTodaySchedule() {
  const today = new Date();
  const dateKey = today.toDateString();

  if (lastScheduleDate === dateKey) return; // already built for today
  lastScheduleDate = dateKey;
  todaySchedule = [];

  try {
    const maghrib = await getMaghribTime(today);
    console.log(`Today Maghrib: ${maghrib.toTimeString()}`);

    for (const step of SCHEDULE) {
      const notifTime = new Date(maghrib.getTime() + step.offset * 60000);
      todaySchedule.push({
        time: notifTime,
        title: step.title,
        body: step.body,
        sent: false
      });
    }

    console.log(`Built schedule with ${todaySchedule.length} notifications`);
  } catch (err) {
    console.error('Error fetching prayer times:', err.message);
  }
}

// Run every minute
cron.schedule('* * * * *', async () => {
  await buildTodaySchedule();

  const now = new Date();
  for (const item of todaySchedule) {
    if (!item.sent && now >= item.time && (now - item.time) < 90000) {
      // within 90 seconds window
      item.sent = true;
      await sendNotification(item.title, item.body);
    }
  }
});

// Also build schedule on startup
buildTodaySchedule();

// ─── API ROUTES ───────────────────────────────────────────────────────────────

// Subscribe
app.post('/subscribe', (req, res) => {
  const subscription = req.body;
  const exists = subscriptions.find(s => s.endpoint === subscription.endpoint);
  if (!exists) {
    subscriptions.push(subscription);
    saveSubscriptions();
    console.log('New subscription added');
  }
  res.json({ success: true });
});

// Get VAPID public key
app.get('/vapid-public-key', (req, res) => {
  res.json({ key: VAPID_PUBLIC_KEY });
});

// Get today's schedule (for display in UI)
app.get('/today-schedule', async (req, res) => {
  await buildTodaySchedule();
  const schedule = todaySchedule.map(item => ({
    time: item.time.toLocaleTimeString('en-EG', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Africa/Cairo' }),
    title: item.title,
    body: item.body,
    sent: item.sent
  }));
  res.json(schedule);
});

// Test notification
app.post('/test-notification', async (req, res) => {
  await sendNotification('🧪 Test Notification', 'Your Ramadan notifier is working!');
  res.json({ success: true });
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ─── START SERVER ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Ramadan Notifier server running on port ${PORT}`);
});
