# Pyramide Göttingen

Tek ürünlü sticker sitesi (ilk sticker 7 €, ikinciden itibaren 6 €): Almanca / İngilizce, **ödeme teslimde nakit**, LSG (Lern- und Studiengebäude, Platz der Göttinger Sieben 3) teslim randevusu, isteğe bağlı Express (+3 €, 1 saat içinde) ve sana özel admin paneli.
Sadece HTML/CSS/JS kullanıyor; GitHub Pages'te build adımı gerekmeden çalışıyor.

- **Site:** https://haydarsahin0.github.io/pyramide/
- **Admin paneli:** https://haydarsahin0.github.io/pyramide/admin.html (sitede linki yok, şifreyle giriliyor)

## Müşteri akışı

1. **Reservieren / Reserve** → site `PYR-XXXXXX` biçiminde bir sipariş numarası (Bestellnummer) üretir.
2. Numara gösterilir; kopyalanabilir veya resim olarak kaydedilebilir. Devam etmek için müşteri üç şeyi işaretlemek zorundadır:
   numarayı kaydettim · parayı nakit getireceğim · randevuya zamanında geleceğim.
3. Takvim: her gün 10:00–20:00, 30 dakikalık saatler. Dolu saatler seçilemez. Adet (1–5) seçilir, getirilecek nakit tutarı gösterilir.
4. Onay ekranında "Bitte denk daran" kartı yer alır (nakit tutarı, saat, numara). Ayrıca takvime ekleme (.ics) ve yol tarifi vardır.

İki kural ("Bargeld mitbringen", "Pünktlich sein") ana sayfada büyük siyah bir kartta, kuralların özeti de SSS'te ve her adımda tekrar gösterilir.
Müşteri sağ üstteki **Termin buchen** ile numarasını girip randevusunu değiştirebilir.

## Admin paneli

**Genel bakış** sekmesi (15 saniyede bir yenilenir):
- Şu an sitede kaç kişi var ve her biri hangi adımda (ana sayfa, numara ekranı, takvim, onay), cihaz, dil, ne zamandır sitede, nereden geldi, rezervasyonu/sohbeti var mı
- Bugün / dün / son 7 / son 30 gün ziyaretçi, bugün ilk kez gelenler, rezervasyona dönüşme oranı
- Son 14 günün grafiği (altında günlük rezervasyon sayısı), bugün saat saat ziyaretçi, cihaz / dil / kaynak dağılımı

Ziyaretçi sayımı rastgele bir tarayıcı kimliğiyle yapılır (IP yok, isim yok). Admin sayfasını açan tarayıcı sayılmaz.


- Bugün / yaklaşan / geçmiş / tümü filtreleri, isim–numara–e-posta araması
- Her rezervasyonda saat, isim, e-posta, adet, alınacak nakit ve Bestellnummer görünür
- "Teslim edildi" düğmesi; rezervasyon silme (silinen saat tekrar boşa çıkar)
- Özet kartlar: bugünkü rezervasyonlar, beklenen nakit, teslim edilenler
- CSV olarak dışa aktarma (Excel'de açılır)
- Sayfa her dakika kendini yeniler

## Teslim saatleri (admin → Teslim saatleri)

**Standard (ücretsiz):**
- *Haftalık varsayılan*: her gün için açık saatler (her açık saat = :00 ve :30 randevusu). "10–20" ve "Kapat" kısayolları.
- *Önümüzdeki 14 gün*: bir güne dokunmak o güne özel ayar yapar (ör. bir günü kapatmak, saat eklemek). "Haftalık" butonu varsayılana döndürür.
- Ana sayfadaki "Zeiten" satırı haftalık ayardan otomatik özetlenir (ör. "Mo–Fr 10:00–18:00 · Sa 14:00–16:00 · So geschlossen").

**⚡ Express (+3 €, 1 saat içinde):**
- Müşteri saat seçmez: "Abholung innerhalb von 1 Stunde · bis spätestens HH:MM". Rezervasyon anı kaydedilir, müşteri 1 saat içinde gelir.
- Express yalnızca şu anki saat Express tablosunda açıksa ve Express düğmesi açıksa seçilebilir. "Şu andan 1 / 2 / 4 saat aç" kısayolları en pratik yol.
- Yeni Express rezervasyonu gelince admin panelinde üstte uyarı, ses ve sekme başlığında "⚡ Yeni Express!" çıkar (panel 30 saniyede bir yenilenir).

Site saatleri 30 saniyede bir yeniden yükler; değişiklikler anında görünür.

## Mesajlar (sohbet)

- Sitede sağ altta **Nachricht** butonu: ziyaretçi giriş yapmadan yazar; cevabın aynı pencerede görünür.
- Admin paneli → **Mesajlar** sekmesi: konuşma listesi (okunmamışlar, çevrimiçi olanlar ve rezervasyon etiketiyle), cevap kutusu, konuşma silme. Panel 10 saniyede bir yenilenir.
- Her konuşmanın üstünde müşteri kartı: rezervasyonu (Bestellnummer, adet, nakit, randevu, rezervasyonu yaptığı saat, durum) ve ziyaret bilgisi (şu an sitede mi, hangi adımda, ilk ziyaret, kaç gün geldi, cihaz, dil, kaynak).
- Ziyaretçi o tarayıcıda otomatik hatırlanır. Başka cihazda devam etmek için anahtar simgesinden `PYC-XXXX-XXXX-XXXX-XXXX` kodunu alıp diğer cihazda girer.
- İsim/e-posta ve Bestellnummer (varsa) konuşmaya otomatik eklenir. Kötüye kullanıma karşı sınır: konuşma başına 10 dakikada 15 mesaj.

## Hatırlama

Hesap yok; her şey tarayıcıda saklanır: Bestellnummer, rezervasyon, isim/e-posta ve sohbet.
Geri dönen ziyaretçi ana sayfada **Deine Reservierung** kartını görür. Başka cihazda rezervasyon için Bestellnummer, sohbet için sohbet kodu yeterli.

## Canlıya alma

### 1. Supabase (randevular + admin)

**Bağlı:** `haydarsahin0's Project` (tdwtqlqnmlqdwhavwaer) içindeki `pyramide_bookings` / `pyramide_admin` tabloları.
Admin şifresini değiştirmek için SQL Editor'de `select public.pyramide_admin_set_password('yeni-sifre');` çalıştır.

Yeni bir projeye taşımak istersen:

1. Supabase → SQL Editor → `supabase/schema.sql` dosyasının içeriğini çalıştır.
2. Admin şifreni belirle (en az 10 karakter), yine SQL Editor'de:
   ```sql
   select public.pyramide_admin_set_password('buraya-uzun-bir-sifre');
   ```
3. Project Settings → API: Project URL'i `assets/js/config.js` → `supabaseUrl` alanına,
   *anon / publishable* anahtarı `supabaseAnonKey` alanına yaz.

Ziyaretçiler tabloyu doğrudan okuyamaz. Sadece hangi saatlerin dolu olduğunu görebilir ve kendi numaraları için randevu alabilir.
Tüm bilgileri yalnızca doğru admin şifresi açar; yanlış denemeler sunucuda yavaşlatılır.

### 2. GitHub Pages

Repo → **Settings → Pages** → *Deploy from a branch* → bu branch ve `/ (root)` → Save.

## Yapı

```
index.html             müşteri sitesi (ürün, kurallar, sipariş no, takvim, onay)
admin.html             admin paneli
assets/css/style.css   tasarım
assets/js/config.js    Supabase, fiyat (priceEur = ilk, priceExtraEur = sonrakiler), adet ve saat ayarları
assets/js/i18n.js      DE + EN metinler
assets/js/app.js       site mantığı
assets/js/admin.js     admin mantığı
assets/js/chat.js      sohbet penceresi
assets/img/            sticker, bayraklar, ikonlar
supabase/schema.sql    rezervasyon tabloları + fonksiyonlar
supabase/chat.sql      sohbet tabloları + fonksiyonlar (schema.sql'den sonra)
supabase/analytics.sql ziyaretçi istatistikleri + admin verileri (chat.sql'den sonra)
supabase/express.sql   Express saatleri + ayarlar (analytics.sql'den sonra)
supabase/hours.sql     Standard haftalık saatler + günlük istisnalar (express.sql'den sonra)
supabase/express_now.sql Express = 1 saat içinde; rezervasyon kontrolü (hours.sql'den sonra)
```

Saatleri veya en fazla adedi değiştirirsen aynı değerleri `supabase/schema.sql` → `pyramide_book` içindeki kontrollerde de güncelle.
