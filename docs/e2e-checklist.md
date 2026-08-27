# E2E smoke checklist

1. `make build-server && ./server/bin/bytelnd`
2. `cd web && npm run dev` — open http://localhost:5173
3. Click **New chat**, copy share link, open in a second browser/profile
4. Send messages both ways; confirm ciphertext-only on the wire (DevTools → WS frames are binary)
5. **Export** history; on the other device **Import** and merge
6. Disconnect one peer; confirm reclaim within 30s with the same session
7. Third connection to the same bucket is rejected (bucket full)
8. `curl -s http://localhost:8990/health` → `{"ok":true,...}`
9. Optional: `docker compose up --build` — web on :5173, relay on :8990
