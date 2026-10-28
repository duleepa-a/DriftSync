# Tilt Racer

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

On a laptop controller tab, use **Left/Right** or **A/D** to steer and **Down**, **S**, or **Space** to brake. Press **M** on the host screen to mute audio or **B** to toggle postprocessing.

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
| `public/js/race.js` | Lap gate progress and rankings |
| `public/js/track.js` | Track geometry, scenery, and gate locations |
| `public/js/carmesh.js` | Car asset loading, cloning, and disposal |
| `public/js/audio.js` | Engine and effect audio |
| `public/js/controller.js` | Phone controls and feedback |

The car model and HDR environments are served from `public/assets`. The car falls back to a procedural model if its glTF file fails to load. For three or four players, bloom is disabled to reduce the cost of rendering several views. Actual frame rate depends on the laptop GPU and display resolution.

## Development

Run `npm test` for the multiplayer routing, driving, and lap gate tests. Change driving parameters in `public/js/physics.js`, lap settings in `public/js/race.js`, and track shape in `public/js/track.js`.

The included Ferrari model and HDR environments come from the Three.js example assets.
