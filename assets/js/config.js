/*
 * Pyramide Göttingen — configuration
 * Fill these in to go live. See README.md for step-by-step setup.
 */
window.PYRAMIDE_CONFIG = {
  // Supabase project for appointment bookings (Project Settings → API).
  // Example url: "https://xxxxxxxxxxxx.supabase.co"
  supabaseUrl: "https://tdwtqlqnmlqdwhavwaer.supabase.co",
  supabaseAnonKey: "sb_publishable_RB6sXIDgr3RsYUutzqH0kg_JIWVJglC",

  // Product
  priceEur: 7,       // paid in cash at pickup
  maxQty: 5,         // stickers per reservation

  // Pickup schedule (Europe/Berlin time)
  timezone: "Europe/Berlin",
  openHour: 10,      // first slot 10:00
  closeHour: 20,     // last slot starts 19:30
  slotMinutes: 30,
  daysAhead: 14,     // how many days can be booked in advance
  leadMinutes: 30,   // a slot must start at least this many minutes from now

  // Pickup place
  placeName: "SUB Café",
  placeAddress: "Platz der Göttinger Sieben 1, 37073 Göttingen",
  mapsQuery: "SUB Göttingen, Platz der Göttinger Sieben 1, 37073 Göttingen"
};
