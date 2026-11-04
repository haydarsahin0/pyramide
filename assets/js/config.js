/*
 * Pyramide Göttingen — configuration
 * Fill these in to go live. See README.md for step-by-step setup.
 */
window.PYRAMIDE_CONFIG = {
  // Supabase project for appointment bookings (Project Settings → API).
  // Example url: "https://xxxxxxxxxxxx.supabase.co"
  supabaseUrl: "https://tdwtqlqnmlqdwhavwaer.supabase.co",
  supabaseAnonKey: "sb_publishable_RB6sXIDgr3RsYUutzqH0kg_JIWVJglC",
  // public anon key (JWT form) used only for the live Realtime signal
  realtimeKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRkd3RxbHFubWxxZHdoYXZ3YWVyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc0NjU1NzYsImV4cCI6MjEwMzA0MTU3Nn0.mJ9ufpAF9B6nU40YsVri_TVjSU7JKYkfHYMHAIc8k2M",

  // Product
  priceEur: 7,       // first sticker (paid in cash at pickup)
  priceExtraEur: 6,  // every further sticker in the same reservation
  maxQty: 5,         // stickers per reservation

  // Pickup schedule (Europe/Berlin time)
  timezone: "Europe/Berlin",
  openHour: 10,      // first slot 10:00
  closeHour: 20,     // last slot starts 19:30
  slotMinutes: 30,
  daysAhead: 14,     // how many days can be booked in advance
  leadMinutes: 30,   // a slot must start at least this many minutes from now

  // Pickup place
  placeName: "LSG",
  placeLong: "LSG – Lern- und Studiengebäude",
  placeAddress: "Platz der Göttinger Sieben 3, 37073 Göttingen",
  mapsQuery: "Lern- und Studiengebäude Göttingen, Platz der Göttinger Sieben 3, 37073 Göttingen",

  // Express pickup: available while the current hour is opened in admin.html
  expressFeeEur: 3,
  expressWindowMinutes: 60  // Express: pickup within this many minutes
};

// total for a reservation: first sticker full price, every further one cheaper
window.PYRAMIDE_CONFIG.total = function (qty, express) {
  const q = Math.max(0, qty | 0);
  return q ? this.priceEur + (q - 1) * this.priceExtraEur + (express ? this.expressFeeEur : 0) : 0;
};
