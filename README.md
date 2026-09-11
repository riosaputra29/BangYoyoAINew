# Tanya — Chat AI dengan Login Google

Website chat AI: pengguna login pakai akun Google, lalu ngobrol dengan AI (Claude).

**Versi ini mencakup:**
- Halaman login split-panel dengan identitas visual sendiri (bukan template default)
- Balasan AI **streaming** (muncul kata demi kata) lewat Server-Sent Events
- Avatar, timestamp per pesan, dan indikator "sedang mengetik"
- Verifikasi token Google di server sebelum setiap request chat diproses

## Struktur
```
ai-chat-app/
├── public/index.html   # Frontend (login + UI chat)
├── server.js           # Backend (verifikasi login + proxy ke Anthropic API)
├── package.json
└── .env.example
```

## 1. Buat Google OAuth Client ID
1. Buka https://console.cloud.google.com/
2. Buat project baru (atau pilih yang sudah ada).
3. Buka **APIs & Services → OAuth consent screen** → pilih "External" → isi nama app & email → simpan.
4. Buka **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
5. Pilih tipe **Web application**.
6. Di **Authorized JavaScript origins**, tambahkan URL tempat website ini nanti dijalankan, contoh:
   - `http://localhost:3000` (untuk testing lokal)
   - `https://domainkamu.com` (untuk produksi)
7. Klik **Create** → salin **Client ID** yang muncul.

## 2. Buat Anthropic API Key
1. Buka https://console.anthropic.com/ → **API Keys** → **Create Key**.
2. Salin key yang muncul (hanya tampil sekali).

## 3. Setup project
```bash
cd ai-chat-app
npm install
cp .env.example .env
```
Isi file `.env` dengan `GOOGLE_CLIENT_ID` dan `ANTHROPIC_API_KEY` dari langkah 1 & 2.

Buka `public/index.html`, cari baris berikut dan ganti dengan Client ID yang sama:
```js
const GOOGLE_CLIENT_ID = "GANTI_DENGAN_CLIENT_ID_ANDA.apps.googleusercontent.com";
```

## 4. Jalankan
```bash
npm start
```
Buka `http://localhost:3000` di browser.

## Catatan keamanan
- API key Anthropic **tidak pernah** dikirim ke browser — semua panggilan AI lewat `server.js`.
- Token login Google diverifikasi ulang di server (`verifyGoogleToken`) sebelum request chat diproses, supaya orang lain tidak bisa memanggil `/api/chat` tanpa login.
- Untuk produksi: pertimbangkan menyimpan histori chat per-user di database, dan tambahkan rate limiting agar API key tidak disalahgunakan.

## Deploy
Aplikasi ini adalah Node.js biasa, jadi bisa di-deploy ke Render, Railway, Fly.io, atau VPS mana pun. Jangan lupa:
- Tambahkan domain produksi ke **Authorized JavaScript origins** di Google Cloud Console.
- Set environment variables (`GOOGLE_CLIENT_ID`, `ANTHROPIC_API_KEY`) di dashboard hosting, jangan commit file `.env`.
