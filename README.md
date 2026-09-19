# Kuramanime Sidecar

Layanan browser mandiri untuk **satu** tugas: mengambil daftar `<source>` dari
halaman episode Kuramanime.

## Kenapa perlu dipisah

Kuramanime membangun player-nya sepenuhnya di browser — POST episode-nya butuh
nilai `authorization` yang dihasilkan bundle token ter-obfuscate, jadi daftar
`<source>` tidak bisa direproduksi dengan HTTP biasa.

Chromium **tidak bisa** dijalankan di Vercel (batas bundle 250 MB, filesystem
read-only, tanpa shared library). Jadi browser-nya jalan di sini, dan gateway
Next.js hanya memanggil hasilnya lewat HTTP.

> Catatan: layanan ini sudah diuji bisa membuka Kuramanime (HTTP 200). Ini **bukan**
> solusi untuk samehadaku — situs itu diblokir Cloudflare dengan aturan
> fingerprint TLS yang tidak bisa dilewati Chromium maupun Node.

---

## Endpoint

| Endpoint | Auth | Fungsi |
|---|---|---|
| `GET /health` | tidak | Cek hidup. Dipakai healthcheck Railway. |
| `GET /resolve?url=<episode-url>` | **ya** | Buka halaman episode, tunggu player terisi, balas daftar sumber. |

Auth lewat header `Authorization: Bearer <SIDECAR_TOKEN>` (atau `x-sidecar-token`).
Hanya host di `ALLOWED_HOSTS` yang boleh diresolusi.

Balasan `/resolve`:

```json
{
  "ok": true,
  "title": "Judul Episode",
  "hlsSrc": "https://...m3u8",
  "servers": ["..."],
  "sources": [{ "quality": "720p", "url": "https://..." }]
}
```

---

## Jalankan lokal

**Docker** (paling mirip Railway):

```bash
docker build -t kuramanime-sidecar .
docker run --rm -p 8080:8080 -e SIDECAR_TOKEN=dev kuramanime-sidecar
```

**Tanpa Docker** (butuh Node 20+):

```bash
npm install
npx playwright install --with-deps chromium

# Windows (PowerShell)
$env:SIDECAR_TOKEN='dev'; $env:SIDECAR_HOST='127.0.0.1'; $env:PORT='8080'; npm start

# macOS / Linux
SIDECAR_TOKEN=dev SIDECAR_HOST=127.0.0.1 PORT=8080 npm start
```

Uji:

```bash
curl -s localhost:8080/health
curl -s -H "Authorization: Bearer dev" \
  "localhost:8080/resolve?url=https%3A%2F%2Fv9.kuramanime.blog%2Fanime%2F<id>%2F<slug>%2Fepisode%2F1"
```

---

## Deploy ke Railway

1. [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**
   (taruh folder ini di repo-nya sendiri, jadi **Root Directory** biarkan kosong).
2. Pastikan builder terdeteksi **Dockerfile**
   (`railway.json` sudah mengatur build + healthcheck `/health`).
3. **Variables** → tambahkan:
   - `SIDECAR_TOKEN` = hasil `openssl rand -hex 32` — **wajib**
   - `ALLOWED_HOSTS` = `kuramanime.run,kuramanime.xyz,kuramanime.blog` — opsional
   - Jangan set `PORT`; Railway menyuntiknya sendiri.
4. **Settings → Networking → Generate Domain** → dapat
   `https://<nama>.up.railway.app`.
5. Uji: `curl -s https://<domain>/health` → `{"ok":true,...}`

Spek: **1 vCPU / 1 GB RAM**, region **Singapore**. Perkiraan ~$5/bulan.

---

## Menyambungkan ke aplikasi

### 1. Environment di Vercel

```
KURAMANIME_PLAYWRIGHT_URL=https://<domain-railway>
SIDECAR_TOKEN=<token yang sama>
```

`kuramanimeSidecarUrl()` di `src/lib/kuramanime.ts` sudah membaca
`KURAMANIME_PLAYWRIGHT_URL`, jadi alamatnya langsung terpakai.

### 2. Kirim token dari klien

`src/lib/kuramanime.ts` (sekitar baris 140) sekarang **tidak** mengirim header
auth, jadi akan kena 401. Tambahkan satu baris:

```ts
const res = await fetch(`${base}/resolve?url=${encodeURIComponent(episodeUrl)}`, {
  headers: {
    Accept: "application/json",
    Authorization: `Bearer ${process.env.SIDECAR_TOKEN ?? ""}`, // ← tambahkan ini
  },
  signal: AbortSignal.any([signal, budget]),
  cache: "no-store",
});
```

### 3. Aktifkan kembali provider-nya

- `src/lib/provider-registry.ts` — kuramanime sekarang `disabled("indonesian")`;
  ubah jadi `enabled: true` dengan `timeoutMs` sekitar 28–30 detik (handshake
  browser memang lambat).
- `src/types/episode.ts` — tambahkan `"kuramanime"` ke `PROVIDER_ORDER.indonesian`
  di posisi yang diinginkan.
- Aplikasi Flutter: tambahkan `kuramanime` ke `ProviderCatalog.indonesian` juga,
  supaya nomor servernya sama.

---

## Keamanan

- **Token wajib.** Tanpa `SIDECAR_TOKEN`, server tidak mau start. Kalau dibiarkan
  terbuka, siapa pun bisa memakai Chromium kamu untuk apa saja.
- **Allowlist host.** `/resolve` menolak host di luar `ALLOWED_HOSTS`.
- **Rotasi token**: ganti di Railway **dan** Vercel, lalu redeploy keduanya.
- Jangan commit `.env` — hanya `.env.example`.

---

## Troubleshooting

| Gejala | Solusi |
|---|---|
| `unauthorized` | Header `Authorization` tidak dikirim / token beda. |
| `host_not_allowed` | Host episode tidak ada di `ALLOWED_HOSTS`. |
| `TimeoutError` di `/resolve` | Player tidak terisi dalam `PLAYER_TIMEOUT_MS`. Naikkan, dan cek log Railway — Kuramanime kadang mengubah alur token-nya. |
| Build gagal: image tidak ditemukan | Tag Docker harus sama dengan versi `playwright` di `package.json` (`vX.Y.Z-jammy`). |
| Container restart terus | Biasanya kehabisan RAM. Naikkan ke 1 GB. |
| Healthcheck gagal | Server harus listen di `0.0.0.0` + `process.env.PORT`. Jangan set `PORT` manual. |
| Resolve pertama lambat (5–10 s) | Launch Chromium + navigasi. Setelah browser hidup, request berikutnya lebih cepat. |

---

## Biaya

Satu service Railway always-on: sekitar **$5/bulan**. Biaya didominasi RAM idle,
bukan bandwidth.
