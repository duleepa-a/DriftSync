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
2. Choose the driving mode in the host lobby, then press **Start race**. **Auto acceleration** is on by default. Turn it off for manual acceleration for everyone in the room. The mode is locked during the race and can be changed again after **Race again** returns you to the lobby.
3. Steer with **LEFT** and **RIGHT**. Hold **BRAKE** to slow down; hold it from a stop to reverse. In auto mode the car accelerates when the brake is released. Manual mode puts two small steering arrows at the bottom left and brake/accelerator pedals at the bottom right: hold **ACCEL** to drive, release to coast. Brake takes priority when both pedals are held. Nitro adds acceleration only while holding the accelerator in manual mode.
4. Complete three laps. The first car to finish wins, and everyone else keeps racing until they finish. Each finisher's panel shows their place, race time, best lap, and top speed while they wait. The shared results page appears once all remaining racers finish. Finished cars no longer collide with racers; disconnected racers do not hold the race open, and already-recorded finishes remain in the results.

Collect the glowing **N₂O bottles** on the main and back straights for an automatic two-second nitrous boost. Each station has three bottles across the road; a collected bottle returns after eight seconds. Braking cancels the boost. Nitrous raises the speed limit from 46 to 64 m/s (about 103 to 143 mph), then eases back to normal speed. Normal acceleration is 26 m/s².

Active nitrous produces blue exhaust flames, a gentle camera pullback, and blur near the edges of your view. Red rear lights brighten when braking, and white reverse lights turn on when moving backward. The speed effects are separate for each player; turning postprocessing off with **B** also disables the blur.

On a laptop controller tab, use **Left/Right** or **A/D** to steer and **Down**, **S**, or **Space** to brake. In manual mode, hold **Up** or **W** to accelerate. Audio is temporarily disabled. Press **B** on the host screen to toggle postprocessing.

If a phone cannot connect, check that it is on the same Wi-Fi network and that the laptop firewall allows Node.js on private networks. If the host disconnects, the old room closes; the host creates a new code on reconnect and controllers must join that new room.

## Architecture

```text
Phone controllers  -- inputs -->  Socket.IO server  -- inputs -->  Host browser
Phone controllers  <-- status --  Socket.IO server  <-- status --  Host browser
                                                          |
                                                simulation + Three.js rendering
```

The host browser owns the simulation, lap counts, positions, and rendering. The server owns room membership, player slots, driving mode, and event routing. Only the host can change the room mode before a race; existing, late-joining, and reconnecting controllers receive the current setting. Controllers send bounded steering, brake, and throttle values about 25 times per second. The host simulates at a fixed 60 Hz step and renders one viewport per player. This design is intended for a trusted local game; the simulation is not independent of the host browser.

Key files:

| File                         | Responsibility                                                               |
| ---------------------------- | ---------------------------------------------------------------------------- |
| `server.js`                  | Express assets, rooms, roles, and Socket.IO routing                          |
| `public/js/host.js`          | Host scene, cameras, UI, race lifecycle, and rendering loop                  |
| `public/js/physics.js`       | Car movement and wall handling                                               |
| `public/js/nitro.js`         | Nitrous tuning, straight-section placement, collection, and respawn          |
| `public/js/nitro-visuals.js` | Glowing bottle and road-ring visuals                                         |
| `public/js/race.js`          | Lap gate progress and rankings                                               |
| `public/js/track.js`         | Track geometry, scenery, and gate locations                                  |
| `public/js/scenery.js`       | Instanced pine forest, crowd billboards, grandstand LOD, and mountain ridges |
| `public/js/road-material.js` | Asphalt albedo, normal, and racing-line roughness maps                       |
| `public/js/carmesh.js`       | Car asset loading, cloning, and disposal                                     |
| `public/js/audio.js`         | Engine and effect audio                                                      |
| `public/js/controller.js`    | Phone controls and feedback                                                  |
