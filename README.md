# Pyramide Göttingen

Tek ürünlü sticker sitesi — Almanca / İngilizce, Stripe ile ödeme, SUB Café (2. kat) teslim randevusu.
Saf HTML/CSS/JS; GitHub Pages'te build gerektirmeden çalışır.

**Canlı adres:** https://haydarsahin0.github.io/pyramide/

## Akış

1. Ziyaretçi **Kaufen / Buy** butonuna basar → site `PYR-XXXXXX` biçiminde bir sipariş numarası üretir.
2. Stripe Payment Link'e yönlendirilir; sipariş numarası `client_reference_id` olarak Stripe'a gider
   (Stripe panelinde ödemenin detayında görünür).
3. Ödeme sonrası siteye geri döner → sipariş numarası gösterilir, kaydetmesi istenir (kopyala / resim olarak kaydet).
4. Takvim açılır: her gün 10:00–20:00, 30 dakikalık slotlar. Dolu saatler seçilemez.
5. Onay ekranı + takvime ekle (.ics) + yol tarifi.

Ziyaretçi sonradan sağ üstteki **Termin buchen** ile sipariş numarasını girip randevu alabilir veya değiştirebilir.

## Canlıya alma

Ayarların hepsi `assets/js/config.js` içinde. İkisi de boşken site **önizleme modunda** çalışır
(üstte ince bir uyarı şeridi görünür, ödeme simüle edilir, randevular sadece tarayıcıda tutulur).

### 1. Stripe

1. Stripe Dashboard → **Payment Links** → **New**.
2. Ürün: "Pyramide Sticker", fiyat **6,00 EUR** (tek seferlik). İstersen *Let customers adjust quantity* açık olsun.
3. **After payment** → *Don't show confirmation page* → *Redirect customers to your website*:
   ```
   https://haydarsahin0.github.io/pyramide/?paid=1&session_id={CHECKOUT_SESSION_ID}
   ```
4. Oluşan linki (`https://buy.stripe.com/...`) `config.js` → `stripePaymentLink` alanına yapıştır.

Teslimde: müşterinin söylediği numarayı Stripe → Payments → ödeme detayındaki **Client reference ID** ile karşılaştır.

### 2. Supabase (randevular)

1. Supabase'de bir proje aç (veya mevcut birini kullan) → **SQL Editor** → `supabase/schema.sql` içeriğini çalıştır.
2. **Project Settings → API**: Project URL'i `supabaseUrl`, *anon / publishable* anahtarı `supabaseAnonKey` alanına yaz.
3. Randevuları **Table Editor → pyramide_bookings** (veya `pyramide_bookings_berlin` görünümü, Berlin saatiyle) üzerinden görürsün.
   Teslim ettiğinde `picked_up` alanını `true` yapabilirsin.

Ziyaretçiler tabloyu doğrudan okuyamaz; sadece hangi saatlerin dolu olduğunu görebilir ve kendi sipariş numaraları için randevu alabilir/değiştirebilir.

### 3. GitHub Pages

Repo → **Settings → Pages** → *Build and deployment* → **Deploy from a branch** → bu branch'i ve `/ (root)` klasörünü seç → Save.
Birkaç dakika içinde site yukarıdaki adreste yayında olur.

## Yapı

```
index.html             tek sayfa (mağaza, sipariş no, takvim, onay)
assets/css/style.css   tasarım
assets/js/config.js    Stripe / Supabase / saat ayarları
assets/js/i18n.js      DE + EN metinler
assets/js/app.js       mantık
assets/img/            sticker, bayraklar, ikonlar
supabase/schema.sql    randevu tablosu + fonksiyonlar
```

Saatleri değiştirmek için `config.js` içindeki `openHour`, `closeHour`, `slotMinutes`, `daysAhead`
ve aynı değerleri `supabase/schema.sql` → `pyramide_book` içindeki kontrolde güncelle.
