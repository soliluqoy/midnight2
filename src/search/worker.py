"""Local EmbeddingGemma 2 worker. JSON lines on stdout; library logs on stderr.

Only --prepare downloads the model. Every ordinary model load uses its saved
snapshot path and local_files_only, with Hugging Face's offline flags set by Node.
"""
import argparse
import contextlib
import importlib.metadata
import json
import os
from pathlib import Path
import sys
import threading

MODEL = "google/embeddinggemma-2"
PROTOCOL_OUT = sys.stdout
PROTOCOL_LOCK = threading.Lock()


def emit(message):
    with PROTOCOL_LOCK:
        PROTOCOL_OUT.write(json.dumps(message, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n")
        PROTOCOL_OUT.flush()


def progress(phase, message, **fields):
    emit({"event": "progress", "phase": phase, "message": message, **fields})


def download_progress_class():
    from huggingface_hub.utils import tqdm

    class DownloadProgress(tqdm):
        def __init__(self, *args, **kwargs):
            # Report bytes written into the model cache, without competing file/transfer bars.
            self.report_bytes = kwargs.get("unit") == "B" and not kwargs.get("name", "").endswith(".transfer")
            kwargs["mininterval"] = 0.5
            super().__init__(*args, **kwargs)

        def display(self, *args, **kwargs):
            if self.report_bytes and self.total:
                progress("downloading", "Downloading EmbeddingGemma 2", bytesDone=int(self.n), bytesTotal=int(self.total))

    return DownloadProgress


class Worker:
    def __init__(self, args, prepare=False):
        progress("checking", "Checking local model libraries")
        import torch
        # The shared multimodal processor requires torchvision even for text inputs.
        import torchvision
        from sentence_transformers import SentenceTransformer

        # Leave capacity for the desktop and chat while background indexing runs.
        torch.set_num_threads(min(4, max(1, (os.cpu_count() or 2) // 2)))
        self.args = args
        self.root = Path(args.runtime_dir).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.manifest_path = self.root / "prepared.json"
        saved = None
        if self.manifest_path.exists():
            saved = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        if prepare:
            from huggingface_hub import snapshot_download

            progress("downloading", "Downloading the complete text, vision and audio model")
            model_path = Path(snapshot_download(MODEL, revision=saved.get("revision") if saved else None,
                                               cache_dir=str(self.root / "cache" / "hub"),
                                               tqdm_class=download_progress_class()))
        else:
            if not saved or saved.get("model") != MODEL:
                raise RuntimeError("Local model is not prepared. Run Set up local search in Settings.")
            model_path = Path(saved["snapshot"])
            expected = (self.root / "cache" / "hub").resolve()
            if not model_path.resolve().is_relative_to(expected):
                raise RuntimeError("Model snapshot is outside the private search cache. Run setup again.")
            if not model_path.is_dir():
                raise RuntimeError("Local model files are missing. Run Set up local search again.")
        if args.device == "cuda" and not torch.cuda.is_available():
            raise RuntimeError("CUDA was selected but is unavailable. Select CPU or install a compatible PyTorch build.")
        if args.device == "mps" and not torch.backends.mps.is_available():
            raise RuntimeError("MPS was selected but is unavailable. Select CPU.")
        progress("loading", "Loading EmbeddingGemma 2 locally")
        # Float32 avoids the model's documented float16 activation overflow.
        self.model = SentenceTransformer(str(model_path), device=args.device,
                                         model_kwargs={"torch_dtype": torch.float32},
                                         local_files_only=True, trust_remote_code=False)
        self.model.max_seq_length = 2048
        self.info = {"model": MODEL, "revision": model_path.name, "dimensions": args.dimensions,
                     "device": args.device, "dtype": "float32", "modalities": ["text", "image", "pdf", "audio", "video"]}
        progress("verifying", "Checking text search")
        self.encode(["task: search result | query: warm up"])
        if prepare:
            # Verify every encoder before reporting that the full model is ready.
            import numpy as np
            from PIL import Image

            progress("verifying", "Checking image and PDF search")
            with Image.new("RGB", (64, 64), "white") as image:
                self.encode([{"image": image}])
            progress("verifying", "Checking audio and video search")
            samples = (0.1 * np.sin(2 * np.pi * 440 * np.arange(16000) / 16000)).astype(np.float32)
            self.encode([{"audio": {"array": samples, "sampling_rate": 16000}}])
            packages = {name: importlib.metadata.version(name) for name in
                        ("sentence-transformers", "transformers", "torch", "torchvision", "av", "pypdfium2", "Pillow", "soundfile", "librosa", "numpy")}
            prepared = {**self.info, "snapshot": str(model_path.resolve()), "packages": packages}
            temporary = self.manifest_path.with_suffix(".tmp")
            temporary.write_text(json.dumps(prepared, indent=2), encoding="utf-8")
            os.replace(temporary, self.manifest_path)
            progress("available", "Full local model is ready")

    def encode(self, inputs):
        import numpy as np

        # Empty prompt suppresses defaults: callers frame text explicitly; media has no task prefix.
        vectors = self.model.encode(inputs, prompt="", batch_size=2, show_progress_bar=False,
                                    convert_to_numpy=True, normalize_embeddings=True,
                                    truncate_dim=self.args.dimensions)
        vectors = np.asarray(vectors, dtype=np.float32).reshape(len(inputs), self.args.dimensions)
        # Re-normalize after Matryoshka truncation, even if the library already did so.
        norms = np.linalg.norm(vectors, axis=1, keepdims=True)
        if not np.isfinite(vectors).all() or not np.isfinite(norms).all() or (norms <= 0).any():
            raise RuntimeError("The local model returned an invalid embedding.")
        return (vectors / norms).tolist()

    def media(self, filename, kind, maximum):
        from PIL import Image, ImageOps

        file_path = Path(filename)
        if not file_path.is_file():
            raise RuntimeError("The selected media file is missing.")
        segments = []
        truncated = False

        def image_segment(image, locator, text=""):
            rgb = ImageOps.exif_transpose(image).convert("RGB")
            rgb.thumbnail((1600, 1600))
            try:
                vector = self.encode([{"image": rgb}])[0]
                segments.append({"vector": vector, "text": text[:6000], "locator": {**locator, "modality": "image"}})
                progress("embedding", "Reading media", segments=len(segments), locator=locator)
            finally:
                rgb.close()

        if kind == "image":
            with Image.open(file_path) as image:
                image_segment(image, {})
        elif kind == "pdf":
            import pypdfium2 as pdfium

            with pdfium.PdfDocument(str(file_path)) as document:
                truncated = len(document) > maximum
                for index in range(min(len(document), maximum)):
                    with document[index] as page:
                        with page.get_textpage() as textpage:
                            text = textpage.get_text_range()
                        width, height = page.get_size()
                        scale = min(2.0, 1600.0 / max(width, height, 1.0))
                        bitmap = page.render(scale=scale)
                        try:
                            image = bitmap.to_pil()
                            try:
                                image_segment(image, {"page": index + 1}, text)
                            finally:
                                image.close()
                        finally:
                            bitmap.close()
        elif kind == "audio":
            truncated = self.audio_segments(file_path, maximum, segments)
        elif kind == "video":
            import av

            # Reserve soundtrack capacity so frame-heavy clips never hide all their spoken content.
            with av.open(str(file_path)) as container:
                has_audio = bool(container.streams.audio)
                visual_limit = max(1, maximum // 2) if has_audio and maximum > 1 else maximum
                if not container.streams.video:
                    raise RuntimeError("This file has no readable video track.")
                next_time = 0.0
                for frame in container.decode(video=0):
                    seconds = float(frame.time) if frame.time is not None else next_time
                    if seconds + 0.001 < next_time:
                        continue
                    if len(segments) >= visual_limit:
                        truncated = True
                        break
                    image = frame.to_image()
                    try:
                        image_segment(image, {"seconds": max(0.0, seconds), "endSeconds": max(0.0, seconds) + 5.0})
                    finally:
                        image.close()
                    next_time = seconds + 5.0
            if has_audio:
                remaining = maximum - len(segments)
                if remaining:
                    truncated = self.audio_segments(file_path, remaining, segments) or truncated
                else:
                    truncated = True
        else:
            raise RuntimeError("Visual slide rendering is unavailable. Export slides to PDF.")
        return {"segments": segments, "truncated": truncated}

    def audio_segments(self, file_path, maximum, segments):
        import av
        import numpy as np

        rate, window, hop = 16000, 30 * 16000, 25 * 16000
        buffer = np.empty(0, dtype=np.float32)
        offset, produced, had_window = 0, 0, False

        def add(samples, start):
            nonlocal produced
            if samples.size < rate or float(np.sqrt(np.mean(samples * samples))) <= 0.003:
                return
            vector = self.encode([{"audio": {"array": samples, "sampling_rate": rate}}])[0]
            locator = {"seconds": start / rate, "endSeconds": (start + samples.size) / rate, "modality": "audio"}
            segments.append({"vector": vector, "text": "", "locator": locator})
            produced += 1
            progress("embedding", "Listening to media", segments=len(segments), locator=locator)

        with av.open(str(file_path)) as container:
            if not container.streams.audio:
                raise RuntimeError("This file has no readable audio track.")
            resampler = av.AudioResampler(format="fltp", layout="mono", rate=rate)

            def consume(frame):
                nonlocal buffer, offset, had_window
                buffer = np.concatenate((buffer, frame.to_ndarray().reshape(-1).astype(np.float32)))
                while buffer.size >= window:
                    if produced >= maximum:
                        return True
                    add(buffer[:window], offset)
                    had_window = True
                    buffer = buffer[hop:]
                    offset += hop
                return False

            for frame in container.decode(audio=0):
                for resampled in resampler.resample(frame):
                    if consume(resampled):
                        return True
            for resampled in resampler.resample(None):
                if consume(resampled):
                    return True
            covered = window - hop if had_window else 0
            if buffer.size - covered >= rate:
                if produced >= maximum:
                    return True
                add(buffer, offset)
        return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime-dir", required=True)
    parser.add_argument("--dimensions", type=int, choices=(128, 256, 512, 768), default=768)
    parser.add_argument("--device", choices=("cpu", "cuda", "mps"), default="cpu")
    parser.add_argument("--prepare", action="store_true")
    args = parser.parse_args()
    try:
        with contextlib.redirect_stdout(sys.stderr):
            worker = Worker(args, prepare=args.prepare)
        if args.prepare:
            return 0
        emit({"ready": True, "info": worker.info})
    except Exception as error:
        emit({"ready": False, "error": {"code": "SEARCH_SETUP_REQUIRED", "message": f"{type(error).__name__}: {error}"[:1200]}})
        return 1
    for line in sys.stdin:
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            with contextlib.redirect_stdout(sys.stderr):
                if request["op"] == "text":
                    result = []
                    for start in range(0, len(request["texts"]), 2):
                        result.extend(worker.encode(request["texts"][start:start + 2]))
                        progress("embedding", "Reading document passages", segments=len(result))
                elif request["op"] == "media":
                    result = worker.media(request["filePath"], request["kind"], min(500, max(1, int(request.get("maxSegments", 120)))))
                else:
                    raise RuntimeError("Unsupported worker operation.")
            emit({"id": request_id, "ok": True, "result": result})
        except Exception as error:
            emit({"id": request_id, "ok": False, "error": {"code": "SEARCH_MEDIA_ERROR", "message": f"{type(error).__name__}: {error}"[:1200]}})
    return 0


if __name__ == "__main__":
    sys.exit(main())
