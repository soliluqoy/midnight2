"""Render one selected image, PDF page, or video frame. No model, network or transcript."""
import base64
import io
import json
import sys
from contextlib import closing
from pathlib import Path
from PIL import Image, ImageOps

filename, kind, locator_json = sys.argv[1:4]
locator = json.loads(locator_json)
image = None
if kind == "image":
    with Image.open(filename) as source:
        image = ImageOps.exif_transpose(source).convert("RGB")
elif kind == "document":
    if Path(filename).suffix.lower() != ".pdf":
        raise ValueError("Export visual slides to PDF to inspect them.")
    import pypdfium2 as pdfium
    with pdfium.PdfDocument(filename) as document:
        index = int(locator.get("page", 1)) - 1
        if not 0 <= index < len(document):
            raise ValueError("This PDF page is unavailable.")
        with closing(document[index]) as page:
            width, height = page.get_size()
            bitmap = page.render(scale=min(2.0, 1600 / max(width, height, 1)))
            try:
                with bitmap.to_pil() as rendered:
                    image = rendered.convert("RGB")
            finally:
                bitmap.close()
elif kind == "video":
    import av
    seconds = max(0.0, float(locator.get("seconds", locator.get("startSeconds", 0))))
    with av.open(filename) as container:
        container.seek(int(seconds * av.time_base), backward=True)
        for frame in container.decode(video=0):
            if frame.time is None or float(frame.time) >= seconds:
                with frame.to_image() as rendered:
                    image = rendered.convert("RGB")
                break
else:
    raise ValueError("No visual preview for this source.")
if image is None:
    raise ValueError("No readable frame at this moment.")
try:
    image.thumbnail((1600, 1600))
    result = io.BytesIO()
    image.save(result, format="JPEG", quality=85)
    if result.tell() > 1_400_000:
        image.thumbnail((1000, 1000))
        result = io.BytesIO()
        image.save(result, format="JPEG", quality=70)
    print(json.dumps({"mimeType": "image/jpeg", "data": base64.b64encode(result.getvalue()).decode("ascii")}))
finally:
    image.close()
