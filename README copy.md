# Clinic Booking API

Zero-dependency Node (18+) API plus a patient web page, served from one app.

- API: `POST /reset`, `GET /slots`, `POST /bookings`, `GET /bookings?email=&page=&limit=`, `GET /bookings/{id}`, `DELETE /bookings/{id}`
- Web page: `GET /` (public; the visitor enters the access key once)
- Every API request needs the `X-API-Key` header.

## Run locally
    API_KEY=your-secret-key npm start      # http://localhost:3000
    npm test                               # exercises levels 1-5, incl. 50 simultaneous bookings

## Deploy (Render, free tier)
1. Push this folder to a GitHub repo.
2. Render > New > Web Service > pick the repo.
3. Build command: (leave empty or `npm install`). Start command: `npm start`.
4. Environment variable: `API_KEY` = your secret key. (`PORT` is set by Render.)
5. Deploy. Your URL is `https://<name>.onrender.com`. Open it for the web page.

Railway / Fly.io work the same way: set `API_KEY`, start command `npm start`.

## Notes
- State is in memory. A restart clears bookings, which fits the `/reset` contract. Run ONE instance only,
  because the no-double-booking guarantee relies on Node's single thread.
- Rate limit: 5 attempts per email per minute (failed attempts count); 6th returns 429 + `Retry-After`.
- Idempotency: same `Idempotency-Key` + same body replays the stored response; different body returns 422.
