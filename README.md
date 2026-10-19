# 🏎 Tilt Racer

A local-multiplayer **browser car game** where the **laptop is the screen** and
**phones are the controllers**. Up to **4 players** join from their phones, tilt
to steer, and race in a **3D split-screen** view rendered on the laptop.

- 🎮 Phones connect by scanning a QR code — no app install.
- 📱 **Tilt to steer** + on-screen **gas / brake** (touch-steering fallback included).
- 🖥️ Laptop renders real-time **3D** (Three.js) with a 1–4 way split screen.
- 🏁 3-lap races on a closed circuit, with countdown, lap counting, positions and results.

---

## Requirements

- **Node.js 18+** (you have v20 ✓)
- The laptop and all phones on the **same Wi-Fi network**.

## Install & run

```bash
npm install      # already done if you see node_modules/
npm start
```

You'll see something like:

```
  🏎  Tilt Racer is running!

  On this laptop, open:   http://localhost:3000
  Phones join via QR, or: http://192.168.1.41:3000/controller.html
```

## How to play

1. On the **laptop**, open **http://localhost:3000**. A lobby appears with a **QR code** and a 4-letter **code**.
2. On each **phone** (same Wi-Fi), **scan the QR code** with the camera. It opens the controller page.
   - Or manually open the address shown on screen and type the 4-letter code.
3. Tap **Enable tilt steering** (allow motion access if asked), hold the phone level, then tap **Center steering & Ready**.
   - On iPhone, if tilt is blocked, tap **Use touch steering instead** (see note below).
4. When everyone's joined, press **Start race** on the laptop.
5. Hold your phone **sideways** like a wheel. **Tilt** to steer, hold **GAS** / **BRAKE**. First to 3 laps wins!

### Controls
| Action | Phone | Laptop (for testing) |
|---|---|---|
| Steer | Tilt left/right (or slide, in touch mode) | ← → or A / D |
| Accelerate | Hold **GAS** | ↑ or W |
| Brake / reverse | Hold **BRAKE** | ↓ or S |
| Re-center steering | Tap **⟳ Center** | — |

> 💡 You can test solo without a phone: open the game on the laptop, open
> `http://localhost:3000/controller.html` in a **second tab/window**, join with the
> code, and drive with the **arrow keys**.

---

## Troubleshooting

**Phone can't connect / page won't load on the phone**
- Make sure the phone is on the **same Wi-Fi** as the laptop (not mobile data).
- **Windows Firewall**: the first time you run it, allow **Node.js** on Private networks. If you missed the prompt, allow it in *Windows Defender Firewall → Allow an app*.
- If the QR address looks wrong (e.g. a `192.168.56.x` VirtualBox address), use the
  **"Try another address"** dropdown in the lobby to switch the QR to your real Wi-Fi IP.
  You can also force one: `HOST_IP=192.168.1.41 npm start`.

**iPhone: tilt steering doesn't work**
- iOS only allows motion sensors on a **secure (HTTPS)** page. Over plain `http://` on
  the LAN, tilt is blocked by Safari. Easiest fix: tap **"Use touch steering instead"**
  on the controller (slide left/right to steer) — works on every device.
- (Advanced) To get true tilt on iPhone, serve the game over HTTPS (self-signed cert or
  a tunnel like ngrok) and open that URL on the phone.

**Steering feels reversed in tilt mode**
- Tap **⟳ Center** while holding the phone straight. If it's still inverted for your
  device/orientation, use touch steering — or tell me and I'll add an invert toggle.

---

## Tuning & customization

Most knobs live at the top of the relevant file:

- **Laps, speed, grip, braking** → `public/js/host.js` → `TOTAL_LAPS`, `PHYS { ... }`.
- **Track shape & elevation** → `public/js/track.js` → `cp` (each control point is `[x, elevation, z]`), `halfWidth` (road width), `terrainHeight`/`groundBase` (runoff embankment).
- **Car model** → `public/js/carmesh.js` (loads `public/assets/ferrari.glb`; recolors the `Body_Color` material per player).
- **Environment / lighting** → `public/js/host.js` → the `RGBELoader().load('/assets/venice_sunset_1k.hdr', …)` line. Swap to `quarry_01_1k.hdr` (also included) for a brighter daytime look.
- **Player colors / names / max players** → `server.js` (`PLAYER_COLORS`, `MAX_PLAYERS`).
- **Steering sensitivity** → `public/js/controller.js` → `STEER_RANGE_DEG`.

## How it works

The **host (laptop) is authoritative**: it runs all physics and rendering. Phones only
send input and receive tiny feedback events (vibration, place, lap). This keeps latency
low and the netcode simple.

```
Phone (controller.html)  ──input──►  Server (socket.io)  ──relay──►  Laptop (index.html)
        ▲                                                                   │
        └───────────────── feedback (vibrate / place / lap) ◄──────────────┘
```

## Project structure

```
server.js                 Express + Socket.IO: rooms, QR, LAN-IP detection, input relay
public/
  index.html              Host / game screen (laptop)
  controller.html         Phone controller
  css/host.css            Lobby + HUD styling
  css/controller.css      Controller styling
  js/host.js              Scene, physics, split-screen render, lobby, laps, networking
  js/track.js             3D circuit, environment, lap gates (procedural, no assets)
  js/carmesh.js           Stylized low-poly car built from primitives
  js/controller.js        Tilt/touch steering, pedals, keyboard fallback, networking
```

## Assets / credits
The realistic car and lighting come from free assets shipped with three.js:
- **Car**: `ferrari.glb` (Ferrari model from the three.js examples).
- **Environment**: `venice_sunset_1k.hdr` / `quarry_01_1k.hdr` (HDRI sky used for image-based lighting + reflections).

They live in `public/assets/` and are served locally, so the game still works offline.
If the model ever fails to load, the game automatically falls back to a procedural car.

> Performance note: the realistic car is rendered up to 4× per frame (once per
> split-screen viewport). On a weak GPU, fewer players / a smaller window helps.

## Tech
Node.js · Express · Socket.IO · Three.js + glTF (Draco) + HDRI — all served locally.
