"""Create runtime assets without modifying the supplied originals. Requires Pillow."""
import io
import json
import struct
from pathlib import Path

from PIL import Image

ASSETS = Path(__file__).resolve().parents[1] / 'public' / 'assets'
source = ASSETS / 'pine_tree (1).glb'
data = source.read_bytes()
json_length = struct.unpack_from('<I', data, 12)[0]
document = json.loads(data[20:20 + json_length])
binary = data[28 + json_length:]
replacements = {}
old_pixels = new_pixels = 0

for index, image in enumerate(document['images']):
    view = document['bufferViews'][image['bufferView']]
    offset = view.get('byteOffset', 0)
    decoded = Image.open(io.BytesIO(binary[offset:offset + view['byteLength']])).convert('RGBA')
    old_pixels += decoded.width * decoded.height
    decoded.thumbnail((512, 512), Image.Resampling.LANCZOS)
    new_pixels += decoded.width * decoded.height
    encoded = io.BytesIO()
    if index == 0:  # Opaque bark albedo; normal/roughness maps stay lossless.
        decoded.convert('RGB').save(encoded, 'JPEG', quality=85, optimize=True)
        image['mimeType'] = 'image/jpeg'
    elif index == 3:  # Foliage albedo retains its alpha cutout.
        decoded.quantize(colors=256, method=Image.Quantize.FASTOCTREE).save(encoded, 'PNG', optimize=True)
    else:
        decoded.convert('RGB').save(encoded, 'PNG', optimize=True)
    replacements[image['bufferView']] = encoded.getvalue()

payload = bytearray()
for index, view in enumerate(document['bufferViews']):
    offset = view.get('byteOffset', 0)
    content = replacements.get(index, binary[offset:offset + view['byteLength']])
    payload.extend(b'\0' * (-len(payload) % 4))
    view['byteOffset'] = len(payload)
    view['byteLength'] = len(content)
    payload.extend(content)
payload.extend(b'\0' * (-len(payload) % 4))
document['buffers'][0]['byteLength'] = len(payload)
document['asset']['generator'] = 'DriftSync forest texture optimization (Pillow)'
header = json.dumps(document, separators=(',', ':')).encode()
header += b' ' * (-len(header) % 4)
output = (struct.pack('<4sII', b'glTF', 2, 28 + len(header) + len(payload))
          + struct.pack('<I4s', len(header), b'JSON') + header
          + struct.pack('<I4s', len(payload), b'BIN\0') + payload)
target = ASSETS / 'pine-tree-optimized.glb'
target.write_bytes(output)

atlas_source = ASSETS / 'pine-tree-atlas.png'
atlas = Image.open(atlas_source).convert('RGBA').resize((1024, 1024), Image.Resampling.LANCZOS)
atlas_target = ASSETS / 'pine-tree-atlas.webp'
atlas.save(atlas_target, 'WEBP', quality=85, method=6)
print(json.dumps({
    'model_bytes': [len(data), len(output)],
    'model_texture_pixels': [old_pixels, new_pixels],
    'atlas_bytes': [atlas_source.stat().st_size, atlas_target.stat().st_size],
    'atlas_dimensions': [atlas.width, atlas.height],
}, indent=2))
