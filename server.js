/* ============================================================
   Amarina Entertainment — Push Notification Server
   ------------------------------------------------------------
   This small server is what makes notifications work like
   WhatsApp: it can wake a phone that is LOCKED or has the app
   FULLY CLOSED, and play a sound.

   You run this once on a free host (Render.com, Railway.app,
   or any Node host). It listens to your Supabase database and
   sends a push the moment a new message / booking / request /
   task appears.

   SETUP (one time):
   1. Put your VAPID keys below (from VAPID_KEYS.txt).
   2. Put your Supabase URL + service key below.
   3. Deploy to Render.com (free) — see GUIDE.md.
   ============================================================ */

const webpush = require('web-push');
const { createClient } = require('@supabase/supabase-js');
const http = require('http');

// ---- 1) YOUR KEYS (fill these in) ----
const VAPID_PUBLIC  = 'BBVFLaJhNy8JyyYiGPGOI7hFk9GVmgzWxo7ZSy5_Uo44xTg91TlQAppm8Y96xnmUHcr-4u81w4YxVrtZqqCSML8';
const VAPID_PRIVATE = 'J411QS4RbHfRb7zVOolQLAaCvcgYL98B4TgGVj_fb6o';
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || 'mailto:amarina@example.com';

// ---- 2) YOUR SUPABASE (fill these in) ----
const SUPABASE_URL = 'https://smecztwnxieovszndxga.supabase.co';
// IMPORTANT: use the *service_role* key here (Supabase → Settings → API).
// This key is secret and lives ONLY on the server, never in the app.
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'PASTE_SUPABASE_SERVICE_ROLE_KEY';

// ------------------------------------------------------------
webpush.setVapidDetails(CONTACT_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Send a push to every saved subscription (optionally filtered by role/room)
async function pushToAll(payload, filter) {
  const { data: subs, error } = await sb.from('push_subscriptions').select('*');
  if (error) { console.error('load subs', error.message); return; }
  const body = JSON.stringify(payload);
  await Promise.all((subs || []).filter(s => {
    if (!filter) return true;
    if (filter.role && s.role !== filter.role) return false;
    if (filter.room && String(s.room) !== String(filter.room)) return false;
    if (filter.username && s.username !== filter.username) return false;
    return true;
  }).map(async s => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        body
      );
    } catch (e) {
      // 410/404 = subscription expired, remove it
      if (e.statusCode === 410 || e.statusCode === 404) {
        await sb.from('push_subscriptions').delete().eq('endpoint', s.endpoint);
      }
    }
  }));
}

// ---- Listen to database changes in real time ----
function listen() {
  sb.channel('push-watch')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, p => {
      const m = p.new;
      if (m.sender === 'team') {
        // manager → guest or staff room
        if (String(m.room).startsWith('staff:')) {
          pushToAll({ title: 'New message', body: 'Your manager sent you a message' },
                    { username: String(m.room).slice(6) });
        } else {
          pushToAll({ title: 'New message', body: 'You have a new message' },
                    { room: m.room });
        }
      } else {
        // guest/staff → manager
        pushToAll({ title: 'New message', body: 'A guest sent a message' }, { role: 'manager' });
      }
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'bookings' }, () => {
      pushToAll({ title: 'New booking', body: 'A guest booked an activity' }, { role: 'manager' });
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'requests' }, () => {
      pushToAll({ title: 'New guest request', body: 'A guest sent a request' }, { role: 'manager' });
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'tasks' }, p => {
      const tk = p.new;
      if (tk.assigned_to) pushToAll({ title: 'New activity assigned', body: 'You have a new task' },
                                    { username: tk.assigned_to });
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'announcements' }, p => {
      pushToAll({ title: 'New notification', body: p.new.title || 'Tap to open the app' });
    })
    .subscribe(st => console.log('realtime:', st));
}
listen();

// ---- Tiny HTTP endpoint so hosts keep the server awake + health check ----
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Amarina push server running');
}).listen(process.env.PORT || 3000, () => console.log('push server up'));
