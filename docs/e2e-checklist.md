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
10. Send a large image (~1–3 MiB after prepare): sender shows send % overlay / composer %; receiver shows a placeholder with receive % that completes into the image. Both peers must be on this build — older clients drop chunked frames.
11. With two peers holding different message sets: after reconnect, both see “Chat history differs”; Request sync → peer Approves → missing messages merge on both sides and the banner clears. Deny leaves histories unchanged.
12. **Switch device:** on device A open chat menu → Switch device → Release seat. On device B open the same invite + room PIN; Request sync; partner Approves. History appears on B. Device A shows “Seat released” and can Rejoin later (after B leaves or if a seat is free).
13. **Sync trust:** a sync request from a new/unknown device shows a warning and requires typing SYNC to Approve. Deny / Wipe my copy / Wipe both are available if the wrong person got the link.
