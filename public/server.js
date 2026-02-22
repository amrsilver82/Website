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

// ─── RAMADAN SCHEDULE v2 ──────────────────────────────────────────────────────
// offset        = minutes relative to Maghrib (I)
// shiftable     = shifts when meal finish is logged
// shiftOffset   = minutes after meal finish time
// dessertShiftable  = shifts when dessert finish is logged
// dessertShiftOffset = minutes after dessert finish time
//
// Full schedule based on Maghrib = 5:47 PM Cairo example:
// 4:47 PM  | Walk           | I-60
// 5:47 PM  | Hydration #1   | I+0    (break fast 250ml warm)
// 5:52 PM  | Iftar meal     | I+5
// 6:27 PM  | Digestion gap  | I+40
// 6:47 PM  | Hydration #2   | I+60   (60 mins from #1)
// 7:27 PM  | Hydration #3   | I+100  (40 mins)
// 7:57 PM  | Hydration #4   | I+130  (30 mins, 25 mins before dessert)
// 8:22 PM  | Dessert window | I+155  (25 mins after #4)
// 9:12 PM  | Hydration #5   | I+205  (50 mins after dessert)
// 9:47 PM  | Hydration #6   | I+240  (35 mins)
// 10:02 PM | Late dinner    | I+255  (15 mins after #6)
// 10:32 PM | Hydration #7   | I+285  (30 mins after dinner)
// 11:02 PM | Hydration #8   | I+315  (30 mins) - Last big drink 300ml
// 11:27 PM | Fluids OFF     | I+340  (25 mins)
// Total water: 7x250ml + 1x300ml = 2050ml ✅

const SCHEDULE = [
  {
    offset: -60,
    shiftable: false,
    title: '🚶 Time for your walk!',
    body: 'Start your 20-30 min pre-Iftar fat-burn walk. Finish before Adhan.'
  },
  {
    offset: 0,
    shiftable: false,
    title: '💧 Hydration #1',
    body: 'Break your fast! Drink 250ml warm water slowly. Do not chug!'
  },
  {
    offset: 5,
    shiftable: false,
    title: '🍽️ Iftar meal time',
    body: 'Start light, then your main plate. Eat normally.'
  },
  {
    offset: 40,
    shiftable: true,
    shiftOffset: 0,
    title: '⏸️ Digestion gap',
    body: 'No big water now. Tiny sips only if needed. Let your body digest.'
  },
  {
    offset: 60,
    shiftable: true,
    shiftOffset: 20,
    title: '💧 Hydration #2',
    body: 'Drink 250ml cool water. Resume hydration.'
  },
  {
    offset: 100,
    shiftable: true,
    shiftOffset: 60,
    title: '💧 Hydration #3',
    body: 'Drink 250ml cool water. Keep it steady.'
  },
  {
    offset: 130,
    shiftable: true,
    shiftOffset: 90,
    title: '💧 Hydration #4',
    body: 'Drink 250ml cool water. 25 mins before dessert window.'
  },
  {
    offset: 155,
    shiftable: true,
    shiftOffset: 115,
    title: '🍬 Dessert window opens!',
    body: 'Dessert is OK now! Keep it to 1 palm portion.'
  },
  {
    offset: 205,
    shiftable: true,
    shiftOffset: 165,
    dessertShiftable: true,
    dessertShiftOffset: 0,
    title: '💧 Hydration #5',
    body: 'Drink 250ml cool water. First hydration after dessert.'
  },
  {
    offset: 240,
    shiftable: true,
    shiftOffset: 200,
    dessertShiftable: true,
    dessertShiftOffset: 35,
    title: '💧 Hydration #6',
    body: 'Drink 250ml cool water.'
  },
  {
    offset: 255,
    shiftable: true,
    shiftOffset: 215,
    dessertShiftable: true,
    dessertShiftOffset: 50,
    title: '🥗 Late dinner (protein cap)',
    body: 'Light meal: milk/yogurt/eggs/cheese + cucumber/tomato.'
  },
  {
    offset: 285,
    shiftable: true,
    shiftOffset: 245,
    dessertShiftable: true,
    dessertShiftOffset: 80,
    title: '💧 Hydration #7',
    body: 'Drink 250ml cool water. 30 mins after late dinner.'
  },
  {
    offset: 315,
    shiftable: true,
    shiftOffset: 275,
    dessertShiftable: true,
    dessertShiftOffset: 110,
    title: '💧 Hydration #8',
    body: 'Drink 300ml warm water. Last big drink of the night!'
  },
  {
    offset: 340,
    shiftable: true,
    shiftOffset: 300,
    dessertShiftable: true,
    dessertShiftOffset: 135,
    title: '🚫 Fluids OFF',
    body: 'Stop drinking now. Tiny sips only if mouth is dry. Sleep well!'
  },
];

// ─── FETCH MAGHRIB TIME ───────────────────────────────────────────────────────
async function getMaghribTime(date) {
  const day = date.getDate();
  const month = date.getMonth() + 1;
  const year = date.getFullYear();

  const url = `https://api.aladhan.com/v1/timingsByCity/${day}-${month}-${year}?city=Cairo&country=Egypt&method=5`;
  const response = await axios.get(url);
  const maghribStr = response.data.data.timings.Maghrib;
  const [hours, minutes] = maghribStr.split(':').map(Number);

  // Cairo is UTC+2. Store as UTC by subtracting 2 hours.
  const maghrib = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    hours - 2,
    minutes,
    0, 0
  ));
  return maghrib;
}

// ─── SEND NOTIFICATION ────────────────────────────────────────────────────────
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

  for (let i = toRemove.length - 1; i >= 0; i--) {
    subscriptions.splice(toRemove[i], 1);
  }
  if (toRemove.length > 0) saveSubscriptions();
  console.log(`Sent notification: ${title}`);
}

// ─── DAILY SCHEDULER ─────────────────────────────────────────────────────────
let todaySchedule = [];
let lastScheduleDate = null;
let mealFinishTime = null;
let dessertFinishTime = null;

async function buildTodaySchedule() {
  const today = new Date();
  const dateKey = today.toDateString();

  if (lastScheduleDate === dateKey) return;
  lastScheduleDate = dateKey;
  todaySchedule = [];
  mealFinishTime = null;
  dessertFinishTime = null;

  try {
    const maghrib = await getMaghribTime(today);
    console.log(`Today Maghrib: ${maghrib.toTimeString()}`);

    for (const step of SCHEDULE) {
      const notifTime = new Date(maghrib.getTime() + step.offset * 60000);
      todaySchedule.push({
        time: notifTime,
        title: step.title,
        body: step.body,
        shiftable: step.shiftable || false,
        shiftOffset: step.shiftOffset || 0,
        dessertShiftable: step.dessertShiftable || false,
        dessertShiftOffset: step.dessertShiftOffset || 0,
        sent: false,
        shifted: false
      });
    }

    console.log(`Built schedule with ${todaySchedule.length} notifications`);
  } catch (err) {
    console.error('Error fetching prayer times:', err.message);
  }
}

// ─── SHIFT AFTER MEAL FINISH ──────────────────────────────────────────────────
function applyMealFinishShift(finishTime) {
  mealFinishTime = finishTime;
  let shifted = 0;
  for (const item of todaySchedule) {
    if (item.shiftable && !item.sent) {
      item.time = new Date(finishTime.getTime() + item.shiftOffset * 60000);
      item.shifted = true;
      shifted++;
    }
  }
  console.log(`Shifted ${shifted} notifications based on meal finish: ${finishTime.toISOString()}`);
}

// ─── SHIFT AFTER DESSERT FINISH ───────────────────────────────────────────────
function applyDessertFinishShift(finishTime) {
  dessertFinishTime = finishTime;
  let shifted = 0;
  for (const item of todaySchedule) {
    if (item.dessertShiftable && !item.sent) {
      item.time = new Date(finishTime.getTime() + item.dessertShiftOffset * 60000);
      item.shifted = true;
      shifted++;
    }
  }
  console.log(`Shifted ${shifted} notifications based on dessert finish: ${finishTime.toISOString()}`);
}

// ─── CRON: CHECK EVERY MINUTE ─────────────────────────────────────────────────
cron.schedule('* * * * *', async () => {
  await buildTodaySchedule();
  const now = new Date();
  for (const item of todaySchedule) {
    if (!item.sent && now >= item.time && (now - item.time) < 90000) {
      item.sent = true;
      await sendNotification(item.title, item.body);
    }
  }
});

buildTodaySchedule();

// ─── API ROUTES ───────────────────────────────────────────────────────────────

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

app.get('/vapid-public-key', (req, res) => {
  res.json({ key: VAPID_PUBLIC_KEY });
});

app.post('/meal-finished', (req, res) => {
  const finishTime = new Date();
  applyMealFinishShift(finishTime);
  const cairoTime = finishTime.toLocaleTimeString('en-EG', {
    hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Africa/Cairo'
  });
  sendNotification('✅ Schedule updated!', `Meal finish logged at ${cairoTime}. All remaining notifications shifted.`);
  res.json({ success: true, finishTime: cairoTime });
});

app.post('/reset-meal', (req, res) => {
  mealFinishTime = null;
  lastScheduleDate = null;
  buildTodaySchedule();
  console.log('Meal finish reset.');
  res.json({ success: true });
});

app.post('/dessert-finished', (req, res) => {
  const finishTime = new Date();
  applyDessertFinishShift(finishTime);
  const cairoTime = finishTime.toLocaleTimeString('en-EG', {
    hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Africa/Cairo'
  });
  sendNotification('🍬 Dessert logged!', `Finished at ${cairoTime}. Remaining notifications shifted.`);
  res.json({ success: true, finishTime: cairoTime });
});

app.post('/reset-dessert', (req, res) => {
  dessertFinishTime = null;
  lastScheduleDate = null;
  buildTodaySchedule();
  console.log('Dessert finish reset.');
  res.json({ success: true });
});

app.get('/today-schedule', async (req, res) => {
  await buildTodaySchedule();
  const schedule = todaySchedule.map(item => ({
    time: item.time.toLocaleTimeString('en-EG', {
      hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Africa/Cairo'
    }),
    title: item.title,
    body: item.body,
    sent: item.sent,
    shifted: item.shifted || false
  }));
  res.json({
    schedule,
    mealLogged: mealFinishTime !== null,
    dessertLogged: dessertFinishTime !== null
  });
});

app.post('/test-notification', async (req, res) => {
  await sendNotification('🧪 Test Notification', 'Your Ramadan notifier is working!');
  res.json({ success: true });
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ─── START SERVER ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Ramadan Notifier server running on port ${PORT}`);
});
