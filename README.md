# Burnout

A local multiplayer browser racing game. One laptop runs the race and renders a Three.js view for each player. Up to four phones join over the same Wi-Fi network and act as controllers. The car accelerates automatically; players steer with left and right buttons and hold brake to slow down or reverse.

## Requirements

- Node.js 18 or newer
- A laptop and phones on the same Wi-Fi network
- A browser with WebGL support on the laptop

## Run

```sh
npm install
npm start
```

Open `http://localhost:3000` on the laptop. Scan the QR code from each phone, or open the displayed controller URL and enter the four-character room code. The controller also works in a second laptop browser tab for testing.

The server listens on port 3000 by default. Set `PORT` to change it. If the QR code shows an unreachable network address, choose another address in the lobby or set `HOST_IP` to the laptop's Wi-Fi address.

## Play

1. Join with one to four controllers.
2. Press **Start race** on the laptop.
3. Steer with **LEFT** and **RIGHT**. Hold **BRAKE** to slow down; hold it from a stop to reverse. The car accelerates when the brake is released.
4. Complete three laps. The first car to finish wins.

Collect the glowing **N₂O bottles** on the main and back straights for an automatic two-second nitrous boost. Each station has three bottles across the road; a collected bottle returns after eight seconds. Braking cancels the boost. Nitrous raises the speed limit from 46 to 64 m/s (about 103 to 143 mph), then eases back to normal speed. Normal acceleration is 26 m/s².

Active nitrous produces blue exhaust flames, a gentle camera pullback, and blur near the edges of your view. Red rear lights brighten when braking, and white reverse lights turn on when moving backward. The speed effects are separate for each player; turning postprocessing off with **B** also disables the blur.

On a laptop controller tab, use **Left/Right** or **A/D** to steer and **Down**, **S**, or **Space** to brake. Audio is temporarily disabled. Press **B** on the host screen to toggle postprocessing.

If a phone cannot connect, check that it is on the same Wi-Fi network and that the laptop firewall allows Node.js on private networks. If the host disconnects, the old room closes; the host creates a new code on reconnect and controllers must join that new room.

## Architecture

```text
Phone controllers  -- inputs -->  Socket.IO server  -- inputs -->  Host browser
Phone controllers  <-- status --  Socket.IO server  <-- status --  Host browser
                                                          |
                                                simulation + Three.js rendering
```

The host browser owns the simulation, lap counts, positions, and rendering. The server owns room membership, player slots, and event routing. Controllers send bounded steering and brake values about 25 times per second. The host simulates at a fixed 60 Hz step and renders one viewport per player. This design is intended for a trusted local game; the simulation is not independent of the host browser.

Key files:

| File | Responsibility |
| --- | --- |
| `server.js` | Express assets, rooms, roles, and Socket.IO routing |
| `public/js/host.js` | Host scene, cameras, UI, race lifecycle, and rendering loop |
| `public/js/physics.js` | Car movement and wall handling |
| `public/js/nitro.js` | Nitrous tuning, straight-section placement, collection, and respawn |
| `public/js/nitro-visuals.js` | Glowing bottle and road-ring visuals |
| `public/js/race.js` | Lap gate progress and rankings |
| `public/js/track.js` | Track geometry, scenery, and gate locations |
| `public/js/scenery.js` | Instanced pine forest, crowd billboards, grandstand LOD, and mountain ridges |
| `public/js/road-material.js` | Asphalt albedo, normal, and racing-line roughness maps |
| `public/js/carmesh.js` | Car asset loading, cloning, and disposal |
| `public/js/audio.js` | Engine and effect audio |
| `public/js/controller.js` | Phone controls and feedback |

The car model and HDR environments are served from `public/assets`. The car falls back to a procedural model if its glTF file fails to load. Postprocessing runs separately for each player using shared viewport-sized buffers, keeping bloom and nitro blur inside that player's view. Actual frame rate depends on the laptop GPU and display resolution; **B** disables postprocessing on slower devices.

Sunset lighting uses `venice_sunset_1k.hdr`, loaded with `RGBELoader` and filtered with PMREM for `scene.environment`. A matching procedural sunset sky keeps the HDRI's photographed buildings out of the backdrop. A warm directional sun matches the HDRI's 3.3° elevation beyond the treeline. Its faint `DirectionalLightHelper` appears in the lobby overview; adjust `sun.position` and `sun.target` in `buildTrack` to reposition it. Procedural environment lighting remains available if the HDRI cannot load.

## Development

The renderer uses ACES filmic tone mapping with exposure **1.3** and sRGB output. The HDR pipeline in `public/js/host.js` is `RenderPass -> UnrealBloomPass -> colour grade / nitro blur -> OutputPass`. Bloom uses strength **0.38**, radius **0.45**, and a linear HDR threshold of **1.25**, followed by gentle contrast, saturation, and a per-view vignette. Only the final OutputPass applies tone mapping and colour-space conversion. HDR red brake lamps and emissive grandstand lettering produce halos; ordinary white markings remain below the bloom threshold. Sunset highlights come from the existing HDR environment reflections.

One composer is reused for all cameras, including the lobby. Its buffers resize with the window, pixel ratio (capped at 2), and player layout; the final output uses each player's canvas viewport and scissor. Bloom is available in all four player layouts, with no blur sampling across viewport boundaries.

The road uses `MeshStandardMaterial` with locally generated, seamless PBR textures. Albedo uses sRGB; normal and roughness maps use linear data. Albedo/normal detail tiles every 2 m, while roughness spans the road width once: approximately 0.78 at the centre, gradually rising to 0.94 at the shoulders. The road's environment intensity is 0.8 to balance visible surface detail with subtle sunset reflections on dry asphalt. Adjust these values and `normalScale` in `public/js/road-material.js` to tune the surface.

Track scenery is generated locally in `public/js/scenery.js`. Four rows of pines follow each side of the circuit; trunks and foliage are merged into a single vertex-coloured `InstancedMesh`, with no forest shadow pass. Placement checks the complete road and reserves space around the grandstands. Two continuous mountain ridges add a hazy, layered horizon behind the forest while retaining the sunset clouds.

The four grandstands use a generated transparent 4-by-2 spectator atlas. Instanced crowd planes face the current render camera in the vertex shader, so each split-screen view gets the correct orientation without a JavaScript update per spectator. Alpha testing and depth writes prevent transparent row-sorting artifacts. Each stand switches from 288 individual billboards to 12 crowd patches at 180 m, then hides the crowd at 420 m; distant structures also omit rail details. Three.js updates this LOD separately for each camera. Adjust the placement fractions, row spacing, and LOD distances in the scenery module. These draw-call savings are structural; actual frame rate still depends on hardware.

Run `npm test` for the multiplayer routing, driving, and lap gate tests. Change driving parameters in `public/js/physics.js`, lap settings in `public/js/race.js`, and track shape in `public/js/track.js`.

Run `npm run test:render` for a headless Chrome check of every player viewport, including toggling effects and resizing. Use `npm run test:render -- --dpr=2` to check high-density displays. The check uses the usual Windows Chrome path; set `CHROME_PATH` for another Chrome installation. It runs an isolated local test server and does not join a live game.

The included Ferrari model and HDR environments come from the Three.js example assets.
